'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { generateRebuild, generateImage, type GroundingDoc } from '@/lib/rebuild';

export type ActionState = { error: string | null };

/**
 * Runs step 3b and stores the result.
 *
 * Three gates sit between a buyer and an ungrounded rebuild, and that is on
 * purpose (CLAUDE.md hard constraint 3): this action refuses without docs,
 * lib/rebuild.ts refuses without readable text, and the DB's
 * rebuild_must_be_grounded check refuses an empty grounding_doc_ids. The first
 * two exist so the buyer gets a sentence; the last is the one that actually
 * cannot be bypassed.
 */
export async function runRebuild(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const adId = String(formData.get('adId') ?? '');
  const brandId = String(formData.get('brandId') ?? '');
  if (!adId) return { error: 'No ad given.' };
  if (!brandId) return { error: 'Pick a brand to rebuild against.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: ad } = await db
    .from('ads_scored')
    .select('id, brand_name, title, body, cta_text, status, run_days')
    .eq('atria_ad_id', adId)
    .maybeSingle();
  if (!ad) return { error: 'That ad is not in the library.' };

  const { data: brand } = await db
    .from('brands')
    .select('id, name')
    .eq('id', brandId)
    .maybeSingle();
  if (!brand) return { error: 'That brand is gone.' };

  // Latest version per kind grounds the rebuild; superseded ones stay history.
  const { data: allDocs } = await db
    .from('brand_docs')
    .select('id, kind, title, extracted_text, version')
    .eq('brand_id', brandId)
    .order('version', { ascending: false });

  const seen = new Set<string>();
  const docs: GroundingDoc[] = [];
  for (const d of allDocs ?? []) {
    if (seen.has(d.kind as string)) continue;
    seen.add(d.kind as string);
    docs.push(d as unknown as GroundingDoc);
  }

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

  // The image is the softer half: a rebuild with headline and copy but no art is
  // still worth keeping, so a failed generation degrades rather than discards.
  let imagePath: string | null = null;
  let imageNote: string | null = null;
  try {
    const img = await generateImage(draft.art_direction);
    const path = `${brand.id}/${adId}-${crypto.randomUUID()}.png`;
    const { error: upErr } = await db.storage
      .from('rebuilds')
      .upload(path, img.bytes, { contentType: img.mimeType, upsert: false });
    if (upErr) imageNote = `Copy saved; image upload failed: ${upErr.message}`;
    else imagePath = path;
  } catch (e) {
    imageNote = `Copy saved; image generation failed: ${
      e instanceof Error ? e.message : 'unknown error'
    }`;
  }

  const { error } = await db.from('rebuilds').insert({
    ad_id: ad.id,
    brand_id: brand.id,
    headline: draft.headline,
    copy: draft.copy,
    cta: draft.cta,
    notes: draft.notes,
    art_direction: draft.art_direction,
    image_path: imagePath,
    status: 'draft',
    grounding_doc_ids: draft.groundingDocIds,
    created_by: user.id,
  });

  if (error) {
    // A grounding violation here means the gates above have a hole — say which.
    const msg = error.message.includes('rebuild_must_be_grounded')
      ? 'Blocked: that rebuild had no grounding docs attached.'
      : `Could not save: ${error.message}`;
    return { error: msg };
  }

  revalidatePath(`/rebuild/${adId}`);
  return { error: imageNote };
}

/**
 * Save a buyer's edits to a rebuild's copy — the "ask for changes" landing spot.
 *
 * Editable only while the rebuild is the author's to change: a draft, or one
 * sent back with changes_asked. A waiting or approved rebuild is locked, so an
 * edit can't quietly rewrite what a reviewer already saw or cleared. The DB's
 * grounding constraint is untouched (this never clears grounding_doc_ids).
 */
export async function saveRebuild(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const adId = String(formData.get('adId') ?? '');
  const rebuildId = String(formData.get('rebuildId') ?? '');
  const headline = String(formData.get('headline') ?? '').trim();
  const copy = String(formData.get('copy') ?? '').trim();
  const cta = String(formData.get('cta') ?? '').trim();

  if (!rebuildId) return { error: 'No rebuild given.' };
  if (!headline) return { error: 'The headline can’t be empty.' };
  if (!copy) return { error: 'The copy can’t be empty.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: rebuild } = await db
    .from('rebuilds')
    .select('id, status')
    .eq('id', rebuildId)
    .maybeSingle();
  if (!rebuild) return { error: 'That rebuild is gone.' };
  if (!['draft', 'changes_asked'].includes(rebuild.status)) {
    return { error: `A ${rebuild.status.replace('_', ' ')} rebuild is locked — reopen it to edit.` };
  }

  const { error } = await db
    .from('rebuilds')
    .update({ headline, copy, cta: cta || null, updated_at: new Date().toISOString() })
    .eq('id', rebuildId)
    .in('status', ['draft', 'changes_asked']);
  if (error) return { error: `Could not save: ${error.message}` };

  if (adId) revalidatePath(`/rebuild/${adId}`);
  revalidatePath('/review');
  return { error: null };
}
