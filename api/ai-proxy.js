import { createDecipheriv } from 'node:crypto';
import { applyCors, getAuthenticatedUser, getClientIp, getSupabaseAdmin } from './_lib/security.js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const MAX_BODY_SIZE = 256 * 1024;
const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'groq', 'xai']);
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_USER = 60;
const RATE_LIMIT_PER_PROVIDER = 30;
const rateMap = new Map();

function decryptAPIKey(ciphertext) {
  if (!/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY) || typeof ciphertext !== 'string') return null;
  try {
    const [ivHex, authTagHex, encryptedHex] = ciphertext.split(':');
    if (!ivHex || !authTagHex || !encryptedHex) return null;
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(ENCRYPTION_KEY, 'hex'), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return decipher.update(Buffer.from(encryptedHex, 'hex')) + decipher.final('utf8');
  } catch (error) {
    console.error('[ai-proxy] Key decrypt failed:', error.message);
    return null;
  }
}

async function getKeyFromVault(userId, provider) {
  const sb = getSupabaseAdmin();
  if (!sb) return null;
  try {
    const { data: ws, error: wsError } = await sb
      .from('workspaces')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (wsError || !ws) return null;

    const { data: row, error } = await sb
      .from('api_keys_vault')
      .select('encrypted_key, model')
      .eq('workspace_id', ws.id)
      .eq('provider', provider)
      .maybeSingle();
    if (error || !row) return null;

    const apiKey = decryptAPIKey(row.encrypted_key);
    return apiKey ? { apiKey, model: row.model || null } : null;
  } catch (error) {
    console.warn('[ai-proxy] Vault lookup failed:', error.message);
    return null;
  }
}

function checkRate(key, limit) {
  const now = Date.now();
  const entry = rateMap.get(key);
  if (!entry || now - entry.startedAt >= RATE_WINDOW_MS) {
    rateMap.set(key, { startedAt: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

function mapUpstreamStatus(status) {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  if (status >= 500) return 502;
  if (status >= 400) return 400;
  return 502;
}

function validateInput(body) {
  const { provider, model, messages, systemPrompt, temperature, maxTokens, apiKey } = body || {};
  if (!VALID_PROVIDERS.has(provider)) return 'Invalid provider';
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) return 'Messages must be a non-empty array with at most 100 items';
  for (const message of messages) {
    if (!message || !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string') return 'Invalid message structure';
    if (message.content.length > 32768) return 'Message too long';
  }
  if (model != null && (typeof model !== 'string' || model.length > 120)) return 'Invalid model';
  if (systemPrompt != null && (typeof systemPrompt !== 'string' || systemPrompt.length > 16384)) return 'Invalid system prompt';
  if (temperature != null && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2)) return 'Invalid temperature';
  if (maxTokens != null && (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 1 || Number(maxTokens) > 16384)) return 'Invalid maxTokens';
  if (apiKey != null && (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512)) return 'Invalid API key';
  return null;
}

function normalizeMessages(messages) {
  return messages.map((message) => ({ role: message.role, content: String(message.content || '') }));
}

async function callAnthropic({ apiKey, model, messages, systemPrompt, temperature, maxTokens, tools }) {
  const compact = [];
  for (const message of normalizeMessages(messages).filter((m) => m.role !== 'system')) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (compact.length && compact[compact.length - 1].role === role) compact[compact.length - 1].content += `\n${message.content}`;
    else compact.push({ role, content: message.content });
  }
  if (!compact.length || compact[0].role !== 'user') compact.unshift({ role: 'user', content: 'Ciao' });

  const body = {
    model: model || process.env.ANTHROPIC_DEFAULT_MODEL || 'claude-sonnet-4-20250514',
    max_tokens: Number(maxTokens) || 2048,
    temperature: temperature == null ? 0.7 : Number(temperature),
    messages: compact,
    system: systemPrompt || 'Sei un assistente AI.',
  };
  if (Array.isArray(tools) && tools.length) body.tools = tools;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await upstreamError('Anthropic', response);
  const data = await response.json();
  return {
    content: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    tokensIn: data.usage?.input_tokens || 0,
    tokensOut: data.usage?.output_tokens || 0,
    stopReason: data.stop_reason,
    toolUseBlocks: (data.content || []).filter((b) => b.type === 'tool_use'),
  };
}

async function callOpenAICompatible({ provider, apiKey, model, messages, systemPrompt, temperature, maxTokens }) {
  const endpoints = {
    openai: 'https://api.openai.com/v1/chat/completions',
    groq: 'https://api.groq.com/openai/v1/chat/completions',
    xai: 'https://api.x.ai/v1/chat/completions',
  };
  const defaults = {
    openai: process.env.OPENAI_DEFAULT_MODEL || 'gpt-4o',
    groq: process.env.GROQ_DEFAULT_MODEL || 'llama-3.3-70b-versatile',
    xai: process.env.XAI_DEFAULT_MODEL || 'grok-3-mini',
  };
  const chat = [];
  if (systemPrompt) chat.push({ role: 'system', content: systemPrompt });
  for (const message of normalizeMessages(messages)) if (message.role !== 'system') chat.push(message);
  if (!chat.length) chat.push({ role: 'user', content: 'Ciao' });

  const response = await fetch(endpoints[provider], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: model || defaults[provider],
      messages: chat,
      temperature: temperature == null ? 0.7 : Number(temperature),
      max_tokens: Number(maxTokens) || 2048,
    }),
  });
  if (!response.ok) throw await upstreamError(provider, response);
  const data = await response.json();
  return {
    content: data.choices?.[0]?.message?.content || '',
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
  };
}

