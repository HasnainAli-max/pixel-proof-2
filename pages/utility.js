// pages/utility.js
import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { getFirestore, doc, getDoc } from 'firebase/firestore';
import { auth } from '../lib/firebase/config';
import ExportPDF from '../components/ExportPDF';
import Navbar from '../components/Navbar';
import LoadingSpinner from '../components/LoadingSpinner';
import ReactMarkdown from 'react-markdown';
import { Toaster, toast as notify } from 'sonner';

const PLAN_LIMITS = { basic: 1, pro: 2, elite: 3 };

// Treat only these as "can run comparisons"
const ACTIVE_STATUSES = new Set(['active', 'trialing']);

export default function UtilityPage() {
  const [image1, setImage1] = useState(null);
  const [image2, setImage2] = useState(null);
  const [loading, setLoading] = useState(false);
  const [comparisonResult, setComparisonResult] = useState(null);
  const [darkMode, setDarkMode] = useState(false);
  const [fileMeta, setFileMeta] = useState({});
  const [user, setUser] = useState(null);

  // plan/limits UI (display only; server is source of truth)
  const [planName, setPlanName] = useState(null);     // 'basic' | 'pro' | 'elite' | null
  const [dailyLimit, setDailyLimit] = useState(null); // 1 | 2 | 3 | 0 | null
  const [remaining, setRemaining] = useState(null);   // starts from dailyLimit

  // Stripe subscription check (live)
  const [subStatus, setSubStatus] = useState(null);   // 'active' | 'trialing' | 'canceled' | 'no_subscription' | etc.
  const [subLoading, setSubLoading] = useState(true);

  const router = useRouter();

  // Auth guard + Firestore plan (grace window to avoid flicker to /login after sign-up)
  useEffect(() => {
    let redirectTimer = null;

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      if (u) {
        // Signed in quickly → cancel any pending redirect
        if (redirectTimer) clearTimeout(redirectTimer);
        setUser(u);

        try {
          const db = getFirestore();
          const snap = await getDoc(doc(db, 'users', u.uid));
          const d = snap.exists() ? snap.data() : {};
          const rawPlan = String(d?.activePlan || d?.plan || d?.tier || '').toLowerCase();
          const max = PLAN_LIMITS[rawPlan] ?? 0;
          setPlanName(rawPlan || null);
          setDailyLimit(max);
          setRemaining(max);
        } catch {
          setPlanName(null);
          setDailyLimit(null);
          setRemaining(null);
        }
      } else {
        setUser(null);
        // ⬇️ Give Firebase up to 1.5s to hydrate the user (prevents brief hop to /login after sign-up)
        redirectTimer = setTimeout(() => {
          router.replace('/login');
        }, 1500);
      }
    });

    return () => {
      unsubscribe();
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [router]);

  // Theme toggle
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Live subscription status from Stripe (via your API)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      setSubLoading(true);
      try {
        const token = await auth.currentUser.getIdToken();
        const res = await fetch('/api/subscription/status-live', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'Failed to fetch subscription');

        if (!cancelled) {
          setSubStatus(data?.status || 'no_subscription');

          // If no active subscription, reflect on page counter visually
          if (!ACTIVE_STATUSES.has(String(data?.status).toLowerCase())) {
            setRemaining(0);
          }
        }
      } catch (e) {
        console.error('Subscription check failed:', e);
        if (!cancelled) setSubStatus('no_subscription');
      } finally {
        if (!cancelled) setSubLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [user]);

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      router.replace('/login');
    } catch {
      notify.error('Sign out failed. Please try again.');
    }
  };

  // Friendly error helper (no upgrade/downgrade buttons)
  function showFriendlyError({ status, code, msg }) {
    const m = String(msg || '').toLowerCase();

    if (status === 401 && /invalid|expired|token|unauthorized/.test(m)) {
      notify.error('Your session expired. Please sign in again.', {
        action: { label: 'Sign in', onClick: () => router.push('/login') },
      });
      return;
    }

    if (code === 'NO_PLAN' || /no active subscription|buy a plan|no active plan/.test(m)) {
      notify.error("You don't have an active subscription.", {
        description: 'Choose a plan to run comparisons.',
      });
      setRemaining(0);
      return;
    }

    if (status === 429 || code === 'LIMIT_EXCEEDED' || /daily limit/.test(m)) {
      notify.error('Daily limit reached for your plan.', {
        description: 'Try again tomorrow for more comparisons.',
      });
      setRemaining(0);
      return;
    }

    if (status === 400) {
      if (/both images are required/i.test(m)) {
        notify.error('Two images are required.', {
          description: 'Please upload the design and the development screenshot.',
        });
        return;
      }
      if (/only jpg|png|webp/i.test(m)) {
        notify.error('Unsupported image format.', {
          description: 'Use JPG, PNG, or WEBP files.',
        });
        return;
      }
    }

    if (/failed to fetch|network/.test(m)) {
      notify.error('Network issue. Please check your connection and try again.');
      return;
    }

    notify.error('We couldn’t complete the comparison.', {
      description: 'Please try again in a minute.',
    });
  }

  const hasActiveSubscription = ACTIVE_STATUSES.has(String(subStatus || '').toLowerCase());

  const handleCompare = async () => {
    if (!hasActiveSubscription) {
      notify.info('First buy the plan then start comparison');
      return;
    }

    if (!image1 || !image2) {
      notify.info('Please upload both images before comparing.');
      return;
    }

    setLoading(true);
    setComparisonResult(null);

    try {
      const token = await auth.currentUser.getIdToken();

      const formData = new FormData();
      formData.append('image1', image1);
      formData.append('image2', image2);

      setFileMeta({
        fileName1: image1.name,
        fileName2: image2.name,
        timestamp: new Date().toLocaleString(),
      });

      const response = await fetch('/api/compare', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const raw = await response.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: raw || 'Unknown server response' };
      }

      if (!response.ok) {
        const code = data?.error_code || '';
        const msg = data?.error || 'Server error';
        showFriendlyError({ status: response.status, code, msg });
        throw new Error(String(msg));
      }

      if (!data.result) throw new Error('Comparison result missing in response.');

      setComparisonResult(data.result);
      notify.success('Done! Your visual QA report is ready.');

      // Decrement page counter (server still enforces real quota)
      setRemaining((prev) => (typeof prev === 'number' ? Math.max(prev - 1, 0) : prev));
    } catch (error) {
      console.error('Comparison failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const renderPreview = (file) =>
    file ? (
      <img
        src={URL.createObjectURL(file)}
        alt="Preview"
        className="rounded shadow h-40 object-contain w-full mt-2"
      />
    ) : null;

  if (!user) {
    return (
      <>
        <Toaster richColors position="top-center" closeButton />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-white font-sans">
      <Toaster richColors position="top-center" closeButton />
      <Navbar user={user} onSignOut={handleSignOut} />

      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold text-purple-800 dark:text-purple-300">PixelProof</h1>
          <button
            className="bg-purple-100 dark:bg-purple-700 hover:bg-purple-200 dark:hover:bg-purple-600 p-2 rounded transition"
            onClick={() => setDarkMode(!darkMode)}
            title="Toggle theme"
          >
            {darkMode ? '🌙' : '☀️'}
          </button>
        </div>

        <p className="text-lg font-semibold">Design QA, Automated with AI</p>
        <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
          Upload your original design and final build screenshots. Let AI catch visual bugs before your clients do.
        </p>

        {/* Comparison counter on page (not in toasts) */}
        <p className="text-sm text-gray-700 dark:text-gray-300 mb-6">
          Remaining comparisons today:{' '}
          <strong>
            {typeof remaining === 'number' && typeof dailyLimit === 'number'
              ? `${remaining}/${dailyLimit}`
              : '—'}
          </strong>
          {planName ? ` (plan: ${planName})` : ''}
        </p>

        <div className="border p-4 rounded bg-gray-50 dark:bg-gray-800 prose dark:prose-invert mb-10">
          <h2 className="font-semibold">How to Use</h2>
          <ul>
            <li>Upload the design and development screenshots</li>
            <li>Supported: JPG, PNG, WEBP – min width 500px</li>
            <li>Ensure matching layout and scale</li>
          </ul>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Upload Design */}
          <div className="border-2 border-dashed border-purple-300 p-6 rounded-lg text-center bg-white dark:bg-gray-700 hover:border-purple-500 transition transform hover:scale-[1.01]">
            <label className="block font-semibold text-gray-800 dark:text-white mb-2">Upload Design</label>
            <input
              type="file"
              onChange={(e) => setImage1(e.target.files[0])}
              accept="image/*"
              className="w-full cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-purple-100 file:text-purple-900 hover:file:bg-purple-200"
            />
            {renderPreview(image1)}
          </div>

          {/* Upload Dev */}
          <div className="border-2 border-dashed border-purple-300 p-6 rounded-lg text-center bg.white dark:bg-gray-700 hover:border-purple-500 transition transform hover:scale-[1.01]">
            <label className="block font-semibold text-gray-800 dark:text-white mb-2">Upload Development Screenshot</label>
            <input
              type="file"
              onChange={(e) => setImage2(e.target.files[0])}
              accept="image/*"
              className="w-full cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-purple-100 file:text-purple-900 hover:file:bg-purple-200"
            />
            {renderPreview(image2)}
          </div>
        </div>

        <div className="mt-10 flex flex-wrap items-center gap-3">
          <button
            onClick={handleCompare}
            disabled={subLoading || !hasActiveSubscription || loading}
            className={`bg-purple-800 text-white px-6 py-3 rounded-lg font-semibold shadow transition
              ${subLoading || !hasActiveSubscription || loading ? 'opacity-60 cursor-not-allowed' : 'hover:bg-purple-900'}`}
          >
            {loading
              ? 'Comparing...'
              : (subLoading
                  ? 'Checking subscription...'
                  : (!hasActiveSubscription
                      ? 'First buy the plan then start comparison'
                      : 'Start Comparison'))}
          </button>

          {/* Plans button also available here when no active subscription */}
          {!hasActiveSubscription && !subLoading && (
            <button
              onClick={() => router.push('/')}
              className="rounded-lg border border-purple-300 text-purple-800 dark:border-purple-600 dark:text-purple-300 px-4 py-3 font-semibold hover:bg-purple-50 dark:hover:bg-purple-900/20"
            >
              Plans
            </button>
          )}
        </div>

        {loading && <LoadingSpinner />}

        {comparisonResult && (
          <div className="mt-10 bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-lg">
            <h2 className="text-xl font-bold mb-4 text-purple-800 dark:text-purple-300">Visual Bug Report</h2>
            <ul className="text-sm mb-4">
              <li><strong>File 1:</strong> {fileMeta.fileName1}</li>
              <li><strong>File 2:</strong> {fileMeta.fileName2}</li>
              <li><strong>Timestamp:</strong> {fileMeta.timestamp}</li>
            </ul>
            <div className="prose dark:prose-invert max-w-none text-sm">
              <ReactMarkdown>{comparisonResult}</ReactMarkdown>
            </div>
            <ExportPDF result={comparisonResult} />
          </div>
        )}
      </div>
    </div>
  );
}




























// // pages/utility.js
// import { useState, useEffect } from 'react';
// import { useRouter } from 'next/router';
// import { onAuthStateChanged, signOut } from 'firebase/auth';
// import { getFirestore, doc, getDoc } from 'firebase/firestore';
// import { auth } from '../lib/firebase/config';
// import ExportPDF from '../components/ExportPDF';
// import Navbar from '../components/Navbar';
// import LoadingSpinner from '../components/LoadingSpinner';
// import ReactMarkdown from 'react-markdown';
// import { Toaster, toast as notify } from 'sonner';

// const PLAN_LIMITS = { basic: 1, pro: 2, elite: 4 };
// const ACTIVE_STATUSES = new Set(['active', 'trialing']);

// const PRICE_BASIC = process.env.NEXT_PUBLIC_STRIPE_PRICE_BASIC || '';
// const PRICE_PRO   = process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO   || '';
// const PRICE_ELITE = process.env.NEXT_PUBLIC_STRIPE_PRICE_ELITE || '';

// export default function UtilityPage() {
//   const [image1, setImage1] = useState(null);
//   const [image2, setImage2] = useState(null);
//   const [loading, setLoading] = useState(false);
//   const [comparisonResult, setComparisonResult] = useState(null);
//   const [darkMode, setDarkMode] = useState(false);
//   const [fileMeta, setFileMeta] = useState({});
//   const [user, setUser] = useState(null);

//   const [planName, setPlanName] = useState(null);
//   const [dailyLimit, setDailyLimit] = useState(null);
//   const [remaining, setRemaining] = useState(null);

//   const [subStatus, setSubStatus] = useState(null);
//   const [subLoading, setSubLoading] = useState(true);

//   const [portalBusy, setPortalBusy] = useState(false);

//   const [modal, setModal] = useState({ open: false, title: '', description: '', primary: null, secondary: null });
//   const [isClosing, setIsClosing] = useState(false);

//   const router = useRouter();

//   function normalizePlanFromStripe(subData = {}) {
//     const raw = String(subData.plan || subData.productName || subData.nickname || '').toLowerCase();
//     const priceId = subData.priceId || subData.price_id || '';
//     if (priceId) {
//       if (PRICE_BASIC && priceId === PRICE_BASIC) return 'basic';
//       if (PRICE_PRO   && priceId === PRICE_PRO)   return 'pro';
//       if (PRICE_ELITE && priceId === PRICE_ELITE) return 'elite';
//     }
//     if (/elite|unlimited|premium/.test(raw)) return 'elite';
//     if (/\bpro\b/.test(raw)) return 'pro';
//     if (/basic|starter/.test(raw)) return 'basic';
//     return null;
//   }

//   function setLimitsFromPlanSlug(slug) {
//     const max = PLAN_LIMITS[slug] ?? 0;
//     setPlanName(slug || null);
//     setDailyLimit(max);
//     setRemaining(prev => (prev == null ? max : prev));
//   }

//   useEffect(() => {
//     let redirectTimer = null;
//     const unsubscribe = onAuthStateChanged(auth, async (u) => {
//       if (u) {
//         if (redirectTimer) clearTimeout(redirectTimer);
//         setUser(u);
//         try {
//           const db = getFirestore();
//           const snap = await getDoc(doc(db, 'users', u.uid));
//           const d = snap.exists() ? snap.data() : {};
//           if (!planName) {
//             const rawPlan = String(d?.activePlan || d?.plan || d?.tier || '').toLowerCase();
//             if (rawPlan) setLimitsFromPlanSlug(rawPlan);
//           }
//         } catch {/* ignore */}
//       } else {
//         setUser(null);
//         redirectTimer = setTimeout(() => { router.replace('/login'); }, 1500);
//       }
//     });
//     return () => { unsubscribe(); if (redirectTimer) clearTimeout(redirectTimer); };
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [router]);

