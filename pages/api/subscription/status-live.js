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

    let customerId = null;

    // 1) Best: customers.search by metadata.uid
    try {
      const srch = await stripe.customers.search({
        query: `metadata['uid']:'${uid}'`,
        limit: 1,
      });
      if (srch.data[0]) customerId = srch.data[0].id;
    } catch {}

    // 2) Fallback: by email
    if (!customerId && email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      if (list.data[0]) customerId = list.data[0].id;
    }

    // 3) Fallback: recent checkout session with metadata.uid
    if (!customerId) {
      try {
        const sessions = await stripe.checkout.sessions.search({
          query: `metadata['uid']:'${uid}' AND status:'complete'`,
          limit: 1,
        });
        const found = sessions.data[0]?.customer;
        if (found) customerId = typeof found === 'string' ? found : found?.id || null;
      } catch {}
    }

    if (!customerId) {
      return res.status(200).json({ status: 'no_customer' });
    }

    // Get latest relevant subscription (no deep expansions)
    const subs = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 5,
      expand: ['data.items.data.price'], // safe depth
    });

    const sub =
      subs.data.find(s =>
        ['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete'].includes(s.status)
      ) || null;

    if (!sub) {
      return res.status(200).json({ status: 'no_subscription', customerId, customerEmail: email || null });
    }

    const item = sub.items?.data?.[0] || null;
    const price = item?.price || null;

    const priceId = price?.id || null;
    const amount = typeof price?.unit_amount === 'number' ? price.unit_amount : null;
    const currency = price?.currency || null;
    const plan = priceId ? (PLAN_BY_PRICE[priceId] || price?.nickname || 'unknown') : 'unknown';

    return res.status(200).json({
      status: sub.status,
      plan,
      priceId,
      amount,
      currency,
      currentPeriodStart: sub.current_period_start,
      currentPeriodEnd: sub.current_period_end,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      cancelAt: sub.cancel_at || null,
      canceledAt: sub.canceled_at || null,
      endedAt: sub.ended_at || null,
      subscriptionId: sub.id,
      customerId,
      customerEmail: email || null,
    });
  } catch (e) {
    console.error('status-live error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
