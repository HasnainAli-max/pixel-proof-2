// lib/firebase/firebaseAdmin.js
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

const serviceAccount = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  // strip accidental surrounding quotes and restore line breaks
  privateKey: process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n')
    : undefined,
};

if (!getApps().length) {
  initializeApp({ credential: cert(serviceAccount) });
}

const app = getApp();

// Admin Auth for verifying ID tokens in API routes
export const authAdmin = getAuth(app);

// Explicit DB id avoids "settings.databaseId" crash in some envs
const DATABASE_ID = process.env.FIRESTORE_DB_ID || '(default)';
export const db = getFirestore(app, DATABASE_ID);

// In some dev setups, prefer REST (ignored silently if not supported)
try {
  db.settings({ preferRest: true });
} catch (_) {}

export { FieldValue, Timestamp };



// // lib/firebase/firebaseAdmin.js
// import admin from 'firebase-admin';

// let app;

// // Only use emulators if you *explicitly* opt in AND you're not in production.
// const USE_EMULATORS =
//   process.env.USE_FIREBASE_EMULATORS === '1' &&
//   process.env.NODE_ENV !== 'production';

// // If we are NOT explicitly using emulators, make sure emulator envs are cleared
// if (!USE_EMULATORS) {
//   delete process.env.FIRESTORE_EMULATOR_HOST;
//   delete process.env.FIREBASE_EMULATOR_HOST;
//   delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
// }

// if (!admin.apps.length) {
//   const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
//   const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
//   const projectId   = process.env.FIREBASE_PROJECT_ID;

//   app = admin.initializeApp({
//     credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
//     ...(process.env.FIREBASE_STORAGE_BUCKET
//       ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET }
//       : {}),
//   });
// } else {
//   app = admin.app();
// }

// export const authAdmin  = admin.auth();
// export const db         = admin.firestore();
// export const FieldValue = admin.firestore.FieldValue;
// export default app;
