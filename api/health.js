// BarTalk v8.2.6 — health endpoint
// GET /api/health         -> cheap public liveness probe
// GET /api/health?deep=1  -> authenticated dependency diagnostics

import { createClient } from '@supabase/supabase-js';
import { applyCors, getAuthenticatedUser } from './_lib/security.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/models',
    keyEnv: 'OPENAI_API_KEY',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
  anthropic: {
    url: 'https://api.anthropic.com/v1/messages',
    keyEnv: 'ANTHROPIC_API_KEY',
    authHeader: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    // A GET may return 405 even when the provider is healthy/reachable.
    expectStatus: [200, 405],
  },
  gemini: {
    keyEnv: 'GOOGLE_API_KEY',
    urlFn: (key) => `https://generativelanguage.googleapis.com/v1/models?key=${key}`,
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    keyEnv: 'GROQ_API_KEY',
    authHeader: (key) => ({ Authorization: `Bearer ${key}` }),
  },
};

async function checkDB() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { status: 'not_configured' };

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const start = Date.now();
    const { error } = await sb.from('workspaces').select('id').limit(1);
    const latency = Date.now() - start;
    return error ? { status: 'error', latency } : { status: 'ok', latency };
  } catch {
    return { status: 'error' };
  }
}

async function checkProvider(name) {
  const cfg = PROVIDERS[name];
  const key = process.env[cfg.keyEnv];
  if (!key) return { status: 'not_configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const start = Date.now();
    const url = cfg.urlFn ? cfg.urlFn(key) : cfg.url;
    const headers = cfg.authHeader ? cfg.authHeader(key) : {};
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    const latency = Date.now() - start;
    const expected = cfg.expectStatus || [200];
    return {
      status: response.ok || expected.includes(response.status) ? 'ok' : 'degraded',
      httpStatus: response.status,
      latency,
    };
  } catch (error) {
    return {
      status: error?.name === 'AbortError' ? 'timeout' : 'error',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return corsAllowed ? res.status(204).end() : res.status(403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const deep = req.query?.deep === '1' || req.query?.deep === 'true';

  // Public endpoint is deliberately minimal. It proves the deployment is alive
  // without advertising which credentials/services are configured and without
  // hitting every external provider on each monitoring request.
  if (!deep) {
    return res.status(200).json({
      status: 'ok',
      version: '8.2.6',
      timestamp: new Date().toISOString(),
    });
  }

  const { user } = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const start = Date.now();
  const [database, openai, anthropic, gemini, groq] = await Promise.all([
    checkDB(),
    checkProvider('openai'),
    checkProvider('anthropic'),
    checkProvider('gemini'),
    checkProvider('groq'),
  ]);

  const providers = { openai, anthropic, gemini, groq };
  const statuses = [database.status, ...Object.values(providers).map((entry) => entry.status)];
  const unhealthy = statuses.some((status) => status === 'error' || status === 'timeout');
  const degraded = statuses.some((status) => status === 'degraded');

  return res.status(unhealthy ? 503 : 200).json({
    status: unhealthy ? 'unhealthy' : degraded ? 'degraded' : 'healthy',
    version: '8.2.6',
    timestamp: new Date().toISOString(),
    totalLatency: Date.now() - start,
    database,
    providers,
  });
}