async function callGemini({ apiKey, model, messages, systemPrompt, temperature, maxTokens }) {
  const contents = [];
  for (const message of normalizeMessages(messages)) {
    if (message.role === 'system' || !message.content.trim()) continue;
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
  }
  if (!contents.length || contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: 'Ciao' }] });

  const merged = [];
  for (const message of contents) {
    const last = merged[merged.length - 1];
    if (last?.role === message.role) last.parts[0].text += `\n${message.parts[0].text}`;
    else merged.push(JSON.parse(JSON.stringify(message)));
  }

  const geminiModel = model || process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: merged,
    generationConfig: {
      maxOutputTokens: Number(maxTokens) || 2048,
      temperature: temperature == null ? 0.7 : Number(temperature),
    },
  };
  if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };

  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await upstreamError('Gemini', response);
  const data = await response.json();
  return {
    content: data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '',
    tokensIn: data.usageMetadata?.promptTokenCount || 0,
    tokensOut: data.usageMetadata?.candidatesTokenCount || 0,
    groundingMetadata: data.candidates?.[0]?.groundingMetadata,
  };
}

async function upstreamError(provider, response) {
  const text = await response.text();
  const error = new Error(`${provider} ${response.status}`);
  error.status = mapUpstreamStatus(response.status);
  error.detail = text.substring(0, 300);
  return error;
}

async function recordUsage(userId, result) {
  const sb = getSupabaseAdmin();
  if (!sb || !userId) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data } = await sb
      .from('usage_tracking')
      .select('id, messages_count, tokens_used')
      .eq('user_id', userId)
      .eq('period_start', today)
      .maybeSingle();
    if (data) {
      await sb.from('usage_tracking').update({
        messages_count: (data.messages_count || 0) + 1,
        tokens_used: (data.tokens_used || 0) + (result.tokensIn || 0) + (result.tokensOut || 0),
        updated_at: new Date().toISOString(),
      }).eq('id', data.id);
    } else {
      await sb.from('usage_tracking').insert({
        user_id: userId,
        period_start: today,
        messages_count: 1,
        tokens_used: (result.tokensIn || 0) + (result.tokensOut || 0),
      });
    }
  } catch (error) {
    console.warn('[ai-proxy] Usage tracking failed:', error.message);
  }
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, POST, OPTIONS', ['X-BT-Session', 'X-BT-Skip-Auth']);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ok', version: '8.2.6', providers: [...VALID_PROVIDERS], timestamp: new Date().toISOString() });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
  if (bodySize > MAX_BODY_SIZE) return res.status(413).json({ error: 'Request body too large' });

  const validationError = validateInput(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { user, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    // Never expose server-funded AI to skip/guest callers. This closes the
    // previous X-BT-Skip-Auth cost bypass while keeping the health endpoint public.
    return res.status(401).json({
      error: authError === 'missing_token' ? 'Authentication required for AI requests' : 'Invalid or expired auth token',
    });
  }

  const { provider, model: requestedModel, messages, systemPrompt, temperature, maxTokens, apiKey: clientApiKey, tools } = req.body;
  const clientIp = getClientIp(req);
  if (!checkRate(`user:${user.id}`, RATE_LIMIT_PER_USER) || !checkRate(`provider:${user.id}:${provider}`, RATE_LIMIT_PER_PROVIDER)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  // Secondary IP guard protects accounts sharing a compromised token.
  if (!checkRate(`ip:${clientIp}`, RATE_LIMIT_PER_USER * 2)) return res.status(429).json({ error: 'Rate limit exceeded' });

  let apiKey = clientApiKey || null;
  let model = requestedModel || null;
  if (!apiKey) {
    const vault = await getKeyFromVault(user.id, provider);
    if (vault) {
      apiKey = vault.apiKey;
      if (!model && vault.model) model = vault.model;
    }
  }

  if (!apiKey) {
    const serverKeys = {
      openai: process.env.OPENAI_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
      gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      groq: process.env.GROQ_API_KEY,
      xai: process.env.XAI_API_KEY,
    };
    apiKey = serverKeys[provider] || null;
  }
  if (!apiKey) return res.status(503).json({ error: `Provider ${provider} not configured` });

  const startedAt = Date.now();
  try {
    let result;
    const params = { provider, apiKey, model, messages, systemPrompt, temperature, maxTokens, tools };
    if (provider === 'anthropic') result = await callAnthropic(params);
    else if (provider === 'gemini') result = await callGemini(params);
    else result = await callOpenAICompatible(params);

    result.duration = Date.now() - startedAt;
    await recordUsage(user.id, result);
    return res.status(200).json(result);
  } catch (error) {
    console.error(`[ai-proxy] ${provider} error:`, error.message, error.detail || '');
    return res.status(error.status || 500).json({ error: error.message || 'AI provider error', provider });
  }
}
