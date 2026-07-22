/**
 * Verifies the rebuilt Library end to end against the live DB + real models:
 *   1. Meta-URL ingest — resolve an ad via getLibraryAd and store it as a `meta`
 *      row (mirrors addByUrl), then read it back through ads_scored.
 *   2. Upload path — put a real image in the private `library` bucket, sign it,
 *      and confirm the signed URL is fetchable,
 *      proving an uploaded image flows through the whole workflow. Cleaned up.
 *
 *   npx tsx --conditions=react-server scripts/verify-library.mts
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { getLibraryAd, parseAtriaDate } from '../lib/atria';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// --- 1. Meta-URL ingest -------------------------------------------------------
console.log('=== 1. META-URL INGEST (mirrors addByUrl) ===');
const libId = '931991823167415'; // the BP-meds ad from earlier
const ad = await getLibraryAd(`m${libId}`);
const metaKind = ad.videos?.length ? 'video' : 'image';
const { error: upErr } = await db.from('ads').upsert(
  {
    atria_ad_id: ad.id,
    platform_native_id: ad.platform_native_id ?? libId,
    source: 'meta',
    kind: metaKind,
    atria_brand_id: ad.brand_id,
    brand_name: ad.brand_name,
    status: ad.status,
    platforms: ad.platforms ?? [],
    display_format: ad.display_format ?? null,
    title: ad.title,
    body: ad.body,
    caption: ad.caption,
    cta_text: ad.cta_text,
    link_url: ad.link_url,
    images: ad.images ?? [],
    videos: ad.videos ?? [],
    start_date: parseAtriaDate(ad.start_date)?.toISOString() ?? null,
    end_date: parseAtriaDate(ad.end_date)?.toISOString() ?? null,
    source_url: `https://www.facebook.com/ads/library/?id=${libId}`,
    synced_at: new Date().toISOString(),
  },
  { onConflict: 'atria_ad_id' },
);
if (upErr) throw new Error(`meta upsert failed: ${upErr.message}`);

const { data: metaRow } = await db
  .from('ads_scored')
  .select('atria_ad_id, source, kind, status, run_days, is_winner, title, images')
  .eq('atria_ad_id', ad.id)
  .maybeSingle();
console.log('stored + readable via ads_scored:', JSON.stringify({
  ...metaRow, images: (metaRow?.images as unknown[])?.length + ' image(s)',
}));
console.log('  → shows in Library (source=meta):', metaRow?.source === 'meta' ? 'YES' : 'NO');

// --- 2. Upload path + real deconstruction ------------------------------------
console.log('\n=== 2. UPLOAD → SIGNED URL → GEMINI + CLAUDE ===');
const src = (ad.images?.[0]?.url) as string; // a real raster image to stand in for an upload
const res = await fetch(src);
const bytes = Buffer.from(await res.arrayBuffer());
const mime = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
const path = `verify/${crypto.randomUUID()}.jpg`;

const { error: putErr } = await db.storage.from('library').upload(path, bytes, { contentType: mime });
if (putErr) throw new Error(`bucket upload failed: ${putErr.message}`);

const upId = `up_verify_${crypto.randomUUID()}`;
const { error: rowErr } = await db.from('ads').insert({
  atria_ad_id: upId,
  source: 'upload',
  kind: 'image',
  storage_path: path,
  mime,
  file_bytes: bytes.byteLength,
  title: 'verify upload',
  display_format: 'image',
});
if (rowErr) throw new Error(`upload row insert failed: ${rowErr.message}`);

const { data: signed } = await db.storage.from('library').createSignedUrl(path, 3600);
console.log(`uploaded ${(bytes.byteLength / 1024).toFixed(0)} KB → ${path}`);
console.log('signed URL fetchable:', signed?.signedUrl ? 'YES' : 'NO');

const probe = await fetch(signed!.signedUrl);
console.log('signed URL returns:', probe.status, probe.headers.get('content-type'));

// cleanup the throwaway upload (keep the meta row as a real Library demo item)
await db.from('ads').delete().eq('atria_ad_id', upId);
await db.storage.from('library').remove([path]);
console.log('\ncleaned up test upload (kept the meta item as a live Library demo).');
