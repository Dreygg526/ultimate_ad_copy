import 'server-only';
import { GoogleGenAI } from '@google/genai';
import mammoth from 'mammoth';
import { ACCEPTED_EXTENSIONS } from '@/lib/doc-formats';

// Re-exported so server callers can keep importing everything doc-related from
// one place; the client imports these from lib/doc-formats directly.
export { ACCEPTED_EXTENSIONS, ACCEPT_ATTR, isAcceptedFile } from '@/lib/doc-formats';

/**
 * Brand research docs → plain text, for the rebuild prompt.
 *
 * Nothing generates without brand grounding (CLAUDE.md hard constraint 3), and
 * grounding is only as good as what we can read out of the doc. A doc that
 * extracts to nothing is worse than no doc: it satisfies the DB's
 * rebuild_must_be_grounded check while contributing no actual brand context, so
 * extraction failures are thrown, never swallowed.
 *
 * Routing is per format because Gemini's document support is narrower than its
 * docs imply — verified against the live API on 2026-07-16:
 *
 *   application/pdf   → accepted
 *   text/plain        → accepted
 *   text/markdown     → accepted
 *   .docx / .doc      → "Unsupported MIME type" — rejected outright
 *
 * So DOCX goes through mammoth locally. Don't "simplify" this by handing a
 * .docx to Gemini; it 400s.
 */

// Pinned, not an alias — an alias would change extraction with nothing in the
// repo changing. If this 404s, the
// preview retired; repoint it here.
const EXTRACT_MODEL = 'gemini-3.1-pro-preview';

const PROMPT = `Transcribe this document to plain text.

Return the document's own words, in reading order, and nothing else. Do not
summarise, do not comment, do not add headings that aren't there, and do not
prefix your answer with anything. Keep paragraph breaks. If the document is
scanned or handwritten, read it as best you can. Tables: read them row by row.`;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

async function extractPdf(bytes: Buffer): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: EXTRACT_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'application/pdf', data: bytes.toString('base64') } },
          { text: PROMPT },
        ],
      },
    ],
  });

  const text = res.text;
  if (!text) throw new Error('Gemini read nothing out of that PDF.');
  return text;
}

async function extractDocx(bytes: Buffer): Promise<string> {
  // Gemini rejects .docx, so this one is parsed locally. Raw text, not HTML —
  // the rebuild prompt wants prose, not markup.
  const { value } = await mammoth.extractRawText({ buffer: bytes });
  return value;
}

export interface Extraction {
  text: string;
  /** How it was read, for the UI. Buyers should know when a model was involved. */
  method: string;
}

export async function extractText(filename: string, bytes: Buffer): Promise<Extraction> {
  if (bytes.byteLength === 0) throw new Error('That file is empty.');

  const ext = extensionOf(filename);
  let text: string;
  let method: string;

  switch (ext) {
    case '.pdf':
      text = await extractPdf(bytes);
      method = EXTRACT_MODEL;
      break;
    case '.docx':
      text = await extractDocx(bytes);
      method = 'mammoth';
      break;
    case '.txt':
    case '.md':
      text = bytes.toString('utf8');
      method = 'read directly';
      break;
    default:
      throw new Error(`Can't read ${ext || 'that'} — accepts ${ACCEPTED_EXTENSIONS.join(', ')}.`);
  }

  const trimmed = text.trim();
  // A doc that yields a handful of characters is almost always a failed read
  // (an image-only PDF, a corrupt file). Better to reject it than to let it
  // satisfy the grounding constraint while grounding nothing.
  if (trimmed.length < 40) {
    throw new Error('That extracted to almost no text — is it empty, or a scan of a blank page?');
  }

  return { text: trimmed, method };
}
