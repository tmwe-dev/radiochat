import { applyCors, getAuthenticatedUser, getSupabaseAdmin } from './_lib/security.js';

const VALID_SENDER_TYPES = new Set(['human', 'assistant', 'system']);
const MAX_CONTENT = 50000;

async function ownedConversation(sb, id, userId) {
  const { data, error } = await sb
    .from('chat_laboratory_conversations')
    .select('id, message_count')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });

  const { user } = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Non autenticato' });

  const sb = getSupabaseAdmin();
  if (!sb) return res.status(503).json({ error: 'Supabase non configurato' });

  const { id, action } = req.query || {};

  try {
    if (req.method === 'GET') {
      if (id) {
        const { data: conversation, error } = await sb
          .from('chat_laboratory_conversations')
          .select('*')
          .eq('id', id)
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) throw error;
        if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

        const { data: messages, error: msgError } = await sb
          .from('chat_laboratory_messages')
          .select('*')
          .eq('conversation_id', id)
          .eq('user_id', user.id)
          .order('created_at', { ascending: true });
        if (msgError) throw msgError;
        return res.status(200).json({ conversation, messages: messages || [] });
      }

      const { data, error } = await sb
        .from('chat_laboratory_conversations')
        .select('id, title, mode, message_count, created_at, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return res.status(200).json({ conversations: data || [] });
    }

    if (req.method === 'POST' && action === 'message') {
      const { conversation_id, sender_type, sender_name, agent_id, content, model, tokens_used, latency_ms } = req.body || {};
      if (typeof conversation_id !== 'string' || !VALID_SENDER_TYPES.has(sender_type) || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'Campi messaggio non validi' });
      }

      // Required because the admin/service client bypasses RLS.
      const conversation = await ownedConversation(sb, conversation_id, user.id);
      if (!conversation) return res.status(404).json({ error: 'Conversazione non trovata' });

      const { data, error } = await sb
        .from('chat_laboratory_messages')
        .insert({
          conversation_id,
          user_id: user.id,
          sender_type,
          sender_name: typeof sender_name === 'string' ? sender_name.slice(0, 120) : null,
          agent_id: typeof agent_id === 'string' ? agent_id.slice(0, 120) : null,
          content: content.slice(0, MAX_CONTENT),
          model: typeof model === 'string' ? model.slice(0, 120) : null,
          tokens_used: Number.isFinite(Number(tokens_used)) ? Number(tokens_used) : null,
          latency_ms: Number.isFinite(Number(latency_ms)) ? Number(latency_ms) : null,
        })
        .select()
        .single();
      if (error) throw error;

      await sb
        .from('chat_laboratory_conversations')
        .update({ message_count: (conversation.message_count || 0) + 1 })
        .eq('id', conversation_id)
        .eq('user_id', user.id);

      return res.status(201).json(data);
    }

    if (req.method === 'POST') {
      const { title, mode, composed_prompt_id } = req.body || {};
      const { data, error } = await sb
        .from('chat_laboratory_conversations')
        .insert({
          user_id: user.id,
          title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 250) : 'Nuova conversazione',
          mode: typeof mode === 'string' && mode ? mode.slice(0, 80) : 'consultation',
          composed_prompt_id: composed_prompt_id || null,
        })
        .select()
        .single();
      if (error) throw error;
      return res.status(201).json(data);
    }

    if (req.method === 'PUT') {
      const { conversation_id, title, cumulative_summary, mode } = req.body || {};
      if (typeof conversation_id !== 'string') return res.status(400).json({ error: 'conversation_id richiesto' });
      if (!await ownedConversation(sb, conversation_id, user.id)) return res.status(404).json({ error: 'Conversazione non trovata' });

      const updates = {};
      if (title !== undefined) updates.title = String(title).slice(0, 250);
      if (cumulative_summary !== undefined) updates.cumulative_summary = String(cumulative_summary).slice(0, 50000);
      if (mode !== undefined) updates.mode = String(mode).slice(0, 80);
      if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nessun campo aggiornabile' });

      const { data, error } = await sb
        .from('chat_laboratory_conversations')
        .update(updates)
        .eq('id', conversation_id)
        .eq('user_id', user.id)
        .select()
        .single();
      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      if (typeof id !== 'string') return res.status(400).json({ error: 'id richiesto' });
      if (!await ownedConversation(sb, id, user.id)) return res.status(404).json({ error: 'Conversazione non trovata' });
      const { error } = await sb
        .from('chat_laboratory_conversations')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Metodo non supportato' });
  } catch (error) {
    console.error('[conversations] Error:', error.message);
    return res.status(500).json({ error: 'Errore interno conversazioni' });
  }
}
