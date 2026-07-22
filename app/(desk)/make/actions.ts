'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { deconstructAd, type AdForDeconstruction } from '@/lib/deconstruct';
import { generateRebuild, generateImage, type GroundingDoc } from '@/lib/rebuild';

/**
 * Steps 3a + 3b, collapsed into one call.
 *
 * The Deconstruct and Rebuild screens still exist for reading a concept in
 * detail, but they are no longer the path a buyer walks: one button here runs
 * the vision read, the structural read and the copy, and writes both rows. The
 * two-screen version made a single concept a four-page, two-wait errand.
 *
 * The image is deliberately NOT generated here. Gemini's shoot is the slowest
 * part (~20s) and the least useful half — a buyer judges the concept on the
 * words. It runs from shootImage() once the copy is already on screen.
 *
 * The grounding rule is unchanged (CLAUDE.md hard constraint 3): no docs, no
 * rebuild — lib/rebuild.ts refuses and the DB's rebuild_must_be_grounded check
 * refuses behind it.
 */

export type ConceptState = {
  error: string | null;
  /** Set when the copy landed but something softer didn't (e.g. no deconstruction). */
  note?: string | null;
  rebuildId?: string;
  adId?: string;
  headline?: string;
  alternates?: string[];
  copy?: string;
  cta?: string;
  notes?: string | null;
  mirror?: string[];
  /** Marks from the deconstruction, if the source was an image. */
  marks?: { heading: string; body: string }[];
  summary?: string | null;
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

  // The brand and its research don't depend on the ad read, so fetch them while
  // Gemini is still looking at the creative. This is most of the time saved.
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

  // Deconstruction is image-only (Gemini vision needs a still) and is the
  // softer half here: a video winner still gets copy, it just gets it without
  // the marks. Reuse an existing read rather than paying for it twice.
  const deconWork = (async () => {
    const { data: existing } = await db
      .from('deconstructions')
      .select('summary, marks')
      .eq('ad_id', ad.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { decon: existing, fresh: false as const, note: null };

    if (ad.kind === 'video') {
      return { decon: null, fresh: false as const, note: 'Video source — no marks; deconstruction is image-only.' };
    }

    // Uploaded images live in the private bucket — hand Gemini a signed URL.
    let images = ad.images as { url: string }[] | null;
    if (ad.source === 'upload') {
      if (ad.storage_path) {
        const { data: signed } = await db.storage
          .from('library')
          .createSignedUrl(ad.storage_path, 3600);
        images = signed?.signedUrl ? [{ url: signed.signedUrl }] : null;
      } else if (ad.source_url) {
        images = [{ url: ad.source_url }];
      }
    }

    try {
      const result = await deconstructAd({ ...(ad as AdForDeconstruction), images });
      return { decon: result, fresh: true as const, note: null };
    } catch (e) {
      // A failed read costs the marks, not the concept — keep going.
      return {
        decon: null,
        fresh: false as const,
        note: `Copy written without a deconstruction: ${
          e instanceof Error ? e.message : 'vision failed'
        }`,
      };
    }
  })();

  const [{ brand, docs }, deconOut] = await Promise.all([brandWork, deconWork]);
  if (!brand) return { error: 'That brand is gone.' };

  // Persist a fresh read so the Deconstruct screen and any later rebuild see it.
  if (deconOut.fresh && deconOut.decon) {
    const r = deconOut.decon as Awaited<ReturnType<typeof deconstructAd>>;
    await db.from('deconstructions').insert({
      ad_id: ad.id,
      summary: r.summary,
      marks: r.marks,
      model: r.model,
      created_by: user.id,
    });
  }

  const marks = ((deconOut.decon?.marks ?? []) as { heading: string; body: string }[]).map(
    (m) => ({ heading: m.heading, body: m.body }),
  );

  let draft;
  try {
    draft = await generateRebuild({
      ad,
      summary: deconOut.decon?.summary ?? null,
      marks,
      brandName: brand.name,
      docs,
    });
  } catch (e) {
    // "No readable research" is the message a buyer can act on — don't bury it.
    return { error: e instanceof Error ? e.message : 'Rebuild failed.' };
  }

  // `mirror` has no column of its own, so it rides in notes rather than needing
  // a migration applied by hand before this screen works at all.
  const notes = [draft.notes, ...draft.mirror.map((m) => `· ${m}`)].join('\n');

  const { data: saved, error } = await db
    .from('rebuilds')
    .insert({
      ad_id: ad.id,
      brand_id: brand.id,
      headline: draft.headline,
      alternates: draft.alternates,
      copy: draft.copy,
      cta: draft.cta,
      notes,
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
    note: deconOut.note,
    rebuildId: saved?.id,
    adId,
    headline: draft.headline,
    alternates: draft.alternates,
    copy: draft.copy,
    cta: draft.cta,
    notes: draft.notes,
    mirror: draft.mirror,
    marks,
    summary: deconOut.decon?.summary ?? null,
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
