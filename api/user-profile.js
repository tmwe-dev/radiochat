import { applyCors, getAuthenticatedUser, getSupabaseAdmin } from './_lib/security.js';

const ALLOWED_LANG_RE = /^[A-Za-z]{2,3}([_-][A-Za-z]{2,4})?$/;

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, PUT, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  const { user } = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Non autenticato' });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: 'Supabase non configurato' });

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('user_profiles')
      .select('id, email, display_name, access_mode, subscription_plan, onboarding_completed, language, created_at, updated_at')
      .eq('id', user.id)
      .maybeSingle();

    if (error) return res.status(500).json({ error: 'Errore lettura profilo' });
    if (!data) return res.status(404).json({ error: 'Profilo non trovato' });
    return res.status(200).json(data);
  }

  if (req.method === 'PUT') {
    const { display_name, language, onboarding_completed } = req.body || {};
    const updates = {};

    if (display_name !== undefined) {
      if (typeof display_name !== 'string' || display_name.trim().length > 120) {
        return res.status(400).json({ error: 'display_name non valido' });
      }
      updates.display_name = display_name.trim();
    }

    if (language !== undefined) {
      if (typeof language !== 'string' || !ALLOWED_LANG_RE.test(language)) {
        return res.status(400).json({ error: 'language non valida' });
      }
      updates.language = language;
    }

    if (onboarding_completed !== undefined) {
      if (typeof onboarding_completed !== 'boolean') {
        return res.status(400).json({ error: 'onboarding_completed deve essere boolean' });
      }
      updates.onboarding_completed = onboarding_completed;
    }

    // access_mode/subscription_plan are deliberately server-managed billing fields.
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nessun campo aggiornabile fornito' });
    }

    const { data, error } = await sb
      .from('user_profiles')
      .update(updates)
      .eq('id', user.id)
      .select('id, email, display_name, access_mode, subscription_plan, onboarding_completed, language, created_at, updated_at')
      .single();

    if (error) {
      console.error('[user-profile] Update error:', error.message);
      return res.status(500).json({ error: 'Errore aggiornamento profilo' });
    }
    return res.status(200).json(data);
  }

  return res.status(405).json({ error: 'Metodo non supportato' });
}
