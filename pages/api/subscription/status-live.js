// pages/api/subscription/status-live.js
import { stripe } from '@/lib/stripe/stripe';
import { authAdmin } from '@/lib/firebase/firebaseAdmin';

const PLAN_BY_PRICE = {
  [process.env.STRIPE_PRICE_BASIC]: 'Basic',
  [process.env.STRIPE_PRICE_PRO]: 'Pro',
  [process.env.STRIPE_PRICE_ELITE]: 'Elite',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Verify Firebase ID token
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing ID token' });

    const decoded = await authAdmin.verifyIdToken(token);
    const { uid, email } = decoded || {};

    // Find Stripe customer (metadata.uid first, fallback to email)
    let customer = null;
    try {
      const search = await stripe.customers.search({
        query: `metadata['uid']:"${uid}"`,
        limit: 1,
      });
      customer = search.data?.[0] || null;
    } catch (_) {}
    if (!customer && email) {
      const byEmail = await stripe.customers.list({ email, limit: 1 });
      customer = byEmail.data?.[0] || null;
    }
    if (!customer) return res.status(200).json({ status: 'no_customer' });

    // Only expand to price (NOT product) to stay within 4 levels
    const subs = await stripe.subscriptions.list({
      customer: customer.id,
      status: 'all',
      limit: 10,
      expand: ['data.items.data.price'],
    });

    if (!subs.data.length) {
      return res.status(200).json({
        status: 'no_subscription',
        customerEmail: customer.email || null,
      });
    }

    // Prefer active/trialing, else most recent
    const preferred =
      subs.data.find(s => ['active', 'trialing'].includes(s.status)) ||
      subs.data.sort((a, b) => b.created - a.created)[0];

    const item = preferred.items?.data?.[0] || null;
    const price = item?.price || null;

    const priceId = price?.id || null;
    const planName =
      (priceId && PLAN_BY_PRICE[priceId]) ||
      price?.nickname || // set a nickname on the Price in Stripe for a nice label
      'Unknown';

    const amount = typeof price?.unit_amount === 'number' ? price.unit_amount : null;

    return res.status(200).json({
      status: preferred.status,                    // 'active', 'trialing', etc.
      plan: planName,                              // 'Basic' / 'Pro' / 'Elite' / nickname
      priceId,                                     // Stripe price id
      amount,                                      // cents
      currency: price?.currency || 'usd',
      interval: price?.recurring?.interval || null,
      currentPeriodStart: preferred.current_period_start || null, // unix seconds
      currentPeriodEnd: preferred.current_period_end || null,     // unix seconds
      cancelAtPeriodEnd: !!preferred.cancel_at_period_end,
      customerEmail: customer.email || null,
    });
  } catch (e) {
    console.error('status-live error', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
