/**
 * RadioChat — authenticated ElevenLabs TTS proxy.
 * Server-side ElevenLabs credentials are never available to anonymous callers.
 */
import { applyCors, getAuthenticatedUser } from './_lib/security.js';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const MAX_TEXT_LENGTH = 10000;

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({
      error: authError === 'missing_token' ? 'Authentication required' : 'Invalid or expired auth token',
    });
  }

  if (!ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'TTS service not configured' });
  }

  try {
    const {
      text,
      voice_id = '21m00Tcm4TlvDq8ikWAM',
      model_id = 'eleven_multilingual_v2',
      voice_settings,
    } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or invalid text field' });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return res.status(413).json({ error: `Text too long. Max ${MAX_TEXT_LENGTH} characters.` });
    }
    if (typeof voice_id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(voice_id)) {
      return res.status(400).json({ error: 'Invalid voice_id' });
    }

    const response = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voice_id}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id,
        voice_settings: voice_settings || {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[tts-proxy] ElevenLabs error:', response.status, errText.substring(0, 300));
      const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
      return res.status(status).json({ error: 'TTS provider error' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    const buffer = Buffer.from(await response.arrayBuffer());
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('[tts-proxy] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
