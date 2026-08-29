/**
 * BarTalk v8.2.6 — authenticated file parsing API.
 *
 * The parser runs server-side because PDF/DOCX/XLSX libraries are too heavy
 * for the browser bundle. File parsing is intentionally restricted to signed-in
 * users: accepting arbitrary multi-megabyte documents from anonymous callers
 * makes this endpoint an easy CPU/memory denial-of-service target.
 */

import { applyCors, getAuthenticatedUser } from './_lib/security.js';

export const config = {
  api: { bodyParser: { sizeLimit: '12mb' } },
};

const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_EXCEL_BYTES = 3 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'xls']);

function safeFilename(value) {
  return String(value || 'file')
    .replace(/[\r\n\0]/g, '')
    .slice(0, 180);
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return null;

  // Support both raw base64 and data:...;base64,... values.
  const comma = value.indexOf(',');
  const encoded = value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value;

  // Reject obviously malformed input before Buffer.from's permissive decoder.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) return null;

  try {
    const buffer = Buffer.from(encoded, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const corsAllowed = applyCors(req, res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return corsAllowed ? res.status(204).end() : res.status(403).end();
  if (!corsAllowed) return res.status(403).json({ error: 'Origin not allowed' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { user } = await getAuthenticatedUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  const { filename, data, mimeType } = req.body || {};
  const cleanName = safeFilename(filename);

  if (!filename || !data) {
    return res.status(400).json({ error: 'filename e data (base64) richiesti' });
  }

  const ext = cleanName.split('.').pop()?.toLowerCase() || '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return res.status(400).json({ error: `Formato non supportato: .${ext || '?'}` });
  }

  const buffer = decodeBase64(data);
  if (!buffer) return res.status(400).json({ error: 'Dati file non validi' });

  const maxBytes = ext === 'xlsx' || ext === 'xls' ? MAX_EXCEL_BYTES : MAX_FILE_BYTES;
  if (buffer.length > maxBytes) {
    return res.status(413).json({
      error: `File troppo grande. Limite ${Math.floor(maxBytes / 1024 / 1024)} MB per .${ext}`,
    });
  }

  // The MIME type is informative only; browsers/clients can spoof it. We keep
  // it out of parser selection and use the validated extension instead.
  void mimeType;

  try {
    switch (ext) {
      case 'pdf': {
        const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
        const result = await pdfParse(buffer);
        return res.status(200).json({
          text: result.text?.trim() || '[PDF vuoto o non leggibile]',
          pages: result.numpages || 0,
        });
      }

      case 'docx': {
        const mammoth = await import('mammoth');
        const result = await mammoth.extractRawText({ buffer });
        return res.status(200).json({
          text: result.value?.trim() || '[DOCX vuoto o non leggibile]',
        });
      }

      case 'xlsx':
      case 'xls': {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, {
          type: 'buffer',
          cellFormula: false,
          cellHTML: false,
          cellStyles: false,
          cellNF: false,
        });
        const sheets = workbook.SheetNames.slice(0, 100);
        const textParts = [];

        for (const sheetName of sheets) {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) continue;
          const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) {
            // Bound response size even for highly-compressible spreadsheets.
            textParts.push(`--- Foglio: ${sheetName} ---\n${csv.slice(0, 500_000)}`);
          }
        }

        const text = textParts.join('\n\n').slice(0, 2_000_000);
        return res.status(200).json({
          text: text || '[Excel vuoto]',
          sheets,
        });
      }

      default:
        return res.status(400).json({ error: `Formato non supportato: .${ext}` });
    }
  } catch (err) {
    console.error(`[parse-file] Errore parsing ${cleanName}:`, err instanceof Error ? err.message : String(err));
    return res.status(422).json({
      error: `Impossibile leggere il file ${ext.toUpperCase()}`,
    });
  }
}
