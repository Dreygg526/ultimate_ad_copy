/**
 * Runs step 3a end to end against a real ad and prints what came back.
 *
 * A clean build says nothing about whether Gemini and Claude actually cooperate,
 * so this exercises the real modules — not a copy of their prompts. Reads with
 * the service role because there's no session on the CLI; the app itself always
 * goes through RLS.
 *
 *   npm run verify:deconstruct            # a random winner
 *   npm run verify:deconstruct <atria_ad_id>
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { deconstructAd, type AdForDeconstruction } from '../lib/deconstruct';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const wanted = process.argv[2];

let q = db
  .from('ads_scored')
  .select('atria_ad_id, brand_name, title, body, caption, cta_text, status, run_days, images')
  .not('images', 'eq', '[]');

q = wanted ? q.eq('atria_ad_id', wanted) : q.is('is_winner', true).order('run_days', { ascending: false });

const { data, error } = await q.limit(1);
if (error) throw error;

const ad = data?.[0];
if (!ad) throw new Error('no ad found');

console.log(`AD  ${ad.atria_ad_id} · ${ad.brand_name} · ${ad.run_days}d · ${ad.status}`);
console.log(`     ${String(ad.title ?? '(untitled)').slice(0, 70)}`);
console.log(`ART  ${(ad.images as { url: string }[])?.[0]?.url?.slice(0, 90)}\n`);

const t0 = Date.now();
const r = await deconstructAd(ad as AdForDeconstruction);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`GEMINI SAW (${r.vision.observations.length} elements located)`);
console.log(`  ${r.vision.scene.replace(/\n/g, ' ')}`);
if (r.vision.text_in_image.length) {
  console.log(`  text in image: ${r.vision.text_in_image.map((t) => `"${t}"`).join(' · ')}`);
}
for (const [i, o] of r.vision.observations.entries()) {
  console.log(`  [${i}] (${o.x.toFixed(0).padStart(3)},${o.y.toFixed(0).padStart(3)}) ${o.what}`);
}

console.log(`\nCLAUDE SAID\n  ${r.summary.replace(/\n/g, '\n  ')}\n`);
console.log(`MARKS (${r.marks.length})`);
for (const [i, m] of r.marks.entries()) {
  console.log(`  ${i + 1}. (${m.x.toFixed(0)}%,${m.y.toFixed(0)}%) ${m.heading}`);
  console.log(`     ${m.body}`);
}
console.log(`\n${r.model} · ${secs}s`);