//   useEffect(() => {
//     document.documentElement.classList.toggle('dark', darkMode);
//   }, [darkMode]);

//   useEffect(() => {
//     if (!user) return;
//     let cancelled = false;
//     (async () => {
//       setSubLoading(true);
//       try {
//         const token = await auth.currentUser.getIdToken();
//         const res = await fetch('/api/subscription/status-live', {
//           method: 'GET',
//           headers: { Authorization: `Bearer ${token}` },
//         });
//         const data = await res.json();
//         if (!res.ok) throw new Error(data?.error || 'Failed to fetch subscription');
//         if (cancelled) return;
//         const status = data?.status || 'no_subscription';
//         setSubStatus(status);
//         const slug = normalizePlanFromStripe(data);
//         if (slug) setLimitsFromPlanSlug(slug);
//         else if (!planName) { setPlanName(null); setDailyLimit(0); setRemaining(prev => (prev == null ? 0 : prev)); }
//         if (!ACTIVE_STATUSES.has(String(status).toLowerCase())) setRemaining(0);
//         else setRemaining(prev => (prev == null ? PLAN_LIMITS[slug] ?? prev : prev));
//       } catch (e) {
//         console.error('Subscription check failed:', e);
//         if (!cancelled) { setSubStatus('no_subscription'); if (remaining == null) setRemaining(0); }
//       } finally {
//         if (!cancelled) setSubLoading(false);
//       }
//     })();
//     return () => { cancelled = true; };
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [user]);

