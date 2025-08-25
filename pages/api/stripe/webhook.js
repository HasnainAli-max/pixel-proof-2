// pages/api/stripe/webhook.js
import { buffer } from 'micro';
import { stripe } from '@/lib/stripe/stripe';
import { db, FieldValue, Timestamp } from '@/lib/firebase/firebaseAdmin';

export const config = { api: { bodyParser: false } };

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const PLAN_BY_PRICE = {
  [process.env.STRIPE_PRICE_BASIC]: 'basic',
  [process.env.STRIPE_PRICE_PRO]: 'pro',
  [process.env.STRIPE_PRICE_ELITE]: 'elite',
};

function toTs(secOrMs) {
  if (!secOrMs) return null;
  const ms = secOrMs > 1e12 ? secOrMs : secOrMs * 1000;
  return Timestamp.fromMillis(ms);
}

async function logStripeEvent({ event, rawLength, hint = {}, uid = null }) {
  const obj = event?.data?.object || {};
  const isSubObject = obj?.object === 'subscription';

  const logDoc = {
    id: event.id,
    type: event.type,
    created: event.created ? Timestamp.fromMillis(event.created * 1000) : FieldValue.serverTimestamp(),
    livemode: !!event.livemode,
    apiVersion: event.api_version || null,
    requestId: event.request?.id || null,
    objectType: obj?.object || null,
    stripeCustomerId: obj?.customer || null,
    subscriptionId: isSubObject ? obj?.id : obj?.subscription || null,
    checkoutSessionId: obj?.object === 'checkout.session' ? obj?.id : null,
    uid: uid || null,
    rawSizeBytes: rawLength || null,
    hint,
    receivedAt: FieldValue.serverTimestamp(),
  };

  await db.collection('stripeEvents').doc(event.id).set(logDoc, { merge: true });
}

async function writeFromSubscriptionEvent(subscription) {
  const customerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || subscription.customer || null;

  let uidFromMetadata = null;
  let customerEmail = null;
  let customerName = null;
  let customerAddress = null;

  if (customerId) {
    try {
      const cust = await stripe.customers.retrieve(customerId);
      uidFromMetadata = cust?.metadata?.uid || null;
      customerEmail = cust?.email || null;
      customerName = cust?.name || null;
      customerAddress = cust?.address || null;
    } catch {}
  }

  const item = subscription.items?.data?.[0] || null;
  const price = item?.price || null;
  const priceId = price?.id || null;
  const plan = priceId ? (PLAN_BY_PRICE[priceId] || price?.nickname || 'unknown') : 'unknown';

  const payload = {
    stripeCustomerId: customerId || null,
    subscriptionId: subscription.id,
    priceId,
    activePlan: plan,
    subscriptionStatus: subscription.status,             // <- 'canceled' will be written here
    currentPeriodStart: toTs(subscription.current_period_start),
    currentPeriodEnd: toTs(subscription.current_period_end),
    cancelAtPeriodEnd: !!subscription.cancel_at_period_end,
    cancelAt: toTs(subscription.cancel_at),
    canceledAt: toTs(subscription.canceled_at),
    endedAt: toTs(subscription.ended_at),
    currency: price?.currency || null,
    amount: typeof price?.unit_amount === 'number' ? price.unit_amount : null,
    productId: price?.product || null,
    ...(customerEmail || customerName || customerAddress
      ? { stripeCustomer: { email: customerEmail, name: customerName, address: customerAddress } }
      : {}),
    updatedAt: FieldValue.serverTimestamp(),
  };

  if (uidFromMetadata) {
    await db.collection('users').doc(uidFromMetadata).set(payload, { merge: true });
    return uidFromMetadata;
  }

  if (customerId) {
    const q = await db.collection('users')
      .where('stripeCustomerId', '==', customerId)
      .limit(1)
      .get();

    if (!q.empty) {
      const uid = q.docs[0].id;
      await db.collection('users').doc(uid).set(payload, { merge: true });
      return uid;
    }
  }

  await db.collection('stripeOrphans').doc(String(subscription.id)).set({
    reason: 'No user doc with this stripeCustomerId and no customer.metadata.uid',
    customerId: customerId || null,
    status: subscription.status,
    createdAt: FieldValue.serverTimestamp(),
  });

  return null;
}

async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription') return { note: 'ignored non-subscription session' };

  const uid = session.metadata?.uid || null;
  const customerId = typeof session.customer === 'string' ? session.customer : null;
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : null;

  if (uid && customerId) {
    try {
      const current = await stripe.customers.retrieve(customerId);
      const nextMeta = { ...(current?.metadata || {}), uid };
      await stripe.customers.update(customerId, { metadata: nextMeta });
    } catch {}

    const customerDetails = session.customer_details || {};
    await db.collection('users').doc(uid).set(
      {
        stripeCustomerId: customerId,
        lastCheckoutSessionId: session.id,
        stripeCustomer: {
          email: customerDetails.email || null,
          name: customerDetails.name || null,
          address: customerDetails.address || null,
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  if (subscriptionId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['items.data.price'] });
      await writeFromSubscriptionEvent(sub);
    } catch (e) {
      console.warn('[webhook] could not retrieve subscription immediately:', e.message);
    }
  }

  return { uid, customerId, subscriptionId };
}

async function parseStripeEvent(req) {
  const sig = req.headers['stripe-signature'];
  const buf = await buffer(req);

  const parsedFromEnv = (WEBHOOK_SECRET || '').trim();
  const secrets = parsedFromEnv
    ? parsedFromEnv.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  for (const secret of secrets) {
    try {
      const ev = stripe.webhooks.constructEvent(buf, sig, secret);
      return { event: ev, rawLength: buf.length, verifiedWith: secret };
    } catch {}
  }

  const allowInsecure =
    process.env.DEV_WEBHOOK_NO_VERIFY === 'true' || process.env.NODE_ENV !== 'production';

  if (allowInsecure) {
    const ev = JSON.parse(buf.toString('utf8'));
    return { event: ev, rawLength: buf.length, verifiedWith: null, insecure: true };
  }

  throw new Error(
    secrets.length === 0
      ? 'Missing STRIPE_WEBHOOK_SECRET in environment.'
      : 'Webhook signature verification failed.'
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { event, rawLength } = await parseStripeEvent(req);
    const { type } = event;

    // Very visible in terminal:
    console.log('🔔 Stripe webhook:', type);

    await logStripeEvent({ event, rawLength });

    // Subscription lifecycle: created/updated/deleted
    if (
      type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted'
    ) {
      try {
        const subscription = event.data.object;
        console.log('   → sub id:', subscription.id, 'status:', subscription.status);
        await writeFromSubscriptionEvent(subscription);
      } catch (innerErr) {
        console.error('[handler] sub-event write failed:', innerErr?.stack || innerErr?.message || innerErr);
        return res.status(200).json({ received: true, noted: 'sub write failed (see logs)' });
      }
    }

    // Checkout session completed: link customer ↔ uid and hydrate sub once
    if (type === 'checkout.session.completed') {
      const session = event.data.object;
      const result = await handleCheckoutCompleted(session);

      await logStripeEvent({
        event,
        rawLength,
        uid: result?.uid || null,
        hint: { mappedFrom: 'checkout.session.completed' },
      });
    }

    // Optional noise reduction: just log these
    if (type === 'invoice.payment_failed' || type === 'customer.subscription.trial_will_end') {
      // no-op for now
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('[webhook] top-level error:', err?.stack || err?.message || err);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
}
