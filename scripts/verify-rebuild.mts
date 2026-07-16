/**
 * Runs step 3b end to end against a real deconstructed ad and prints the rebuild.
 *
 * A clean build says nothing about whether grounding actually shapes the copy,
 * so this exercises the real lib/rebuild modules — Claude for headline+copy,
 * Gemini for the image — against a synthetic mechanism doc. It is the cheapest
 * way to see the load-bearing behaviour: that the copy borrows the source ad's
 * structure while taking every claim from the doc, and that the image comes back.
 *
 *   npm run verify:rebuild            # a random deconstructed ad
 *   npm run verify:rebuild <atria_ad_id>
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { generateRebuild, generateImage, type GroundingDoc } from '../lib/rebuild';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// A clearly-invented brand and mechanism, so it is obvious in the output whether
// the copy is drawing claims from the doc (good) or leaking the source ad's
// substance (bad).
const DOCS: GroundingDoc[] = [
  {
    id: 'test-brand',
    kind: 'brand',
    title: 'Rootwell brand voice',
    extracted_text:
      'Rootwell is a mineral-hydration brand for people over 50. Voice: plain, unhurried, ' +
      'never alarmist. We do not use fear. We talk about feeling steady through the afternoon.',
  },
  {
    id: 'test-mechanism',
    kind: 'mechanism',
    title: 'Rootwell mechanism',
    extracted_text:
      'Rootwell works through cellular magnesium-glycinate uptake: most over-50 fatigue is ' +
      'intracellular magnesium depletion, not dehydration. Our glycinate chelation crosses the ' +
      'cell membrane where citrate and oxide do not. Effect is felt as steadier afternoon energy ' +
      'within about ten days. No stimulants, no sugar.',
  },
];

const wanted = process.argv[2];

// Only ads that have been deconstructed — the rebuild borrows their structure.
const { data: decons } = await db.from('deconstructions').select('ad_id, summary, marks');
const readIds = [...new Set((decons ?? []).map((d) => d.ad_id as string))];
if (readIds.length === 0) throw new Error('no deconstructed ads to rebuild — run verify:deconstruct first');

let q = db
  .from('ads_scored')
  .select('id, atria_ad_id, brand_name, title, body, cta_text, status, run_days')
  .in('id', readIds);
if (wanted) q = q.eq('atria_ad_id', wanted);

const { data, error } = await q.limit(1);
if (error) throw error;
const ad = data?.[0];
if (!ad) throw new Error('no matching deconstructed ad');

const decon = (decons ?? []).find((d) => d.ad_id === ad.id);

console.log(`SOURCE  ${ad.atria_ad_id} · ${ad.brand_name} · ${ad.run_days}d`);
console.log(`        ${String(ad.title ?? '(untitled)').slice(0, 72)}`);
console.log(`REBUILD FOR  Rootwell (grounded in ${DOCS.length} synthetic docs)\n`);

const t0 = Date.now();
const draft = await generateRebuild({
  ad,
  summary: (decon?.summary as string) ?? null,
  marks: ((decon?.marks ?? []) as { heading: string; body: string }[]).map((m) => ({
    heading: m.heading,
    body: m.body,
  })),
  brandName: 'Rootwell',
  docs: DOCS,
});
const copySecs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`HEADLINE\n  ${draft.headline}\n`);
console.log(`COPY\n  ${draft.copy.replace(/\n/g, '\n  ')}\n`);
console.log(`ART DIRECTION\n  ${draft.art_direction.replace(/\n/g, '\n  ')}\n`);
console.log(`ALTERNATES\n  ${draft.alternates.join('\n  ')}\n`);
console.log(`CTA\n  ${draft.cta}\n`);
console.log(`NOTES\n  ${draft.notes}\n`);
console.log(`grounded in: ${draft.groundingDocIds.join(', ')}`);
console.log(`${draft.model} · ${copySecs}s\n`);

const t1 = Date.now();
try {
  const img = await generateImage(draft.art_direction);
  const imgSecs = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`IMAGE  ${img.model} · ${img.mimeType} · ${Math.round(img.bytes.byteLength / 1024)}KB · ${imgSecs}s`);
} catch (e) {
  console.log(`IMAGE  failed: ${e instanceof Error ? e.message : e}`);
}
