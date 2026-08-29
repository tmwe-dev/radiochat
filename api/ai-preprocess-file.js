import { applyCors, getAuthenticatedUser } from './_lib/security.js';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const MAX_SOURCE_CHARS = 12000;

function buildCleanupPrompt(text, filename, fileType) {
  return `Sei un preprocessore di testo. RIORGANIZZA il testo estratto dal file ${String(fileType || '').toUpperCase()} ("${filename}") rendendolo leggibile e strutturato.\n\nREGOLE:\n1. NON inventare informazioni\n2. NON riassumere: mantieni il contenuto\n3. Rimuovi artefatti di parsing e header/footer ripetuti\n4. Correggi spacing e line break spezzati\n5. Preserva titoli, paragrafi, liste e tabelle\n6. Mantieni tutte le lingue presenti\n7. Rispondi SOLO con il testo riorganizzato\n\nTESTO ESTRATTO:\n${text.slice(0, MAX_SOURCE_CHARS)}`;
}

async function callAI(prompt) {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (geminiKey) {
    try {
      const model = process.env.GEMINI_PREPROCESS_MODEL || 'gemini-2.0-flash';
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
          }),
        },
      );
      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('');
        if (text) return text;
      } else {
        console.warn('[ai-preprocess] Gemini error:', response.status);
      }
    } catch (error) {
      console.warn('[ai-preprocess] Gemini fallback:', error.message);
    }
  }

  if (openaiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_PREPROCESS_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 8192,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return text;
      } else {
        console.warn('[ai-preprocess] OpenAI error:', response.status);
      }
    } catch (error) {
      console.warn('[ai-preprocess] OpenAI fallback:', error.message);
    }
  }

  return null;
}

function detectSections(text) {
  const sections = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (
      trimmed.length > 0 && trimmed.length < 100 &&
      (/^#{1,4}\s/.test(trimmed) || /^[A-Z][A-Z\s]{3,}$/.test(trimmed) || /^\d+\.\s+[A-Z]/.test(trimmed) || /^(Capitolo|Sezione|Parte|Chapter|Section|Part)\s/i.test(trimmed))
    ) {
      sections.push(trimmed.replace(/^#+\s*/, ''));
    }
  }
  return sections.length ? sections : undefined;
}

function basicClean(text) {
  return text
    .replace(/\f/g, '\n\n')
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim();
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { user, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    return res.status(401).json({
      error: authError === 'missing_token' ? 'Authentication required' : 'Invalid or expired auth token',
    });
  }

  const { text, filename, fileType } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || typeof filename !== 'string' || !filename.trim()) {
    return res.status(400).json({ error: 'text e filename richiesti' });
  }

  const simpleText = ['txt', 'md', 'csv'].includes(String(fileType || '').toLowerCase());
  if (simpleText || text.length < 200) {
    const cleaned = basicClean(text);
    return res.status(200).json({ text: cleaned, structured: false, sections: detectSections(cleaned) });
  }

  try {
    const enhanced = await callAI(buildCleanupPrompt(text, filename, fileType));
    if (enhanced) {
      return res.status(200).json({ text: enhanced, structured: true, sections: detectSections(enhanced) });
    }

    const cleaned = basicClean(text);
    return res.status(200).json({ text: cleaned, structured: false, sections: detectSections(cleaned) });
  } catch (error) {
    console.error('[ai-preprocess] Error:', error.message);
    const cleaned = basicClean(text);
    return res.status(200).json({ text: cleaned, structured: false });
  }
}
