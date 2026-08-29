import { createCipheriv, randomBytes } from 'node:crypto';
import { applyCors, getAuthenticatedUser, getSupabaseAdmin } from './_lib/security.js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '';
const VALID_PROVIDERS = new Set(['openai', 'anthropic', 'gemini', 'groq', 'xai']);

function getEncryptionKey() {
  if (!/^[0-9a-fA-F]{64}$/.test(ENCRYPTION_KEY)) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hexadecimal characters');
  }
  return Buffer.from(ENCRYPTION_KEY, 'hex');
}

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

async function resolveWorkspace(sb, userId) {
  const { data: existing, error } = await sb
    .from('workspaces')
    .select('id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (existing) return existing.id;

  // Recovery for accounts created before the workspace trigger existed.
  const { data: created, error: createError } = await sb
    .from('workspaces')
    .insert({ user_id: userId, name: 'Il mio workspace' })
    .select('id')
    .single();
  if (createError) throw createError;
  return created.id;
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  const { user, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({
      error: authError === 'missing_token' ? 'Authentication required' : 'Invalid or expired auth token',
    });
  }

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: 'Supabase server configuration missing' });

  try {
    const workspaceId = await resolveWorkspace(sb, user.id);

    if (req.method === 'GET') {
      const { data, error } = await sb
        .from('api_keys_vault')
        .select('provider, model, updated_at')
        .eq('workspace_id', workspaceId);
      if (error) throw error;
      return res.status(200).json({
        keys: (data || []).map((row) => ({
          provider: row.provider,
          model: row.model,
          hasKey: true,
          updatedAt: row.updated_at,
        })),
      });
    }

    if (req.method === 'POST') {
      const { provider, apiKey, model } = req.body || {};
      if (!VALID_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Invalid provider' });
      }
      if (typeof apiKey !== 'string' || apiKey.trim().length < 10 || apiKey.length > 512) {
        return res.status(400).json({ error: 'Invalid API key format' });
      }
      if (model != null && (typeof model !== 'string' || model.length > 120)) {
        return res.status(400).json({ error: 'Invalid model' });
      }

      const { error } = await sb.from('api_keys_vault').upsert({
        workspace_id: workspaceId,
        provider,
        encrypted_key: encrypt(apiKey.trim()),
        model: model || null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'workspace_id,provider' });
      if (error) throw error;

      return res.status(200).json({ success: true, provider });
    }

    if (req.method === 'DELETE') {
      const { provider } = req.body || {};
      if (!VALID_PROVIDERS.has(provider)) {
        return res.status(400).json({ error: 'Invalid provider' });
      }
      const { error } = await sb
        .from('api_keys_vault')
        .delete()
        .eq('workspace_id', workspaceId)
        .eq('provider', provider);
      if (error) throw error;
      return res.status(200).json({ success: true, provider });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[keys] Error:', error.message);
    return res.status(500).json({ error: 'Internal key-vault error' });
  }
}
