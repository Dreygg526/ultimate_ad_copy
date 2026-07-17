'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { deconstructAd, type AdForDeconstruction } from '@/lib/deconstruct';

export type ActionState = { error: string | null };

/**
 * Runs step 3a and stores the result.
 *
 * The Supabase client here acts as the signed-in user, so RLS is what decides
 * whether this ad is readable and whether the row can be written. The auth check
 * at the top is not the boundary — it just avoids spending two model calls on a
 * request RLS would reject at the end anyway.
 */
export async function runDeconstruction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const adId = String(formData.get('adId') ?? '');
  if (!adId) return { error: 'No ad given.' };

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
  if (ad.kind === 'video') {
    return { error: 'Deconstruction supports images today, not video.' };
  }

  // Uploaded images live in the private bucket — hand Gemini a signed URL.
  // Direct-link references carry the URL straight; Atria/Meta rows already do.
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

  let result;
  try {
    result = await deconstructAd({ ...(ad as AdForDeconstruction), images });
  } catch (e) {
    // The buyer can't act on a stack trace, but they can act on "no image" or
    // "rate limited", so pass the real message through rather than a generic.
    return { error: e instanceof Error ? e.message : 'Deconstruction failed.' };
  }

  const { error } = await db.from('deconstructions').insert({
    ad_id: ad.id,
    summary: result.summary,
    marks: result.marks,
    model: result.model,
    created_by: user.id,
  });

  if (error) return { error: `Could not save: ${error.message}` };

  revalidatePath(`/deconstruct/${adId}`);
  return { error: null };
}
