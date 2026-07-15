/**
 * Settles the open question in CLAUDE.md: does this workspace's Atria plan
 * actually unlock /open/v1 API access?
 *
 * Run: node scripts/verify-atria.mjs
 *
 * Answers three things, in order:
 *   1. Does the key authenticate at all?          (401 => bad/inactive key)
 *   2. Is API access gated above our plan?        (402/403 => manual upload is the ingest path)
 *   3. Do the documented ad fields come back?     (shape check against the client's expectations)
 */
import { readFileSync } from 'node:fs';

// Minimal .env.local reader — avoids a dependency just to run one check.
function loadEnv(path = '.env.local') {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* fall through to the explicit check below */
  }
}
loadEnv();

const KEY = process.env.ATRIA_API_KEY;
if (!KEY) {
  console.error('ATRIA_API_KEY not set. Copy .env.example to .env.local and add the key.');
  process.exit(1);
}

const url = new URL('https://api.tryatria.com/open/v1/ad-library/search');
url.searchParams.set('query', 'skincare');
url.searchParams.set('page_size', '1');

const res = await fetch(url, { headers: { 'X-API-Key': KEY } });
const raw = await res.text();

console.log(`HTTP ${res.status} ${res.statusText}`);

let body;
try {
  body = JSON.parse(raw);
} catch {
  console.error('Response was not JSON:\n', raw.slice(0, 400));
  process.exit(1);
}

// Gateway errors bypass the envelope entirely — check status before reading `code`.
if (!res.ok) {
  console.error('\nGateway/error response (flat, no envelope):');
  console.error(JSON.stringify(body, null, 2));
  if (res.status === 401) console.error('\n=> Key rejected. Check it is active and copied whole.');
  if (res.status === 402 || res.status === 403) {
    console.error('\n=> API access appears GATED on this plan.');
    console.error('   Per CLAUDE.md this makes manual upload the primary ingest path.');
  }
  if (res.status === 429) console.error('\n=> Rate limited. Key works; retry later.');
  process.exit(1);
}

if (body.code !== 0) {
  console.error(`\nEnvelope error code=${body.code}: ${body.message}`);
  process.exit(1);
}

// Confirmed live: the envelope's data is { items, total, cursor, page_size }.
const ads = body.data?.items ?? [];
const first = Array.isArray(ads) ? ads[0] : undefined;

console.log('\nAPI ACCESS CONFIRMED — envelope code=0.\n');
console.log('Top-level data keys:', Object.keys(body.data ?? {}));

if (first) {
  const expected = [
    'id', 'brand_id', 'brand_name', 'status', 'display_format', 'title', 'body',
    'caption', 'cta_text', 'link_url', 'images', 'videos', 'start_date', 'end_date',
  ];
  const actual = Object.keys(first);
  const missing = expected.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expected.includes(f));

  console.log('\nFirst ad — fields present:', actual.join(', '));
  if (missing.length) console.log('Documented but MISSING:', missing.join(', '));
  if (extra.length) console.log('Undocumented extras:', extra.join(', '));

  // The whole Winner Score design rests on these two existing.
  console.log(
    `\nWinner Score inputs: start_date=${first.start_date ?? 'ABSENT'} end_date=${first.end_date ?? 'ABSENT'}`,
  );
  // Confirm the documented absence of impressions rather than assuming it.
  const impressionish = actual.filter((f) => /impress|reach|spend/i.test(f));
  console.log(
    impressionish.length
      ? `Impression-like fields found (revisit CLAUDE.md!): ${impressionish.join(', ')}`
      : 'No impression/reach/spend fields — matches the documented constraint.',
  );
} else {
  console.log('\nNo ads in response; cannot shape-check. Raw data:', JSON.stringify(body.data).slice(0, 300));
}