//   const handleSignOut = async () => {
//     try {
//       await signOut(auth);
//       router.replace('/login');
//     } catch {
//       openGenericErrorModal('Sign out failed. Please try again.');
//     }
//   };

//   async function openPortal(intent = 'update') {
//     try {
//       setPortalBusy(true);
//       const token = await auth.currentUser.getIdToken();
//       const res = await fetch('/api/billing/portal', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
//         body: JSON.stringify({ intent }),
//       });
//       const text = await res.text();
//       let data; try { data = JSON.parse(text); } catch { throw new Error(text); }
//       if (!res.ok) throw new Error(data?.error || 'Failed to create portal session');
//       window.location.href = data.url;
//     } catch (e) {
//       console.error('openPortal error:', e);
//       openGenericErrorModal(e?.message || 'Could not open customer portal.');
//     } finally {
//       setPortalBusy(false);
//     }
//   }

//   function openModal({ title, description, primary, secondary }) {
//     setIsClosing(false);
//     setModal({ open: true, title, description, primary: primary || null, secondary: secondary || null });
//   }
//   function closeModal() {
//     setIsClosing(true);
//     setTimeout(() => setModal(m => ({ ...m, open: false })), 200);
//   }
//   function openNoPlanModal(extra = '') {
//     openModal({
//       title: "No active subscription",
//       description: `You don’t have an active plan. Pick a plan to start your visual comparisons.${extra ? `\n\n${extra}` : ''}`,
//       primary: { label: "View Plans", onClick: () => router.push('/') },
//       secondary: { label: "Close", onClick: closeModal },
//     });
//   }
//   function openLimitReachedModal(extra = '') {
//     const p = (planName || '').toLowerCase();
//     const upgradeTo = p === 'basic' ? 'pro' : (p === 'pro' ? 'elite' : null);
//     const description = (upgradeTo
//       ? `You’ve used all your daily comparisons on the ${p} plan. Upgrade to ${upgradeTo} for a higher daily limit.`
//       : `You’ve reached your current daily limit. You can manage your plan in the billing portal.`) + (extra ? `\n\n${extra}` : '');
//     openModal({
//       title: "Daily limit reached",
//       description,
//       primary: { label: upgradeTo ? `Upgrade to ${upgradeTo}` : 'Manage plan', onClick: () => openPortal('update') },
//       secondary: { label: "Close", onClick: closeModal },
//     });
//   }
//   function openGenericErrorModal(message) {
//     openModal({ title: 'Something went wrong', description: message || 'We couldn’t complete the comparison.', primary: { label: 'Close', onClick: closeModal } });
//   }
//   function openMissingImagesModal(extra = '') {
//     openModal({
//       title: 'Two images are required',
//       description: `Please upload the design and the development screenshot before starting comparison.${extra ? `\n\n${extra}` : ''}`,
//       primary: { label: 'Got it', onClick: closeModal },
//     });
//   }
//   function openUnsupportedFormatModal(extra = '') {
//     openModal({
//       title: 'Unsupported image format',
//       description: `Use JPG, PNG, or WEBP files with minimum width 500px.${extra ? `\n\n${extra}` : ''}`,
//       primary: { label: 'OK', onClick: closeModal },
//     });
//   }
//   function openSessionExpiredModal(extra = '') {
//     openModal({
//       title: 'Session expired',
//       description: `Please sign in again to continue.${extra ? `\n\n${extra}` : ''}`,
//       primary: { label: 'Sign in', onClick: () => router.push('/login') },
//       secondary: { label: 'Close', onClick: closeModal },
//     });
//   }

