import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSupabaseAdmin } from './_lib/security.js';

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SIGNATURE_TOLERANCE_SECONDS = 300;

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseStripeSignature(header) {
  const parts = String(header || '').split(',');
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

function verifyStripeSignature(rawBody, header) {
  if (!STRIPE_WEBHOOK_SECRET) throw new Error('Stripe webhook secret not configured');
  const { timestamp, signatures } = parseStripeSignature(header);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const payload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return signatures.some((signature) => {
    try {
      const actualBuffer = Buffer.from(signature, 'utf8');
      return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
    } catch {
      return false;
    }
  });
}

async function resolvePlanByPrice(sb, priceId, metadataPlan) {
  if (metadataPlan && ['free', 'base', 'pro', 'enterprise'].includes(metadataPlan)) return metadataPlan;
  if (!priceId) return null;

  const { data } = await sb
    .from('billing_plans')
    .select('id')
    .or(`stripe_price_id_monthly.eq.${priceId},stripe_price_id_yearly.eq.${priceId}`)
    .maybeSingle();
  return data?.id || null;
}

async function findUserForSubscription(sb, subscriptionId, customerId, metadataUserId) {
  if (metadataUserId) return metadataUserId;

  if (subscriptionId) {
    const { data } = await sb
      .from('stripe_subscriptions')
      .select('user_id')
      .eq('stripe_subscription_id', subscriptionId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  if (customerId) {
    const { data } = await sb
      .from('stripe_customers')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    if (data?.user_id) return data.user_id;
  }

  return null;
}

async function upsertSubscription(sb, sub) {
  const priceId = sub.items?.data?.[0]?.price?.id || sub.metadata?.price_id || '';
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const userId = await findUserForSubscription(sb, sub.id, customerId, sub.metadata?.user_id);
  if (!userId || !customerId || !priceId) {
    throw new Error(`Subscription ${sub.id} missing user/customer/price mapping`);
  }

  const plan = await resolvePlanByPrice(sb, priceId, sub.metadata?.plan_id);
  if (!plan) throw new Error(`Unknown Stripe price ${priceId}`);

  const row = {
    user_id: userId,
    stripe_subscription_id: sub.id,
    stripe_customer_id: customerId,
    price_id: priceId,
    plan,
    status: sub.status || 'active',
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    trial_start: sub.trial_start ? new Date(sub.trial_start * 1000).toISOString() : null,
    trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    metadata: sub.metadata || {},
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('stripe_subscriptions')
    .upsert(row, { onConflict: 'stripe_subscription_id' });
  if (error) throw error;

  const active = ['active', 'trialing'].includes(row.status);
  await sb
    .from('user_profiles')
    .update({ subscription_plan: active ? plan : 'free' })
    .eq('id', userId);
}

async function markWebhookEvent(sb, event, processed, errorMessage = null) {
  const payload = {
    stripe_event_id: event.id,
    event_type: event.type,
    data: event.data || {},
    processed,
    error_message: errorMessage,
  };
  const { data: existing } = await sb
    .from('stripe_webhook_events')
    .select('id')
    .eq('stripe_event_id', event.id)
    .maybeSingle();

  if (existing?.id) {
    await sb.from('stripe_webhook_events').update(payload).eq('id', existing.id);
  } else {
    await sb.from('stripe_webhook_events').insert(payload);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: 'Supabase server configuration missing' });
  if (!STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Stripe webhook not configured' });

  let event;
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    if (!verifyStripeSignature(rawBody, signature)) {
      return res.status(400).json({ error: 'Invalid Stripe signature' });
    }
    event = JSON.parse(rawBody.toString('utf8'));
    if (!event?.id || !event?.type || !event?.data?.object) {
      return res.status(400).json({ error: 'Invalid Stripe event' });
    }

    const { data: alreadyProcessed } = await sb
      .from('stripe_webhook_events')
      .select('processed')
      .eq('stripe_event_id', event.id)
      .maybeSingle();
    if (alreadyProcessed?.processed) return res.status(200).json({ received: true, duplicate: true });

    const object = event.data.object;
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await upsertSubscription(sb, object);
        break;

      case 'customer.subscription.deleted': {
        const userId = await findUserForSubscription(
          sb,
          object.id,
          typeof object.customer === 'string' ? object.customer : object.customer?.id,
          object.metadata?.user_id,
        );
        await sb
          .from('stripe_subscriptions')
          .update({ status: 'canceled', canceled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', object.id);
        if (userId) await sb.from('user_profiles').update({ subscription_plan: 'free' }).eq('id', userId);
        break;
      }

      case 'invoice.payment_failed': {
        const subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
        if (subscriptionId) {
          await sb
            .from('stripe_subscriptions')
            .update({ status: 'past_due', updated_at: new Date().toISOString() })
            .eq('stripe_subscription_id', subscriptionId);
        }
        break;
      }

      case 'checkout.session.completed': {
        const userId = object.metadata?.user_id || null;
        const customerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
        if (userId && customerId) {
          await sb.from('stripe_customers').upsert({
            user_id: userId,
            stripe_customer_id: customerId,
            email: object.customer_details?.email || object.customer_email || null,
            name: object.customer_details?.name || null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'stripe_customer_id' });
        }
        break;
      }

      default:
        break;
    }

    await markWebhookEvent(sb, event, true);
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[stripe-webhook] Error:', error.message);
    if (event?.id) await markWebhookEvent(sb, event, false, error.message).catch(() => {});
    return res.status(400).json({ error: 'Webhook processing failed' });
  }
}
