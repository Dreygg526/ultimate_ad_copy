'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getLibraryAd, parseAtriaDate, AtriaError } from '@/lib/atria';

// The Library is now a curated swipe file. Two intake paths land here — a
// browser-direct file upload (saveUpload, the row half of a resumable upload)
// and a pasted URL (addByUrl). Both write `ads` rows so the existing
// Deconstruct → Rebuild workflow, which keys off this table, treats them like
// any other ad.

export type AddState = { error: string | null; adId?: string };
export type DeleteState = { error: string | null; ok?: boolean };

const MAX_BYTES = 1_000_000_000; // 1 GB, matches the client-side guard.

function kindFromMime(mime: string | null | undefined): 'image' | 'video' | null {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

/**
 * Record a file that the browser already uploaded to the `library` bucket. The
 * bytes never touch the server — this only writes the row that points at them.
 * RLS (storage + ads) already proved the caller is a member during the upload.
 */
export async function saveUpload(input: {
  path: string;
  kind: 'image' | 'video';
  bytes: number;
  mime: string;
  title: string;
}): Promise<AddState> {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  if (!input.path) return { error: 'Upload did not complete.' };
  if (input.bytes > MAX_BYTES) return { error: 'That file is over the 1 GB limit.' };

  const adId = `up_${crypto.randomUUID()}`;
  const { error } = await db.from('ads').insert({
    atria_ad_id: adId,
    source: 'upload',
    kind: input.kind,
    storage_path: input.path,
    file_bytes: input.bytes,
    mime: input.mime,
    title: input.title.slice(0, 200),
    display_format: input.kind, // keep the existing column meaningful
    brand_name: null,
    created_by: user.id,
  });

  if (error) {
    // Don't leave an orphan in the bucket that no row points at (same rule as
    // brand/actions.ts).
    await db.storage.from('library').remove([input.path]);
    return { error: `Could not save: ${error.message}` };
  }

  revalidatePath('/library');
  return { error: null, adId };
}

/**
 * Remove a library item. The `ads` row goes; `deconstructions` and `rebuilds`
 * cascade with it (both FK `on delete cascade`). For an uploaded file we also
 * drop the object from the bucket so it isn't orphaned. RLS (`ads_rw` =
 * is_member()) is the real gate — a non-member's delete affects zero rows.
 */
export async function deleteItem(adId: string): Promise<DeleteState> {
  if (!adId) return { error: 'Nothing to delete.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: row } = await db
    .from('ads')
    .select('id, storage_path')
    .eq('atria_ad_id', adId)
    .maybeSingle();
  if (!row) return { error: 'Already gone.' };

  const { error } = await db.from('ads').delete().eq('atria_ad_id', adId);
  if (error) return { error: `Could not delete: ${error.message}` };

  // Best-effort: a leftover object is harmless, so don't fail the delete on it.
  if (row.storage_path) await db.storage.from('library').remove([row.storage_path]);

  revalidatePath('/library');
  return { error: null, ok: true };
}

/** Pull the Meta Ad Library id out of a pasted URL, if it is one. */
function metaLibraryId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  const isMeta = host.endsWith('facebook.com') || host.endsWith('fb.com');
  if (!isMeta || !url.pathname.includes('/ads/library')) return null;
  const id = url.searchParams.get('id');
  return id && /^\d{6,}$/.test(id) ? id : null;
}

/** HEAD the URL to learn what it is; fall back to the file extension. */
async function sniff(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    const ct = res.headers.get('content-type');
    if (ct) return ct.split(';')[0].trim();
  } catch {
    // Some CDNs reject HEAD — fall through to extension sniffing.
  }
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) return `image/${ext}`;
  if (['mp4', 'mov', 'webm', 'm4v'].includes(ext)) return `video/${ext}`;
  return null;
}

/**
 * Add an item from a pasted URL. Two shapes:
 *  - a Meta Ad Library ad URL (…/ads/library/?id=<libid>) → resolved through
 *    Atria and stored with the real creative, copy and run dates;
 *  - a direct link to an image or video file → stored as a reference (not
 *    re-hosted), so a 1 GB remote video doesn't get pulled through the server.
 */
export async function addByUrl(_prev: AddState, formData: FormData): Promise<AddState> {
  const raw = String(formData.get('url') ?? '').trim();
  if (!raw) return { error: 'Paste a URL first.' };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: 'That is not a valid URL.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'URL must be http(s).' };
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  // --- Meta Ad Library ad ---------------------------------------------------
  const libId = metaLibraryId(url);
  if (libId) {
    const adId = `m${libId}`;
    let ad;
    try {
      ad = await getLibraryAd(adId);
    } catch (e) {
      if (e instanceof AtriaError && e.status === 200) {
        // code != 0 came back as a 200 envelope — most often "not found".
        return { error: `Atria has no ad for that Library ID (${libId}).` };
      }
      return { error: e instanceof Error ? e.message : 'Could not reach Atria.' };
    }

    const kind = ad.videos?.length ? 'video' : 'image';
    const { error } = await db.from('ads').upsert(
      {
        atria_ad_id: ad.id,
        platform_native_id: ad.platform_native_id ?? libId,
        source: 'meta',
        kind,
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
        source_url: raw,
        created_by: user.id,
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'atria_ad_id' },
    );
    if (error) return { error: `Could not save: ${error.message}` };

    revalidatePath('/library');
    return { error: null, adId: ad.id };
  }

  // --- Direct file link (reference) -----------------------------------------
  const mime = await sniff(raw);
  const kind = kindFromMime(mime);
  if (!kind) {
    return {
      error:
        'That link is neither a Meta Ad Library ad URL (…/ads/library/?id=…) nor a direct image/video file.',
    };
  }

  const adId = `up_${crypto.randomUUID()}`;
  const title = decodeURIComponent(url.pathname.split('/').pop() || 'Linked file').slice(0, 200);
  const { error } = await db.from('ads').insert({
    atria_ad_id: adId,
    source: 'upload',
    kind,
    source_url: raw,
    mime,
    title,
    display_format: kind,
    brand_name: null,
    created_by: user.id,
  });
  if (error) return { error: `Could not save: ${error.message}` };

  revalidatePath('/library');
  return { error: null, adId };
}
