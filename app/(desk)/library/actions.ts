'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import {
  getLibraryAd,
  listBrandAds,
  brandIdFromFacebookPageId,
  pickBrandWinners,
  parseAtriaDate,
  AtriaError,
  type AtriaAd,
} from '@/lib/atria';

// The Library is now a curated swipe file. Two intake paths land here — a
// browser-direct file upload (saveUpload, the row half of a resumable upload)
// and a pasted URL (addByUrl). Both write `ads` rows so the existing
// build flow, which keys off this table, treats them like
// any other ad.

export type AddState = {
  error: string | null;
  adId?: string;
  // Page-URL winner pull: how many winners landed, out of how many active ads
  // scanned, for which advertiser. Drives the success message.
  added?: number;
  scanned?: number;
  brand?: string;
};

// Page-URL winner pull limits (user decision, 2026-07-18).
const SCAN_CAP = 200; // active ads scanned per paste, ~4 Atria calls at page_size 50
const WINNER_CAP = 30; // winners actually stored per paste
export type DeleteState = { error: string | null; ok?: boolean; deleted?: number };

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
 * Remove a library item. The `ads` row goes; `rebuilds`
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

/**
 * Delete a batch of items by atria_ad_id (the select-mode "delete N"). Same
 * cascade + bucket cleanup as deleteItem, done in one round trip. RLS is the
 * gate — a non-member's delete matches zero rows.
 */
