import { applyCors, getAuthenticatedUser, getSupabaseAdmin } from './_lib/security.js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_API = 'https://api.stripe.com/v1';

const CLIENT_TO_DB_PLAN = { pro: 'base', unlimited: 'pro' };
const DB_TO_CLIENT_TIER = { free: 'free', base: 'pro', pro: 'unlimited', enterprise: 'unlimited' };

async function stripePost(path, params) {
  if (!STRIPE_SECRET_KEY) throw new Error('Stripe secret key not configured');
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.append(key, String(value));
  }
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Stripe ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function getOrCreateCustomer(sb, user) {
  const { data: existing } = await sb
    .from('stripe_customers')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripePost('/customers', {
    email: user.email || undefined,
    'metadata[user_id]': user.id,
  });
  const { error } = await sb.from('stripe_customers').upsert({
    user_id: user.id,
    stripe_customer_id: customer.id,
    email: user.email || null,
    name: user.user_metadata?.display_name || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
  return customer.id;
}

function appOrigin(req) {
  const origin = String(req.headers?.origin || '').replace(/\/$/, '');
  if (origin) return origin;
  const host = req.headers?.['x-forwarded-host'] || req.headers?.host;
  return host ? `https://${String(host).split(',')[0].trim()}` : '';
}

async function getStatus(sb, userId) {
  const { data: subscription } = await sb
    .from('stripe_subscriptions')
    .select('plan, status, current_period_end, cancel_at_period_end')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing', 'past_due'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: profile } = await sb
    .from('user_profiles')
    .select('subscription_plan')
    .eq('id', userId)
    .maybeSingle();

  const dbPlan = subscription?.plan || profile?.subscription_plan || 'free';
  const tier = DB_TO_CLIENT_TIER[dbPlan] || 'free';

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data: usageRows } = await sb
    .from('usage_tracking')
    .select('messages_count, tokens_used, period_start')
    .eq('user_id', userId)
    .gte('period_start', monthStart.toISOString().slice(0, 10));

  const messagesUsed = (usageRows || []).reduce((sum, row) => sum + (row.messages_count || 0), 0);
  const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

  return {
    tier,
    status: subscription?.status || 'none',
    usage: {
      messagesUsed,
      // The DB models per-conversation + monthly conversation quotas, not a single
      // monthly message quota. Do not manufacture a misleading hard limit here.
      messagesLimit: null,
      limitPeriod: 'month',
      resetAt: nextMonth.toISOString(),
      costBreakdown: [],
    },
  };
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: 'Supabase non configurato' });
  const action = String(req.query?.action || 'status');

  if (req.method === 'GET' && action === 'plans') {
    const { data, error } = await sb
      .from('billing_plans')
      .select('id, name, description, price_monthly, price_yearly, features, max_conversations_per_month, max_messages_per_conversation, max_agents, voice_enabled, is_active, order_index')
      .eq('is_active', true)
      .order('order_index');
    if (error) return res.status(500).json({ error: 'Errore lettura piani' });
    return res.status(200).json({ plans: data || [] });
  }

  const { user } = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Non autenticato' });

  try {
    if (req.method === 'GET' && action === 'status') {
      return res.status(200).json(await getStatus(sb, user.id));
    }

    if (req.method === 'POST' && action === 'checkout') {
      const tier = req.body?.tier;
      const dbPlan = CLIENT_TO_DB_PLAN[tier];
      if (!dbPlan) return res.status(400).json({ error: 'Piano checkout non valido' });

      const { data: plan, error } = await sb
        .from('billing_plans')
        .select('id, stripe_price_id_monthly, is_active')
        .eq('id', dbPlan)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      if (!plan?.stripe_price_id_monthly) {
        return res.status(503).json({ error: `Stripe price non configurato per il piano ${dbPlan}` });
      }

      const customerId = await getOrCreateCustomer(sb, user);
      const origin = appOrigin(req);
      if (!origin) return res.status(400).json({ error: 'Impossibile determinare URL applicazione' });

      const session = await stripePost('/checkout/sessions', {
        mode: 'subscription',
        customer: customerId,
        'line_items[0][price]': plan.stripe_price_id_monthly,
        'line_items[0][quantity]': 1,
        success_url: `${origin}/billing?checkout=success`,
        cancel_url: `${origin}/billing?checkout=cancelled`,
        'metadata[user_id]': user.id,
        'metadata[plan_id]': dbPlan,
        'metadata[price_id]': plan.stripe_price_id_monthly,
        'subscription_data[metadata][user_id]': user.id,
        'subscription_data[metadata][plan_id]': dbPlan,
        'subscription_data[metadata][price_id]': plan.stripe_price_id_monthly,
      });
      return res.status(200).json({ url: session.url });
    }

    if (req.method === 'POST' && action === 'portal') {
      const { data: customer } = await sb
        .from('stripe_customers')
        .select('stripe_customer_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (!customer?.stripe_customer_id) return res.status(404).json({ error: 'Cliente Stripe non trovato' });

      const origin = appOrigin(req);
      const session = await stripePost('/billing_portal/sessions', {
        customer: customer.stripe_customer_id,
        return_url: `${origin}/billing`,
      });
      return res.status(200).json({ url: session.url });
    }

    return res.status(405).json({ error: 'Metodo/azione non supportato' });
  } catch (error) {
    console.error('[billing] Error:', error.message);
    return res.status(error.status === 429 ? 429 : 500).json({ error: 'Errore billing' });
  }
}
