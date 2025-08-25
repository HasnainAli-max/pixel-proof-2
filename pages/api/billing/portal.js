// pages/api/billing/portal.js
import { stripe } from '@/lib/stripe/stripe';
import { authAdmin } from '@/lib/firebase/firebaseAdmin';

const RETURN_URL =
  process.env.NEXT_PUBLIC_UTILITY_URL ||
  process.env.PORTAL_RETURN_URL ||
  `${process.env.APP_URL || 'https://pixel-proof-2-renu.vercel.app'}/utility`;

const PICKABLE_SUB_STATUSES = [
  'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'canceled'
];

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // 1) Verify Firebase ID token
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing ID token' });

    const { uid, email } = await authAdmin.verifyIdToken(token);

    // 2) Resolve Stripe customer for this user
    let customerId = null;

    // (a) by metadata.uid (best)
    try {
      const srch = await stripe.customers.search({
        query: `metadata['uid']:'${uid}'`,
        limit: 1,
      });
      if (srch.data[0]) customerId = srch.data[0].id;
    } catch {}

    // (b) by email
    if (!customerId && email) {
      const list = await stripe.customers.list({ email, limit: 1 });
      if (list.data[0]) customerId = list.data[0].id;
    }

    // (c) by recent completed checkout session that carried metadata.uid
    if (!customerId) {
      try {
        const sessions = await stripe.checkout.sessions.search({
          query: `metadata['uid']:'${uid}' AND status:'complete'`,
          limit: 1,
        });
        const cust = sessions.data[0]?.customer;
        if (typeof cust === 'string') customerId = cust;
        else if (cust?.id) customerId = cust.id;
      } catch {}
    }

    // (d) if still none, create a customer and stamp uid
    if (!customerId) {
      const cust = await stripe.customers.create({
        email: email || undefined,
        metadata: { uid },
      });
      customerId = cust.id;
    } else {
      // ensure metadata.uid is present for future webhook mapping
      try {
        const current = await stripe.customers.retrieve(customerId);
        const meta = current?.metadata || {};
        if (!meta.uid) {
          await stripe.customers.update(customerId, { metadata: { ...meta, uid } });
        }
      } catch {}
    }

    // 3) Try to get a subscription id for guided flows
    let subId = null;
    try {
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 5,
        expand: ['data.items.data.price'], // safe expansion level
      });
      const chosen =
        subs.data.find(s => PICKABLE_SUB_STATUSES.includes(s.status)) ||
        subs.data[0] || null;
      if (chosen) subId = chosen.id;
    } catch {}

    // 4) Read intent from body: "update" | "cancel" | undefined
    const { intent } = (req.body || {});

    // Base params (always include a return url)
    const baseParams = {
      customer: customerId,
      return_url: `${RETURN_URL}?from=portal`,
    };

    // If supported by your Stripe API version, use flow_data to:
    // - Open a specific flow (update/cancel)
    // - Auto-redirect back to RETURN_URL after completion
    let params = { ...baseParams };

    if (intent === 'cancel' && subId) {
      params = {
        ...baseParams,
        flow_data: {
          type: 'subscription_cancel',
          after_completion: { type: 'redirect', redirect: { return_url: RETURN_URL } },
          subscription_cancel: { subscription: subId },
        },
      };
    } else if (intent === 'update' && subId) {
      params = {
        ...baseParams,
        flow_data: {
          type: 'subscription_update',
          after_completion: { type: 'redirect', redirect: { return_url: RETURN_URL } },
          subscription_update: { subscription: subId },
        },
      };
    }

    // 5) Create session; if flow_data not supported, fall back to generic session
    let session;
    try {
      session = await stripe.billingPortal.sessions.create(params);
    } catch (e) {
      // Fallback for older API versions: still returns to /utility (manual "Return" link)
      session = await stripe.billingPortal.sessions.create(baseParams);
    }

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('billing/portal error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
}