//   const hasActiveSubscription = ACTIVE_STATUSES.has(String(subStatus || '').toLowerCase());

//   const handleCompare = async () => {
//     if (!hasActiveSubscription) { openNoPlanModal(); return; }
//     if (typeof remaining === 'number' && remaining <= 0) { openLimitReachedModal(); return; }
//     if (!image1 || !image2) { openMissingImagesModal(); return; }

//     setLoading(true);
//     setComparisonResult(null);

//     try {
//       const token = await auth.currentUser.getIdToken();
//       const formData = new FormData();
//       formData.append('image1', image1);
//       formData.append('image2', image2);

//       setFileMeta({ fileName1: image1.name, fileName2: image2.name, timestamp: new Date().toLocaleString() });

//       const response = await fetch('/api/compare', {
//         method: 'POST',
//         headers: { Authorization: `Bearer ${token}` },
//         body: formData,
//       });

//       const raw = await response.text();
//       let data; try { data = JSON.parse(raw); } catch { data = { error: raw || 'Unknown server response' }; }

//       if (!response.ok) {
//         const code = data?.error_code || '';
//         const msg  = data?.error || 'Server error';
//         const rid  = data?.rid ? `\n\nReference: ${data.rid}` : '';
//         showFriendlyError({ status: response.status, code, msg, rid });
//         throw new Error(`${msg} ${rid}`);
//       }

