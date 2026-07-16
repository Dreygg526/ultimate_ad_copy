'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { extractText, isAcceptedFile, ACCEPTED_EXTENSIONS } from '@/lib/extract';

export type ActionState = { error: string | null; ok?: string };

/**
 * Prep step: research docs → bucket → text extracted → brand_docs rows.
 *
 * RLS is the boundary — this client acts as the signed-in user, so the database
 * decides what may be written. The auth checks here only avoid burning an
 * upload and a model call on a request RLS would reject anyway.
 */

/**
 * Our own brands, not the tracked competitors.
 *
 * `is_tracked` is the whole distinction: tracked rows are Atria ad sources that
 * ingest owns and the Library rail lists. An untracked row with no
 * atria_brand_id is one of ours — it holds research and is what a rebuild
 * grounds against.
 */
export async function createBrand(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const name = String(formData.get('name') ?? '').trim();
  if (!name) return { error: 'Give the brand a name.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { error } = await db.from('brands').insert({ name, is_tracked: false });
  if (error) {
    // Unique violation on atria_brand_id can't happen here (ours is null), so a
    // failure is worth showing verbatim rather than guessing at.
    return { error: `Could not add the brand: ${error.message}` };
  }

  revalidatePath('/brand');
  return { error: null, ok: `Added ${name}.` };
}

export async function uploadDoc(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const brandId = String(formData.get('brandId') ?? '');
  const kind = String(formData.get('kind') ?? '');
  const file = formData.get('file');

  if (!brandId) return { error: 'Pick a brand.' };
  if (!['brand', 'audience', 'mechanism'].includes(kind)) return { error: 'Pick a doc kind.' };
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file.' };
  if (!isAcceptedFile(file.name)) {
    return { error: `${file.name} isn't readable here — accepts ${ACCEPTED_EXTENSIONS.join(', ')}.` };
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const bytes = Buffer.from(await file.arrayBuffer());

  // Extract BEFORE storing. A doc row whose text is null grounds nothing while
  // still satisfying the DB's grounding check, so an unreadable file must never
  // become a row — see CLAUDE.md hard constraint 3.
  let extracted;
  try {
    extracted = await extractText(file.name, bytes);
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not read that file.' };
  }

  // Version per brand+kind, so re-uploading research supersedes rather than
  // silently replaces — the old row and its file stay put.
  const { data: prior } = await db
    .from('brand_docs')
    .select('version')
    .eq('brand_id', brandId)
    .eq('kind', kind)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (prior?.version ?? 0) + 1;

  const path = `${brandId}/${kind}/v${version}-${crypto.randomUUID()}-${file.name}`;
  const { error: upErr } = await db.storage.from('brand-docs').upload(path, bytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) return { error: `Upload failed: ${upErr.message}` };

  const { error: rowErr } = await db.from('brand_docs').insert({
    brand_id: brandId,
    kind,
    title: file.name,
    storage_path: path,
    extracted_text: extracted.text,
    version,
    uploaded_by: user.id,
  });

  if (rowErr) {
    // Don't leave an orphan in the bucket that no row points at.
    await db.storage.from('brand-docs').remove([path]);
    return { error: `Could not save: ${rowErr.message}` };
  }

  revalidatePath('/brand');
  revalidatePath('/rebuild');
  return {
    error: null,
    ok: `Read ${extracted.text.length.toLocaleString()} characters out of ${file.name} (${extracted.method}).`,
  };
}
