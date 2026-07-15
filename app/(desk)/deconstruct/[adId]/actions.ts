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
    .select('id, brand_name, title, body, caption, cta_text, status, run_days, images')
    .eq('atria_ad_id', adId)
    .maybeSingle();

  if (!ad) return { error: 'That ad is not in the library.' };

  let result;
  try {
    result = await deconstructAd(ad as AdForDeconstruction);
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
