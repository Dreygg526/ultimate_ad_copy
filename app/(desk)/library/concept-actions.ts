'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { generateRebuild, generateImage, type GroundingDoc } from '@/lib/rebuild';

/**
 * Click an ad in the Library, get a concept. One call, optimised for wall-clock.
 *
 * Deliberately NOT in this path, all to cut time to first copy:
 *
 *  1. No deconstruction — the feature is gone entirely (removed 2026-07-23).
 *     Reading why an ad works is redundant when the job is to replicate it, and
 *     the vision pass cost ~30s before Claude wrote a word.
 *  2. No image. Gemini's shoot is the slowest part and the least useful half —
 *     a buyer judges the concept on the words. shootImage() runs from the
 *     client once the copy is already on screen.
 *  3. No high effort, no alternate headlines, no replication map. See
 *     lib/rebuild.ts — the user chose speed over polish explicitly.
 *
 * The grounding rule is unchanged (CLAUDE.md hard constraint 3): no docs, no
 * rebuild — lib/rebuild.ts refuses and the DB's rebuild_must_be_grounded check
 * refuses behind it. That one is not a speed trade.
 */

export type ConceptState = {
  error: string | null;
  rebuildId?: string;
  adId?: string;
  headline?: string;
  copy?: string;
  cta?: string;
  notes?: string | null;
};

/** Latest version per kind grounds the concept; superseded ones stay history. */
function latestPerKind(rows: { kind: string }[]): GroundingDoc[] {
  const seen = new Set<string>();
  const docs: GroundingDoc[] = [];
  for (const d of rows) {
    if (seen.has(d.kind)) continue;
    seen.add(d.kind);
    docs.push(d as unknown as GroundingDoc);
  }
  return docs;
}

export async function makeConcept(
  _prev: ConceptState,
  formData: FormData,
): Promise<ConceptState> {
  const adId = String(formData.get('adId') ?? '');
  const brandId = String(formData.get('brandId') ?? '');
  if (!adId) return { error: 'Pick an ad first.' };
  if (!brandId) return { error: 'Pick a brand to rebuild against.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: ad } = await db
    .from('ads_scored')
    .select(
      'id, brand_name, title, body, caption, cta_text, status, run_days, images, source, kind, storage_path, source_url',
    )
    .eq('atria_ad_id', adId)
    .maybeSingle();
  if (!ad) return { error: 'That ad is not in the library.' };

  // Brand and research are independent reads — run them together so nothing
  // waits on anything but Claude.
  const brandWork = (async () => {
    const [{ data: brand }, { data: docRows }] = await Promise.all([
      db.from('brands').select('id, name').eq('id', brandId).maybeSingle(),
      db
        .from('brand_docs')
        .select('id, kind, title, extracted_text, version')
        .eq('brand_id', brandId)
        .order('version', { ascending: false }),
    ]);
    return { brand, docs: latestPerKind((docRows ?? []) as { kind: string }[]) };
  })();

  const { brand, docs } = await brandWork;
  if (!brand) return { error: 'That brand is gone.' };

  let draft;
  try {
    draft = await generateRebuild({
      ad,
      brandName: brand.name,
      docs,
    });
  } catch (e) {
    // "No readable research" is the message a buyer can act on — don't bury it.
    return { error: e instanceof Error ? e.message : 'Rebuild failed.' };
  }

  const { data: saved, error } = await db
    .from('rebuilds')
    .insert({
      ad_id: ad.id,
      brand_id: brand.id,
      headline: draft.headline,
      copy: draft.copy,
      cta: draft.cta,
      notes: draft.notes,
      art_direction: draft.art_direction,
      image_path: null, // shot separately — see shootImage
      status: 'draft',
      grounding_doc_ids: draft.groundingDocIds,
      created_by: user.id,
    })
    .select('id')
    .maybeSingle();

  if (error) {
    const msg = error.message.includes('rebuild_must_be_grounded')
      ? 'Blocked: that rebuild had no grounding docs attached.'
      : `Could not save: ${error.message}`;
    return { error: msg };
  }

  revalidatePath(`/rebuild/${adId}`);
  revalidatePath('/review');

  return {
    error: null,
    rebuildId: saved?.id,
    adId,
    headline: draft.headline,
    copy: draft.copy,
    cta: draft.cta,
    notes: draft.notes,
  };
}

export type ShotState = { error: string | null; url?: string };

/**
 * The second half of the concept: Gemini shoots the creative from the art
 * direction Claude already wrote. Split out from makeConcept so the copy can be
 * on screen while this runs — it is the slow part, and a concept with copy and
 * no art is still worth reading.
 */
export async function shootImage(rebuildId: string): Promise<ShotState> {
  if (!rebuildId) return { error: 'No rebuild given.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: rebuild } = await db
    .from('rebuilds')
    .select('id, brand_id, art_direction, image_path')
    .eq('id', rebuildId)
    .maybeSingle();
  if (!rebuild) return { error: 'That rebuild is gone.' };
  if (!rebuild.art_direction) return { error: 'That rebuild has no art direction.' };

  // Already shot — hand back what's there rather than paying Gemini twice.
  if (rebuild.image_path) {
    const { data } = await db.storage.from('rebuilds').createSignedUrl(rebuild.image_path, 3600);
    return { error: null, url: data?.signedUrl };
  }

  let img;
  try {
    img = await generateImage(rebuild.art_direction);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Image generation failed.' };
  }

  const path = `${rebuild.brand_id}/${rebuild.id}-${crypto.randomUUID()}.png`;
  const { error: upErr } = await db.storage
    .from('rebuilds')
    .upload(path, img.bytes, { contentType: img.mimeType, upsert: false });
  if (upErr) return { error: `Image upload failed: ${upErr.message}` };

  await db.from('rebuilds').update({ image_path: path }).eq('id', rebuild.id);

  const { data } = await db.storage.from('rebuilds').createSignedUrl(path, 3600);
  return { error: null, url: data?.signedUrl };
}
