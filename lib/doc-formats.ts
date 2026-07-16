/**
 * Which research-doc formats the Brand screen accepts — the client-safe half of
 * the extraction story.
 *
 * Deliberately NOT 'server-only': the upload form is a client component and
 * needs the accept string. The actual reading (Gemini, mammoth) lives in
 * lib/extract.ts, which is server-only and imports these constants back. Keep
 * anything that touches an API key or a parser out of this file.
 */

/** What a buyer might reasonably drop on the Brand screen. */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'] as const;

/** For the file input's `accept` attribute. */
export const ACCEPT_ATTR = '.pdf,.docx,.txt,.md';

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/** Rejects before upload rather than after — a stored doc we can't read is a trap. */
export function isAcceptedFile(filename: string): boolean {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(extensionOf(filename));
}