//       if (!data.result) throw new Error('Comparison result missing in response.');
//       setComparisonResult(data.result);
//       notify.success('Done! Your visual QA report is ready.');
//       setRemaining(prev => (typeof prev === 'number' ? Math.max(prev - 1, 0) : prev));
//     } catch (error) {
//       console.error('Comparison failed:', error);
//     } finally {
//       setLoading(false);
//     }
//   };

//   // Map server errors → custom modal (now always shows message + rid)
//   function showFriendlyError({ status, code, msg, rid }) {
//     const extra = rid || '';
//     const m = String(msg || '').toLowerCase();

//     if (status === 401 && /invalid|expired|token|unauthorized/.test(m)) { openSessionExpiredModal(extra); return; }
//     if (code === 'NO_PLAN' || /no active subscription|buy a plan|no active plan/.test(m)) { openNoPlanModal(extra); setRemaining(0); return; }
//     if (status === 429 || code === 'LIMIT_EXCEEDED' || /daily limit/.test(m)) { openLimitReachedModal(extra); setRemaining(0); return; }

//     if (status === 400) {
//       if (/both images are required/i.test(m) || code === 'MISSING_IMAGES') { openMissingImagesModal(extra); return; }
//       if (/only jpg|png|webp/i.test(m) || code === 'BAD_IMAGE' || code === 'BAD_MULTIPART') { openUnsupportedFormatModal(extra); return; }
//     }

