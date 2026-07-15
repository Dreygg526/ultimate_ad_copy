/**
 * Atria → Supabase ingest.
 *
 * Ads are keyed on atria_ad_id and upserted, so a re-sync refreshes status and
 * end_date rather than duplicating. That matters: an ad flipping active →
 * inactive is exactly the signal Winner Score reads, so a stale status is a
 * wrong score.
 */
import 'server-only';
import { listBrandAds, parseAtriaDate, type AtriaAd } from './atria';
import { createAdminClient } from './supabase/admin';

/** Atria's timestamps are inconsistent about timezone; normalise before storing. */
function toIsoUtc(raw: string | null): string | null {
  return parseAtriaDate(raw)?.toISOString() ?? null;
}

function toRow(ad: AtriaAd, brandUuid: string | null) {
  return {
    atria_ad_id: ad.id,
    platform_native_id: ad.platform_native_id ?? null,
    brand_id: brandUuid,
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
    start_date: toIsoUtc(ad.start_date),
    end_date: toIsoUtc(ad.end_date),
    synced_at: new Date().toISOString(),
  };
}

export interface SyncReport {
  brand: string;
  atriaBrandId: string;
  fetched: number;
  upserted: number;
  reportedTotal: number;
  error?: string;
}

/** Sync one brand's full ad history. maxPages caps a runaway backfill. */
export async function syncBrand(
  atriaBrandId: string,
  opts: { maxPages?: number } = {},
): Promise<SyncReport> {
  const db = createAdminClient();
  const maxPages = opts.maxPages ?? 60;

  const { data: brand } = await db
    .from('brands')
    .select('id, name')
    .eq('atria_brand_id', atriaBrandId)
    .maybeSingle();

  const report: SyncReport = {
    brand: brand?.name ?? atriaBrandId,
    atriaBrandId,
    fetched: 0,
    upserted: 0,
    reportedTotal: 0,
  };

  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await listBrandAds(atriaBrandId, {
      page_size: 50,
      ...(cursor ? { cursor } : {}),
    });
    report.reportedTotal = res.total;
    report.fetched += res.ads.length;

    if (res.ads.length) {
      const rows = res.ads.map((a) => toRow(a, brand?.id ?? null));
      const { error, count } = await db
        .from('ads')
        .upsert(rows, { onConflict: 'atria_ad_id', count: 'exact' });
      if (error) {
        report.error = error.message;
        return report;
      }
      report.upserted += count ?? rows.length;
    }

    // A null cursor means no more results.
    cursor = res.cursor;
    if (!cursor) break;
  }

  return report;
}

/** Sync every brand flagged is_tracked. */
export async function syncTrackedBrands(opts: { maxPages?: number } = {}): Promise<SyncReport[]> {
  const db = createAdminClient();
  const { data: brands, error } = await db
    .from('brands')
    .select('atria_brand_id, name')
    .eq('is_tracked', true)
    .not('atria_brand_id', 'is', null);

  if (error) throw new Error(`could not list tracked brands: ${error.message}`);

  const out: SyncReport[] = [];
  for (const b of brands ?? []) {
    out.push(await syncBrand(b.atria_brand_id as string, opts));
  }
  return out;
}