export async function deleteItems(adIds: string[]): Promise<DeleteState> {
  const ids = [...new Set((adIds ?? []).filter(Boolean))];
  if (ids.length === 0) return { error: 'Nothing selected.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: rows } = await db.from('ads').select('storage_path').in('atria_ad_id', ids);
  const paths = (rows ?? []).map((r) => r.storage_path).filter((p): p is string => !!p);

  const { error, count } = await db
    .from('ads')
    .delete({ count: 'exact' })
    .in('atria_ad_id', ids);
  if (error) return { error: `Could not delete: ${error.message}` };

  if (paths.length) await db.storage.from('library').remove(paths);

  revalidatePath('/library');
  return { error: null, ok: true, deleted: count ?? 0 };
}

/**
 * Delete every Meta item from one advertiser (the rail "delete all" — e.g. all
 * of Steven West). Scoped to source='meta' so it can't wipe uploads, and keyed
 * on the stable atria_brand_id. Handles the whole brand, not just the 60 shown.
 */
export async function deleteByBrand(atriaBrandId: string): Promise<DeleteState> {
  if (!atriaBrandId) return { error: 'No advertiser given.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: rows } = await db
    .from('ads')
    .select('storage_path')
    .eq('source', 'meta')
    .eq('atria_brand_id', atriaBrandId);
  const paths = (rows ?? []).map((r) => r.storage_path).filter((p): p is string => !!p);

  const { error, count } = await db
    .from('ads')
    .delete({ count: 'exact' })
    .eq('source', 'meta')
    .eq('atria_brand_id', atriaBrandId);
  if (error) return { error: `Could not delete: ${error.message}` };

  if (paths.length) await db.storage.from('library').remove(paths);

  revalidatePath('/library');
  return { error: null, ok: true, deleted: count ?? 0 };
}

/** Pull the Meta Ad Library id out of a pasted URL, if it is one. */
function metaLibraryId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  const isMeta = host.endsWith('facebook.com') || host.endsWith('fb.com');
  if (!isMeta || !url.pathname.includes('/ads/library')) return null;
  const id = url.searchParams.get('id');
  return id && /^\d{6,}$/.test(id) ? id : null;
}

/** Pull the advertiser page id out of a Meta Ad Library *page* URL
 *  (…/ads/library/?...&view_all_page_id=<id>), if it is one and NOT a single-ad
 *  URL. Returns null when an `?id=` is present so the single-ad path wins. */
function metaPageId(url: URL): string | null {
  const host = url.hostname.replace(/^www\./, '');
  const isMeta = host.endsWith('facebook.com') || host.endsWith('fb.com');
  if (!isMeta || !url.pathname.includes('/ads/library')) return null;
  if (url.searchParams.get('id')) return null; // that's a single ad, handled elsewhere
  const id = url.searchParams.get('view_all_page_id');
  return id && /^\d{6,}$/.test(id) ? id : null;
}

/**
 * Scan an advertiser's page and add only its WINNERS to the Library.
 *
 * The Facebook page id maps straight to Atria brand `m<pageId>` (no name
 * search). We fetch that brand's ACTIVE ads (status=active — inactive ads can't
 * be winners and the Winner Score is scored over active ads anyway), up to
 * SCAN_CAP, then pickBrandWinners() applies the exact ads_scored rule and we
 * store the top WINNER_CAP.
 *
 * NOTE (CLAUDE.md hard constraint 1): the pasted URL sorts by total_impressions,
 * but Atria returns NO impressions. "Winner" here is the Winner Score —
 * longevity (top-quartile run length) + active — NOT reach. The score is frozen
 * per row in winner_score because only winners are stored, so the view can no
 * longer recompute a within-brand percentile; winner_override keeps is_winner
 * true. source_url is the page URL (never used as creative — art comes from
 * images[]/videos[]).
 */
async function addPageWinners(
  db: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  pageUrl: string,
  pageId: string,
): Promise<AddState> {
  const brandId = brandIdFromFacebookPageId(pageId);

  const active: AtriaAd[] = [];
  let cursor: string | undefined;
  try {
    while (active.length < SCAN_CAP) {
      const res = await listBrandAds(brandId, {
        status: 'active',
        // most_active returns longest-running first, so a capped scan is
        // guaranteed to contain the actual winners. 'newest' would truncate the
        // long-run tail (a 40-day winner started 40 days ago isn't "newest") and
        // could miss them entirely.
        order: 'most_active',
        page_size: 50,
        cursor,
      });
      active.push(...res.ads);
      if (!res.cursor) break;
      cursor = res.cursor;
    }
  } catch (e) {
    if (e instanceof AtriaError && e.isAccessProblem) {
      return { error: 'Atria rejected the request (key or access). Nothing added.' };
    }
    return { error: e instanceof Error ? e.message : 'Could not reach Atria.' };
  }

  if (active.length === 0) {
    return { error: `Atria has no active ads for that page (${pageId}).` };
  }

  const winners = pickBrandWinners(active).slice(0, WINNER_CAP);
  const brand = active[0].brand_name ?? 'that advertiser';
  if (winners.length === 0) {
    return {
      error: `Scanned ${active.length} active ads for ${brand}; none clear the Winner Score bar (active + top-quartile run length). Nothing added.`,
    };
  }

  // Re-host winner IMAGES into our own bucket so a saved winner is permanent
  // (videos stay on Atria's CDN — see rehostImage for why). Bounded concurrency:
  // this runs in a serverless function, so buffering everything at once is what
  // OOM'd the pull. Best-effort — a null falls back to the Atria URL still in
  // images[]/videos[]. Wrapped so a re-host hiccup can never 500 the page.
  const rehosted = new Map<string, string>();
  try {
    const images = winners.filter((w) => !w.ad.videos?.length && w.ad.images?.length);
    const BATCH = 6;
    for (let i = 0; i < images.length; i += BATCH) {
      const slice = images.slice(i, i + BATCH);
      const paths = await Promise.all(
        slice.map((w) => rehostImage(db, userId, w.ad.images[0].url)),
      );
      slice.forEach((w, j) => {
        if (paths[j]) rehosted.set(w.ad.id, paths[j]!);
      });
    }
  } catch {
    // Ignore — every row just keeps its Atria CDN fallback.
  }

  const rows = winners.map(({ ad, score }) => ({
    atria_ad_id: ad.id,
    platform_native_id: ad.platform_native_id ?? null,
    source: 'meta',
    kind: ad.videos?.length ? 'video' : 'image',
    storage_path: rehosted.get(ad.id) ?? null,
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
    // Frozen so the badge survives storing winners only (view can't recompute).
    winner_score: score,
    winner_override: true,
    source_url: pageUrl, // the page URL, never the creative
    created_by: userId,
    synced_at: new Date().toISOString(),
  }));

  const { error } = await db.from('ads').upsert(rows, { onConflict: 'atria_ad_id' });
  if (error) return { error: `Could not save winners: ${error.message}` };

  revalidatePath('/library');
  return { error: null, added: winners.length, scanned: active.length, brand };
}

/**
 * Copy an IMAGE off Atria's CDN into our own private `library` bucket so a saved
 * winner is permanent — it survives the ad being pulled from Meta and the Atria
 * CDN URL expiring. Best-effort: returns the storage path, or null to fall back
 * to the Atria URL (images[]/videos[] stay stored either way).
 *
 * Images only — NOT video. This runs inside a serverless function (Vercel), and
 * buffering ad videos (measured 6–54 MB each, ~20 per pull) into memory in one
 * request OOMs/times the function out and 500s the whole page. Video permanence
 * would need a background job or the browser→Storage path; until then a meta
 * video's thumbnail is served from Atria's CDN (nothing else needs the
 * anyway). A byte cap guards against a pathologically large "image" too.
 */
async function rehostImage(
  db: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  url: string,
): Promise<string | null> {
  const MAX_IMAGE_BYTES = 15_000_000;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type')?.split(';')[0].trim() || null;
    if (type && !type.startsWith('image/')) return null; // never buffer non-images
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_IMAGE_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
    const contentType = type ?? 'image/jpeg';
    const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await db.storage.from('library').upload(path, buf, { contentType });
    return error ? null : path;
  } catch {
    return null;
  }
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

    const kind: 'image' | 'video' = ad.videos?.length ? 'video' : 'image';
    // Re-host the image for permanence; videos stay on Atria's CDN (see rehostImage).
    const storage_path =
      kind === 'image' && ad.images?.length
        ? await rehostImage(db, user.id, ad.images[0].url)
        : null;
    const { error } = await db.from('ads').upsert(
      {
        atria_ad_id: ad.id,
        platform_native_id: ad.platform_native_id ?? libId,
        source: 'meta',
        kind,
        storage_path,
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

  // --- Meta Ad Library advertiser page (winners only) -----------------------
  const pageId = metaPageId(url);
  if (pageId) {
    return addPageWinners(db, user.id, raw, pageId);
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

export type RefreshState = { error: string | null; checked?: number; updated?: number };

/**
 * Re-check Meta items against Atria and update status + run dates. This is a
 * SOFT refresh: Atria is a lagging snapshot, so it tells you what Atria last
 * knew, NOT Meta's live truth (there is no Meta API — hard constraint 2). An ad
 * that flips to inactive stays in the Library (winner_override keeps is_winner
 * true) — it's a saved winner; the refresh just re-labels it "ended".
 */
export async function refreshMetaStatuses(): Promise<RefreshState> {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: metaRows, error: readErr } = await db
    .from('ads')
    .select('atria_ad_id, status, start_date, end_date')
    .eq('source', 'meta')
    .order('synced_at', { ascending: true })
    .limit(200); // bound the Atria round-trips per click
  if (readErr) return { error: `Could not read library: ${readErr.message}` };

  const rows = metaRows ?? [];
  let updated = 0;
  for (const row of rows) {
    let ad;
    try {
      ad = await getLibraryAd(row.atria_ad_id);
    } catch {
      continue; // gone from Atria or a transient error — leave the row as-is
    }
    const start = parseAtriaDate(ad.start_date)?.toISOString() ?? null;
    const end = parseAtriaDate(ad.end_date)?.toISOString() ?? null;
    if (ad.status === row.status && start === row.start_date && end === row.end_date) continue;
    const { error } = await db
      .from('ads')
      .update({ status: ad.status, start_date: start, end_date: end, synced_at: new Date().toISOString() })
      .eq('atria_ad_id', row.atria_ad_id);
    if (!error) updated += 1;
  }

  revalidatePath('/library');
  return { error: null, checked: rows.length, updated };
}