//     if (status === 502 && (code === 'OPENAI_ERROR' || code === 'OPENAI_EMPTY')) {
//       openGenericErrorModal(`${msg}${extra}`); return;
//     }
//     if (status === 500 && code === 'FILE_READ_ERROR') {
//       openGenericErrorModal(`${msg}${extra}`); return;
//     }
//     if (status === 500 && code === 'CONFIG') {
//       openGenericErrorModal(`${msg}${extra}`); return;
//     }

//     if (/failed to fetch|network/.test(m)) { openGenericErrorModal(`Network issue. Please check your connection and try again.${extra}`); return; }
//     openGenericErrorModal(`${msg}${extra}`);
//   }

//   const renderPreview = (file) =>
//     file ? (
//       <img src={URL.createObjectURL(file)} alt="Preview" className="rounded shadow h-40 object-contain w-full mt-2" />
//     ) : null;

//   if (!user) return (<><Toaster richColors position="top-center" closeButton /></>);

//   const fileInputClasses =
//     "w-full cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-purple-100 file:text-purple-800 hover:file:bg-purple-200";

//   return (
//     <div className="min-h-screen bg-white text-gray-900 dark:bg-gray-900 dark:text-white font-sans">
//       <Toaster richColors position="top-center" closeButton />
//       <Navbar user={user} onSignOut={handleSignOut} />

//       <div className="p-6 max-w-4xl mx-auto">
//         <div className="flex justify-between items-center mb-8">
//           <h1 className="text-3xl font-bold text-purple-800 dark:text-purple-300">PixelProof</h1>
//           <button className="bg-purple-100 dark:bg-purple-700 hover:bg-purple-200 dark:hover:bg-purple-600 p-2 rounded transition" onClick={() => setDarkMode(!darkMode)} title="Toggle theme">
//             {darkMode ? '🌙' : '☀️'}
//           </button>
//         </div>

//         <p className="text-lg font-semibold">Design QA, Automated with AI</p>
//         <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
//           Upload your original design and final build screenshots. Let AI catch visual bugs before your clients do.
//         </p>

//         <p className="text-sm text-gray-700 dark:text-gray-300 mb-6">
//           Remaining comparisons today:{' '}
//           <strong>{typeof remaining === 'number' && typeof dailyLimit === 'number' ? `${remaining}/${dailyLimit}` : '—'}</strong>
//           {planName ? ` (plan: ${planName})` : ''}
//         </p>

//         <div className="border p-4 rounded bg-gray-50 dark:bg-gray-800 prose dark:prose-invert mb-10">
//           <h2 className="font-semibold">How to Use</h2>
//           <ul>
//             <li>Upload the design and development screenshots</li>
//             <li>Supported: JPG, PNG, WEBP – min width 500px</li>
//             <li>Ensure matching layout and scale</li>
//           </ul>
//         </div>

//         <div className="grid md:grid-cols-2 gap-6">
//           <div className="border-2 border-dashed border-purple-300 p-6 rounded-lg text-center bg-white dark:bg-gray-700 hover:border-purple-500 transition transform hover:scale-[1.01]">
//             <label className="block font-semibold text-gray-800 dark:text-white mb-2">Upload Design</label>
//             <input type="file" onChange={(e) => setImage1(e.target.files[0])} accept="image/*" className={fileInputClasses} />
//             {renderPreview(image1)}
//           </div>

