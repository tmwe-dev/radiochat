import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let adminClient = null;

export function getSupabaseAdmin() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  if (!adminClient) {
    adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

export function getBearerToken(req) {
  const auth = req.headers?.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

/**
 * Verifies the access token with Supabase Auth. This deliberately does NOT
 * decode JWT payloads locally: Supabase may use asymmetric signing keys and
 * the signature must be cryptographically verified.
 */
export async function getAuthenticatedUser(req) {
  const token = getBearerToken(req);
  if (!token) return { user: null, token: null, error: 'missing_token' };

  const supabase = getSupabaseAdmin();
  if (!supabase) return { user: null, token, error: 'supabase_not_configured' };

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { user: null, token, error: 'invalid_token' };
    return { user, token, error: null };
  } catch {
    return { user: null, token, error: 'auth_unavailable' };
  }
}

function normalizeOrigin(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/\/$/, '');
}

function configuredOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
}

function requestHost(req) {
  const forwarded = req.headers?.['x-forwarded-host'];
  const host = Array.isArray(forwarded) ? forwarded[0] : (forwarded || req.headers?.host || '');
  return String(host).split(',')[0].trim().toLowerCase();
}

function isLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

/**
 * Accept explicit ALLOWED_ORIGINS plus the actual deployment host. This keeps
 * production and Vercel preview deployments working without hard-coded legacy
 * project names.
 */
export function getAllowedOrigin(req) {
  const origin = normalizeOrigin(req.headers?.origin || '');
  if (!origin) return null;

  if (configuredOrigins().includes(origin)) return origin;

  try {
    const parsed = new URL(origin);
    const host = requestHost(req);
    if (host && parsed.host.toLowerCase() === host) return origin;
  } catch {
    return null;
  }

  const vercelUrls = [
    process.env.VERCEL_URL,
    process.env.VERCEL_BRANCH_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ]
    .filter(Boolean)
    .map((host) => normalizeOrigin(`https://${host}`));
  if (vercelUrls.includes(origin)) return origin;

  if (process.env.NODE_ENV !== 'production' && isLocalOrigin(origin)) return origin;
  return null;
}

/**
 * Applies CORS headers and returns whether a browser Origin, when present, is
 * allowed. Requests with no Origin are not treated as authenticated by CORS;
 * protected endpoints must still perform token authentication.
 */
export function applyCors(req, res, methods = 'GET, POST, OPTIONS', extraHeaders = []) {
  const originHeader = req.headers?.origin || '';
  const origin = getAllowedOrigin(req);

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader(
    'Access-Control-Allow-Headers',
    ['Content-Type', 'Authorization', ...extraHeaders].join(', '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  return !originHeader || Boolean(origin);
}

export function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(raw || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}
