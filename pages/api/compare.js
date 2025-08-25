// pages/api/compare.js

// Keep Node runtime and disable default body parser
export const config = { api: { bodyParser: false, sizeLimit: "25mb" } };

import formidable from "formidable";
import fs from "fs/promises";
import { OpenAI } from "openai";
import { authAdmin } from "@/lib/firebase/firebaseAdmin";
import { checkAndConsumeQuota } from "@/lib/billing/quota";

// Allowed file types / sizes
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function rid() {
  // simple correlation id for logs
  return `cmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function log(rid, ...args) {
  console.log(`[COMPARE ${rid}]`, ...args);
}

const openaiKey = process.env.OPENAI_API_KEY;
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null;

function parseMultipart(req, r) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFileSize: MAX_FILE_BYTES,
      filter: ({ mimetype }) => ACCEPTED.has(mimetype || ""),
    });
    form.parse(req, (err, fields, files) => {
      if (err) {
        log(r, "formidable error:", err?.message || err);
        return reject(err);
      }
      return resolve({ fields, files });
    });
  });
}

export default async function handler(req, res) {
  const r = rid();
  log(r, "incoming", { method: req.method });

  if (req.method !== "POST") {
    log(r, "405 BAD_METHOD");
    return res.status(405).json({ error: "Method Not Allowed", error_code: "BAD_METHOD", rid: r });
  }

  if (!openaiKey) {
    log(r, "500 CONFIG: OPENAI_API_KEY missing");
    return res.status(500).json({
      error: "Server configuration error: OPENAI_API_KEY is missing.",
      error_code: "CONFIG",
      rid: r,
    });
  }

  // 1) Firebase auth
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) {
    log(r, "401 NO_AUTH");
    return res.status(401).json({ error: "Unauthorized. Token missing.", error_code: "NO_AUTH", rid: r });
  }

  let decoded;
  try {
    decoded = await authAdmin.verifyIdToken(idToken, true);
    log(r, "auth ok", { uid: decoded.uid });
  } catch (e) {
    log(r, "401 BAD_TOKEN:", e?.message || e);
    return res.status(401).json({ error: "Invalid or expired token.", error_code: "BAD_TOKEN", rid: r });
  }

  // 2) Quota (Stripe-first)
  try {
    const q = await checkAndConsumeQuota({ uid: decoded.uid });
    log(r, "quota ok", q);
  } catch (err) {
    const code = err?.code || "";
    const msg = err?.message || "Access denied.";
    log(r, "quota fail", { code, msg });
    if (code === "NO_PLAN") {
      return res.status(403).json({ error: msg, error_code: "NO_PLAN", rid: r });
    }
    if (code === "LIMIT_EXCEEDED") {
      return res.status(429).json({ error: msg, error_code: "LIMIT_EXCEEDED", rid: r });
    }
    return res.status(403).json({ error: msg, error_code: "FORBIDDEN", rid: r });
  }

  // 3) Parse images
  let files;
  try {
    ({ files } = await parseMultipart(req, r));
  } catch (e) {
    const m = String(e?.message || e);
    const code = /maxFileSize/i.test(m) ? "BAD_IMAGE" : "BAD_MULTIPART";
    log(r, "400 parse fail", { code, m });
    return res.status(400).json({
      error: /maxFileSize/i.test(m) ? "Image too large. Max 10MB per file." : "Invalid upload. Only JPG, PNG and WEBP are supported.",
      error_code: code,
      rid: r,
    });
  }

  const image1 = Array.isArray(files.image1) ? files.image1[0] : files.image1;
  const image2 = Array.isArray(files.image2) ? files.image2[0] : files.image2;

  if (!image1 || !image2) {
    log(r, "400 MISSING_IMAGES");
    return res.status(400).json({ error: "Both images are required.", error_code: "MISSING_IMAGES", rid: r });
  }
  if (!ACCEPTED.has(image1.mimetype) || !ACCEPTED.has(image2.mimetype)) {
    log(r, "400 BAD_IMAGE", { m1: image1.mimetype, m2: image2.mimetype });
    return res.status(400).json({ error: "Only JPG, PNG, and WEBP formats are supported.", error_code: "BAD_IMAGE", rid: r });
  }

  log(r, "files ok", { i1: image1.originalFilename, i2: image2.originalFilename });

  // 4) Read files
  let b64_1, b64_2;
  try {
    const [b1, b2] = await Promise.all([
      fs.readFile(image1.filepath, { encoding: "base64" }),
      fs.readFile(image2.filepath, { encoding: "base64" }),
    ]);
    b64_1 = b1; b64_2 = b2;
    log(r, "files read ok");
  } catch (e) {
    log(r, "500 FILE_READ_ERROR:", e?.message || e);
    return res.status(500).json({ error: "Failed to read uploaded images.", error_code: "FILE_READ_ERROR", rid: r });
  }

  // 5) OpenAI
  try {
    log(r, "openai call -> gpt-4o");
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Compare these two UI screenshots and generate a markdown-based QA report.\n" +
                "Focus on layout shifts, missing or misaligned elements, spacing, font, color, and visual consistency issues.\n" +
                "Organize output with bullet points under clear headings.",
            },
            { type: "image_url", image_url: { url: `data:${image1.mimetype};base64,${b64_1}` } },
            { type: "image_url", image_url: { url: `data:${image2.mimetype};base64,${b64_2}` } },
          ],
        },
      ],
    });

    const result = completion?.choices?.[0]?.message?.content;
    if (!result) {
      log(r, "502 OPENAI_EMPTY");
      return res.status(502).json({ error: "OpenAI did not return a result.", error_code: "OPENAI_EMPTY", rid: r });
    }

    log(r, "success");
    return res.status(200).json({ result, rid: r });
  } catch (e) {
    const msg =
      e?.response?.data?.error?.message ||
      e?.error?.message ||
      e?.message ||
      "OpenAI request failed.";
    log(r, "502 OPENAI_ERROR:", msg);
    return res.status(502).json({ error: `OpenAI error: ${msg}`, error_code: "OPENAI_ERROR", rid: r });
  }
}






























// // // pages/api/compare.js

// // import formidable from 'formidable';
// // import fs from 'fs';
// // import { OpenAI } from 'openai';
// // import admin from 'firebase-admin';

// // export const config = {
// //   api: {
// //     bodyParser: false,
// //   },
// // };

// // // --- Firebase Admin Init ---
// // if (!admin.apps.length) {
// //   try {
// //     admin.initializeApp({
// //       credential: admin.credential.cert({
// //         projectId: process.env.FIREBASE_PROJECT_ID,
// //         clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
// //         privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
// //       }),
// //     });
// //     console.log('[INIT] Firebase Admin initialized.');
// //   } catch (initErr) {
// //     console.error('[INIT] Firebase Admin init failed:', initErr);
// //     throw initErr;
// //   }
// // }

// // const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// // export default async function handler(req, res) {
// //   console.log('[COMPARE] Incoming request method:', req.method);

// //   if (req.method !== 'POST') {
// //     console.warn('[COMPARE] Method not allowed:', req.method);
// //     return res.status(405).json({ error: 'Method Not Allowed' });
// //   }

// //   const authHeader = req.headers.authorization;
// //   console.log('[COMPARE] Auth Header:', authHeader);

// //   const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
// //   if (!token) {
// //     console.warn('[COMPARE] Missing token');
// //     return res.status(401).json({ error: 'Unauthorized. Token missing.' });
// //   }

// //   try {
// //     await admin.auth().verifyIdToken(token);
// //     console.log('[COMPARE] Firebase auth verified');
// //   } catch (err) {
// //     console.error('[COMPARE] Auth verification failed:', err);
// //     return res.status(403).json({ error: 'Invalid or expired token' });
// //   }

// //   const form = formidable();

// //   const parseForm = () =>
// //     new Promise((resolve, reject) => {
// //       form.parse(req, (err, fields, files) => {
// //         if (err) reject(err);
// //         else resolve({ fields, files });
// //       });
// //     });

// //   try {
// //     console.log('[COMPARE] Parsing form...');
// //     const { files } = await parseForm();
// //     console.log('[COMPARE] Form parsed successfully');
// //     console.log('[COMPARE] Raw files:', files);

// //     const image1 = Array.isArray(files.image1) ? files.image1[0] : files.image1;
// //     const image2 = Array.isArray(files.image2) ? files.image2[0] : files.image2;

// //     console.log('[COMPARE] Uploaded files:', {
// //       image1: image1?.originalFilename,
// //       image2: image2?.originalFilename,
// //     });

// //     if (!image1 || !image2) {
// //       console.warn('[COMPARE] Missing one or both images');
// //       return res.status(400).json({ error: 'Both images are required' });
// //     }

// //     const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
// //     if (!validTypes.includes(image1.mimetype) || !validTypes.includes(image2.mimetype)) {
// //       console.warn('[COMPARE] Invalid image formats:', image1.mimetype, image2.mimetype);
// //       return res.status(400).json({ error: 'Only JPG, PNG, and WEBP formats are supported' });
// //     }

// //     const image1Base64 = fs.readFileSync(image1.filepath, { encoding: 'base64' });
// //     const image2Base64 = fs.readFileSync(image2.filepath, { encoding: 'base64' });

// //     console.log('[COMPARE] Sending images to OpenAI...');
// //     const completion = await openai.chat.completions.create({
// //       model: 'gpt-4o',
// //       messages: [
// //         {
// //           role: 'user',
// //           content: [
// //             {
// //               type: 'text',
// //               text: `Compare these two UI screenshots and generate a markdown-based QA report.
// // Focus on layout shifts, missing or misaligned elements, spacing, font, color, and visual consistency issues.
// // Organize output with bullet points under clear headings.`,
// //             },
// //             {
// //               type: 'image_url',
// //               image_url: { url: `data:${image1.mimetype};base64,${image1Base64}` },
// //             },
// //             {
// //               type: 'image_url',
// //               image_url: { url: `data:${image2.mimetype};base64,${image2Base64}` },
// //             },
// //           ],
// //         },
// //       ],
// //     });

// //     const result = completion.choices?.[0]?.message?.content;
// //     console.log('[COMPARE] OpenAI result received');

// //     if (!result) {
// //       console.error('[COMPARE] No result from OpenAI');
// //       return res.status(502).json({ error: 'OpenAI did not return a result' });
// //     }

// //     return res.status(200).json({ result });
// //   } catch (error) {
// //     console.error('[COMPARE] Server error:', error);
// //     return res.status(500).json({ error: `Comparison failed: ${error.message}` });
// //   }
// // }








// // new compare code 



// // pages/api/compare.js

// export const config = { api: { bodyParser: false } };
// export const runtime = 'nodejs';

// import formidable from 'formidable';
// import fs from 'fs/promises';
// import { OpenAI } from 'openai';
// import { authAdmin } from '@/lib/firebase/firebaseAdmin';
// import { checkAndConsumeQuota } from '@/lib/billing/quota';

// const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// export default async function handler(req, res) {
//   try {
//     if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

//     // 1) Firebase auth (client sends Bearer <ID_TOKEN>)
//     const authHeader = req.headers.authorization || '';
//     const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
//     if (!idToken) return res.status(401).json({ error: 'Unauthorized. Token missing.' });

//     let decoded;
//     try {
//       decoded = await authAdmin.verifyIdToken(idToken, true);
//     } catch {
//       return res.status(401).json({ error: 'Invalid or expired token' });
//     }

//     // 2) Stripe-first quota enforcement (Basic 1, Pro 2, Elite 3)
//     try {
//       await checkAndConsumeQuota({ uid: decoded.uid });
//     } catch (err) {
//       const code = err?.code || '';
//       const msg = err?.message || 'Access denied.';
//       if (code === 'NO_PLAN')        return res.status(403).json({ error: msg, error_code: 'NO_PLAN' });
//       if (code === 'LIMIT_EXCEEDED') return res.status(429).json({ error: msg, error_code: 'LIMIT_EXCEEDED' });
//       return res.status(403).json({ error: msg });
//     }

//     // 3) Parse files
//     const form = formidable({ multiples: false });
//     const { files } = await new Promise((resolve, reject) => {
//       form.parse(req, (err, fields, files) => (err ? reject(err) : resolve({ fields, files })));
//     });

//     const image1 = Array.isArray(files.image1) ? files.image1[0] : files.image1;
//     const image2 = Array.isArray(files.image2) ? files.image2[0] : files.image2;
//     if (!image1 || !image2) return res.status(400).json({ error: 'Both images are required' });

//     const valid = new Set(['image/png', 'image/jpeg', 'image/webp']);
//     if (!valid.has(image1.mimetype) || !valid.has(image2.mimetype)) {
//       return res.status(400).json({ error: 'Only JPG, PNG, and WEBP formats are supported' });
//     }

//     // 4) Read images as base64
//     const [img1, img2] = await Promise.all([
//       fs.readFile(image1.filepath, { encoding: 'base64' }),
//       fs.readFile(image2.filepath, { encoding: 'base64' }),
//     ]);

//     // 5) OpenAI Vision
//     const completion = await openai.chat.completions.create({
//       model: 'gpt-4o',
//       messages: [
//         {
//           role: 'user',
//           content: [
//             {
//               type: 'text',
//               text:
//                 'Compare these two UI screenshots and generate a markdown-based QA report.\n' +
//                 'Focus on layout shifts, missing or misaligned elements, spacing, font, color, and visual consistency issues.\n' +
//                 'Organize output with bullet points under clear headings.',
//             },
//             { type: 'image_url', image_url: { url: `data:${image1.mimetype};base64,${img1}` } },
//             { type: 'image_url', image_url: { url: `data:${image2.mimetype};base64,${img2}` } },
//           ],
//         },
//       ],
//     });

//     const result = completion?.choices?.[0]?.message?.content;
//     if (!result) return res.status(502).json({ error: 'OpenAI did not return a result' });

//     return res.status(200).json({ result });
//   } catch (error) {
//     console.error('[COMPARE] Server error:', error);
//     return res.status(500).json({ error: `Comparison failed: ${error?.message || error}` });
//   }
// }