//           <div className="border-2 border-dashed border-purple-300 p-6 rounded-lg text-center bg-white dark:bg-gray-700 hover:border-purple-500 transition transform hover:scale-[1.01]">
//             <label className="block font-semibold text-gray-800 dark:text-white mb-2">Upload Development Screenshot</label>
//             <input type="file" onChange={(e) => setImage2(e.target.files[0])} accept="image/*" className={fileInputClasses} />
//             {renderPreview(image2)}
//           </div>
//         </div>

//         <div className="mt-10 flex flex-wrap items-center gap-3">
//           <button
//             onClick={handleCompare}
//             disabled={subLoading || !hasActiveSubscription || loading}
//             className={`bg-purple-800 text-white px-6 py-3 rounded-lg font-semibold shadow transition
//               ${subLoading || !hasActiveSubscription || loading ? 'opacity-60 cursor-not-allowed' : 'hover:bg-purple-900'}`}
//           >
//             {loading ? 'Comparing...' : (subLoading ? 'Checking subscription...' : (!hasActiveSubscription ? 'First buy the plan then start comparison' : 'Start Comparison'))}
//           </button>

//           {!hasActiveSubscription && !subLoading && (
//             <button onClick={() => router.push('/')} className="rounded-lg border border-purple-300 text-purple-800 dark:border-purple-600 dark:text-purple-300 px-4 py-3 font-semibold hover:bg-purple-50 dark:hover:bg-purple-900/20">
//               Plans
//             </button>
//           )}
//         </div>

//         {loading && <LoadingSpinner />}

//         {comparisonResult && (
//           <div className="mt-10 bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-lg">
//             <h2 className="text-xl font-bold mb-4 text-purple-800 dark:text-purple-300">Visual Bug Report</h2>
//             <ul className="text-sm mb-4">
//               <li><strong>File 1:</strong> {fileMeta.fileName1}</li>
//               <li><strong>File 2:</strong> {fileMeta.fileName2}</li>
//               <li><strong>Timestamp:</strong> {fileMeta.timestamp}</li>
//             </ul>
//             <div className="prose dark:prose-invert max-w-none text-sm">
//               <ReactMarkdown>{comparisonResult}</ReactMarkdown>
//             </div>
//             <ExportPDF result={comparisonResult} />
//           </div>
//         )}
//       </div>

//       {/* Modal with enter/exit animation */}
//       {modal.open && (
//         <div
//           className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${isClosing ? 'opacity-0' : 'opacity-100'}`}
//           onClick={closeModal}
//         >
//           <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
//           <div
//             className={`relative w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 shadow-xl ring-1 ring-black/10 dark:ring-white/10 transform transition duration-200 ${isClosing ? 'scale-95 translate-y-2 opacity-0' : 'scale-100 translate-y-0 opacity-100'}`}
//             onClick={(e) => e.stopPropagation()}
//           >
//             <div className="flex items-start justify-between p-5 border-b border-gray-200 dark:border-gray-800">
//               <h3 className="text-lg font-semibold">{modal.title}</h3>
//               <button onClick={closeModal} aria-label="Close" className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800">
//                 <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
//                   <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
//                 </svg>
//               </button>
//             </div>
//             <div className="p-5">
//               <p className="text-sm leading-relaxed whitespace-pre-wrap">{modal.description}</p>
//             </div>
//             <div className="flex items-center justify-end gap-2 p-5 border-t border-gray-200 dark:border-gray-800">
//               {modal.secondary && (
//                 <button onClick={modal.secondary.onClick} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 text-sm hover:bg-gray-100 dark:hover:bg-gray-800">
//                   {modal.secondary.label}
//                 </button>
//               )}
//               {modal.primary && (
//                 <button onClick={modal.primary.onClick} disabled={portalBusy} className="px-4 py-2 rounded-lg bg-purple-700 text-white text-sm font-semibold hover:brightness-110 disabled:opacity-60">
//                   {portalBusy ? 'Please wait…' : modal.primary.label}
//                 </button>
//               )}
//             </div>
//           </div>
//         </div>
//       )}
//     </div>
//   );
// }
