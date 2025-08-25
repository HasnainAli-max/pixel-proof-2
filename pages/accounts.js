import Head from "next/head";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import Navbar from "@/components/Navbar";
import { Toaster, toast } from "sonner";

export default function Accounts() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Stripe live subscription data (not from Firestore)
  const [sub, setSub] = useState(null);

  // sign out (same behavior) + toast
  const handleSignOut = async () => {
    try {
      await toast.promise(signOut(auth), {
        loading: "Signing you out…",
        success: "Signed out.",
        error: "Sign out failed. Please try again.",
      });
      router.replace("/login");
    } catch (e) {
      console.error("Sign out failed:", e);
    }
  };

  // Auth guard
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        router.replace("/login");
      } else {
        setAuthUser(u);
      }
      setLoading(false);
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch fresh subscription from Stripe via API (no Firestore)
  useEffect(() => {
    if (!authUser) return;

    (async () => {
      try {
        const token = await authUser.getIdToken();
        const res = await fetch("/api/subscription/status-live", {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();

        if (!res.ok) throw new Error(data?.error || "Failed to fetch subscription");

        setSub(data);
      } catch (e) {
        console.error("Fetch subscription error:", e);
        toast.error("Couldn't load your subscription. Please refresh.");
      }
    })();
  }, [authUser]);

  // Derived values for UI (from auth + Stripe response)
  const view = useMemo(() => {
    const name =
      authUser?.displayName ||
      (authUser?.email ? authUser.email.split("@")[0] : "") ||
      "—";
    const loginEmail = authUser?.email || "—";
    const billingEmail = sub?.customerEmail || loginEmail;
    const avatarUrl = authUser?.photoURL || null;

    const plan = sub?.plan || (sub?.status === "no_subscription" ? "No plan" : "—");
    const status = sub?.status || "inactive";

    const amount =
      typeof sub?.amount === "number" ? (sub.amount / 100).toFixed(2) : "—";

    const renewDate = formatDate(sub?.currentPeriodEnd);

    return { name, loginEmail, billingEmail, plan, amount, status, renewDate, avatarUrl };
  }, [authUser, sub]);

  // Open Stripe Customer Portal (unchanged)
  async function openPortal(intent) {
    try {
      setBusy(true);
      await toast.promise(
        (async () => {
          const token = await auth.currentUser.getIdToken();
          const res = await fetch("/api/billing/portal", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ intent }),
          });

          const text = await res.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error(text);
          }
          if (!res.ok) throw new Error(data.error || "Failed to create portal session");

          setTimeout(() => {
            window.location.href = data.url;
          }, 300);
          return "Redirecting to Stripe…";
        })(),
        {
          loading: intent === "cancel" ? "Opening cancel options…" : "Opening billing portal…",
          success: (msg) => msg || "Redirecting…",
          error: (e) => e?.message || "Could not open customer portal.",
        }
      );
    } catch (e) {
      console.error("openPortal error:", e);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="min-h-screen grid place-items-center text-slate-600 dark:text-slate-300">
        <Toaster richColors position="top-right" closeButton />
        Loading account…
      </main>
    );
  }
  if (!authUser) return null;

  // Helper to choose a badge color for more statuses (active, trialing, canceled, past_due, unpaid, etc.)
  const statusBadgeClasses = (() => {
    const s = (view.status || "").toLowerCase();
    if (s === "active")
      return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300";
    if (s === "trialing")
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    if (s === "canceled")
      return "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";
    if (s === "past_due")
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300";
    if (s === "unpaid")
      return "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300";
    if (s === "no_subscription")
      return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300";
    return "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300";
  })();

  // Line under price: cancel-aware message
  const planSubline = (() => {
    const status = sub?.status;
    if (status === "canceled" && sub?.canceledAt) {
      return `Canceled on ${formatDate(sub.canceledAt)}`;
    }
    if (sub?.cancelAtPeriodEnd && sub?.currentPeriodEnd) {
      return `Ends on ${formatDate(sub.currentPeriodEnd)}`;
    }
    if (view.renewDate) {
      return `Renews on ${view.renewDate}`;
    }
    return status === "no_subscription" ? "No subscription" : "No renewal scheduled";
  })();

  return (
    <>
      <Head>
        <title>Account – PixelProof</title>
      </Head>

      <Toaster richColors position="top-right" closeButton />
      <Navbar user={authUser} onSignOut={handleSignOut} />

      <main className="min-h-screen bg-gradient-to-b from-[#f7f8ff] to-white dark:from-slate-950 dark:to-slate-900">
        <div className="max-w-6xl mx-auto px-6 pt-8 pb-4 flex items-center justify-end gap-3" />

        <div className="max-w-6xl mx-auto px-6 pb-14 grid lg:grid-cols-3 gap-6">
          {/* Profile */}
          <section className="lg:col-span-2 bg-white dark:bg-slate-800 rounded-2xl shadow-sm ring-1 ring-black/5 dark:ring-white/10 p-6">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-6">Profile</h2>

            <div className="flex items-center gap-4 mb-6">
              {view.avatarUrl ? (
                <img
                  src={view.avatarUrl}
                  alt={`${view.name} avatar`}
                  className="h-14 w-14 rounded-full object-cover ring-1 ring-black/10 dark:ring-white/10"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="h-14 w-14 flex items-center justify-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-200 font-bold">
                  {initials(view.name)}
                </div>
              )}
              <div>
                <div className="text-slate-900 dark:text-slate-100 font-semibold">
                  {view.name}
                </div>
                <div className="text-slate-600 dark:text-slate-300 text-sm">
                  {view.loginEmail}
                </div>
              </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-700/60">
                <div className="text-slate-600 dark:text-slate-300 text-sm mb-1">Billing email</div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">{view.billingEmail}</div>
              </div>

              <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-700/60">
                <div className="text-slate-600 dark:text-slate-300 text-sm mb-1">Login email</div>
                <div className="font-semibold text-slate-900 dark:text-slate-100">{view.loginEmail}</div>
              </div>
            </div>
          </section>

          {/* Plan */}
          <aside className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm ring-1 ring-black/5 dark:ring-white/10 p-6">
            <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-4">Current Plan</h2>

            <div className="rounded-2xl border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/40 p-5 mb-5 relative">
              <div className="absolute right-3 top-3">
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusBadgeClasses}`}>
                  {view.status}
                </span>
              </div>
              <div className="text-slate-800 dark:text-slate-100 font-semibold">{view.plan}</div>
              <div className="mt-1">
                <span className="text-3xl font-extrabold text-slate-900 dark:text-white">
                  {view.amount !== "—" ? `$${view.amount}` : "—"}
                </span>
                {view.amount !== "—" && <span className="text-slate-600 dark:text-slate-300"> / mo</span>}
              </div>
              <div className="text-slate-600 dark:text-slate-300 text-sm mt-2">{planSubline}</div>
            </div>

            <div className="space-y-3">
              <button
                type="button"
                disabled={busy}
                onClick={() => openPortal("update")}
                className="w-full h-11 rounded-xl bg-[#6c2bd9] text-white font-medium shadow-sm hover:brightness-95 disabled:opacity-50 transition"
              >
                Update plan
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => openPortal("cancel")}
                className="w-full h-11 rounded-xl border border-amber-300 dark:border-amber-600 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 font-medium hover:bg-amber-100 dark:hover:bg-amber-900/50 disabled:opacity-50 transition"
              >
                Cancel subscription
              </button>
            </div>
          </aside>
        </div>
      </main>
    </>
  );
}

/* ---------- helpers ---------- */
function initials(name = "") {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() || "").join("") || "PP";
}

function formatDate(tsLike) {
  if (!tsLike) return "";
  if (typeof tsLike === "number") {
    const ms = tsLike > 1e12 ? tsLike : tsLike * 1000;
    return new Date(ms).toLocaleDateString();
  }
  const d = new Date(tsLike);
  return isNaN(d) ? "" : d.toLocaleDateString();
}
