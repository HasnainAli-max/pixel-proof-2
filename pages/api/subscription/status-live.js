// pages/api/subscription/status-live.js
import { stripe } from '@/lib/stripe/stripe';
import { authAdmin } from '@/lib/firebase/firebaseAdmin';

const PLAN_BY_PRICE = {
  [process.env.STRIPE_PRICE_BASIC]: 'basic',
  [process.env.STRIPE_PRICE_PRO]: 'pro',
  [process.env.STRIPE_PRICE_ELITE]: 'elite',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing ID token' });

    const { uid, email } = await authAdmin.verifyIdToken(token);

    // ---------- Find customer for this Firebase user ----------
    let customerId = null;

    // 1) Prefer customer.metadata.uid = uid
    try {
      const srch = await stripe.customers.search({
        query: `metadata['uid']:'${uid}'`,
        limit: 1,
      });
      if (srch.data[0]) customerId = srch.data[0].id;
    } catch (_) {}

    // 2) Fallback by email
    if (!customerId && email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      if (list.data[0]) customerId = list.data[0].id;
    }

    // 3) Fallback via recent completed Checkout Session that carries metadata.uid
    if (!customerId) {
      try {
        const sessions = await stripe.checkout.sessions.search({
          query: `metadata['uid']:'${uid}' AND status:'complete'`,
          limit: 1,
        });
        if (sessions.data[0]?.customer) customerId = sessions.data[0].customer;
      } catch (_) {}
    }

    if (!customerId) {
      return res.status(200).json({ status: 'no_customer' });
    }

    // ---------- Get latest subscription (any state) ----------
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 5,
    });

    const sub = subs.data.find(s =>
      ['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete'].includes(s.status)
    ) || null;

    if (!sub) {
      return res.status(200).json({ status: 'no_subscription', customerId });
    }

    const item = sub.items?.data?.[0] || null;
    const priceId = item?.price?.id || null;
    const amount = item?.price?.unit_amount ?? null;
    const currency = item?.price?.currency ?? null;
    const plan = priceId ? (PLAN_BY_PRICE[priceId] || item?.price?.nickname || 'unknown') : 'unknown';

    // Cancellation-related fields (Stripe semantics)
    const cancelAtPeriodEnd = !!sub.cancel_at_period_end;
    const cancelAt   = sub.cancel_at   || null; // seconds since epoch (when it will cancel, if scheduled)
    const canceledAt = sub.canceled_at || null; // seconds since epoch (when it actually got canceled)
    const endedAt    = sub.ended_at    || null; // seconds since epoch (end of the subscription)
    const currentPeriodStart = sub.current_period_start || null;
    const currentPeriodEnd   = sub.current_period_end   || null;

    // A friendly “displayStatus” for your UI
    const displayStatus =
      sub.status === 'canceled' ? 'canceled'
      : cancelAtPeriodEnd        ? 'canceling'
      : sub.status;

    return res.status(200).json({
      // original status from Stripe + a display label
      status: sub.status,
      displayStatus,

      // plan/price info
      plan,
      priceId,
      amount,
      currency,

      // period info
      currentPeriodStart,
      currentPeriodEnd,

      // cancel info
      cancelAtPeriodEnd,
      cancelAt,
      canceledAt,
      endedAt,

      // ids / context
      customerId,
      customerEmail: email,
      subscriptionId: sub.id,
    });
  } catch (e) {
    console.error('status-live error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
