/**
 * The only place Teardown talks to Atria.
 *
 * Never import this from a component — it needs ATRIA_API_KEY, which must not
 * reach the browser. Route handlers and server components only.
 *
 * Types here were verified against the live API on 2026-07-15 (150-ad sample),
 * not transcribed from the docs. Where the docs and reality disagree, reality
 * won and the difference is commented.
 */
import 'server-only';

const BASE = 'https://api.tryatria.com/open/v1';

export type DisplayFormat =
  | 'image' | 'video' | 'carousel' | 'multi_images' | 'multi_videos' | 'dco' | 'dpa';

export type AdStatus = 'active' | 'inactive';
export type SearchOrder = 'newest' | 'oldest' | 'most_active' | 'best_match';

/** images[]/videos[] are objects, not the bare URL strings the docs imply. */
export interface AtriaMedia {
  url: string;
  width: number;
  height: number;
}

export interface AtriaAd {
  id: string;
  /** Undocumented: the Facebook-side id. Handy for deep links. */
  platform_native_id: string;
  brand_id: string;
  brand_name: string;
  status: AdStatus;
  /** Undocumented: e.g. ["facebook","instagram","audience_network"]. */
  platforms: string[];
  display_format: DisplayFormat;
  title: string | null;
  body: string | null;
  caption: string | null;
  cta_text: string | null;
  link_url: string | null;
  images: AtriaMedia[];
  videos: AtriaMedia[];

  /**
   * ISO 8601 timestamps — NOT the YYYY-MM-DD the docs describe. Worse, the
   * timezone designator is inconsistent: some values are tz-aware
   * ("2026-07-14T07:00:00+00:00"), some are naive ("2026-07-15T06:40:16.666024").
   * Always parse with parseAtriaDate(), never `new Date(raw)` directly.
   */
  start_date: string | null;

  /**
   * CAREFUL: this is "last seen running", not "the ad ended".
   * For active ads it tracks Atria's last sync (measured: every active ad in a
   * 150-ad sample had end_date ~0.3 days old). For inactive ads it is the real
   * end. Never present it to a user as an end date for a running ad.
   */
  end_date: string | null;

  // No impressions/reach/spend — confirmed absent against the live API, not
  // merely assumed. See CLAUDE.md hard constraint 1 before adding anything here
  // that implies reach.
}

export interface SearchParams {
  query?: string;
  platform?: string;
  display_format?: DisplayFormat;
  language?: string;
  start_date?: string;
  end_date?: string;
  status?: AdStatus;
  industry?: string;
  video_length?: string;
  order?: SearchOrder;
  page_size?: number; // 1–50, default 20
  cursor?: string;
}

export interface SearchResult {
  ads: AtriaAd[];
  /** null means no further pages. */
  cursor: string | null;
  /** Appears to cap at 10000 rather than being an exact count. */
  total: number;
  page_size: number;
}

/** Envelope on success and on application-level errors. */
interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

/** Gateway errors (401/429/5xx) bypass the envelope and look like this instead. */
interface GatewayError {
  error: string;
  message: string;
  request_id: string;
}

export class AtriaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'AtriaError';
  }

  /** Plan-gating or a dead key — not something a retry fixes. */
  get isAccessProblem() {
    return this.status === 401 || this.status === 402 || this.status === 403;
  }
}

/**
 * Atria mixes tz-aware and naive timestamps in the same field. A naive value is
 * UTC in practice, but `new Date("2026-07-15T06:40:16.666024")` parses it as
 * *local* time, which silently shifts the value by the host's offset — and run
 * length is the entire Winner Score. Pin naive values to UTC explicitly.
 */
export function parseAtriaDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const hasZone = /Z$|[+-]\d{2}:\d{2}$/.test(raw);
  const d = new Date(hasZone ? raw : `${raw}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Whole days a creative has been running. The Winner Score input. */
export function runDays(ad: Pick<AtriaAd, 'start_date' | 'end_date'>): number | null {
  const start = parseAtriaDate(ad.start_date);
  // end_date is never null in practice, but fall back to now for a running ad
  // rather than dropping the ad out of scoring entirely.
  const end = parseAtriaDate(ad.end_date) ?? new Date();
  if (!start) return null;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 86_400_000));
}

/** Days an ACTIVE ad has been running, measured to now — matches the view's
 *  `greatest(end_date, now()) - start_date` for active rows (end_date is only
 *  "last seen", so a stale value must not cut the run short). */
function activeRunDays(ad: Pick<AtriaAd, 'start_date' | 'end_date'>, now: number): number | null {
  const start = parseAtriaDate(ad.start_date);
  if (!start) return null;
  const end = parseAtriaDate(ad.end_date)?.getTime() ?? now;
  return Math.max(0, Math.floor((Math.max(end, now) - start.getTime()) / 86_400_000));
}

/** percentile_cont(p): linear interpolation between order stats, like Postgres. */
function percentileCont(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0];
  const rank = p * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (rank - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

export interface ScoredWinner {
  ad: AtriaAd;
  /** Whole days running, to now. */
  runDays: number;
  /** Within-brand Winner Score 0–100: share of the brand's active ads at or
   *  below this run length. LONGEVITY, not reach. */
  score: number;
}

/**
 * The winners out of one brand's ads, replicating the `ads_scored` SQL rule in
 * code (see migrations 0002/0003 for the calibration): a winner is ACTIVE and
 * its run length is in the top quartile of the brand's active ads (p75), with a
 * 30-day fallback bar when there are fewer than 8 active ads to take a
 * percentile of. run_days is LONGEVITY, not reach — Atria has no impressions.
 *
 * Pass the brand's ACTIVE ads (the page-URL path fetches status=active):
 * inactive ads can't be winners and don't enter the percentile, exactly as the
 * SQL `where status = 'active'` does. Returned sorted by run length, longest
 * first — so a caller capping the count keeps the strongest.
 */
export function pickBrandWinners(activeAds: AtriaAd[]): ScoredWinner[] {
  // Kept in sync with winner_min_sample()/winner_min_run_days() in the DB.
  const WINNER_MIN_SAMPLE = 8;
  const WINNER_MIN_RUN_DAYS = 30;

  const now = Date.now();
  const scored = activeAds
    .map((ad) => ({ ad, runDays: activeRunDays(ad, now) }))
    .filter((x): x is { ad: AtriaAd; runDays: number } => x.runDays !== null);

  const n = scored.length;
  if (n === 0) return [];

  const runs = scored.map((x) => x.runDays).sort((a, b) => a - b);
  const bar =
    n >= WINNER_MIN_SAMPLE ? Math.ceil(percentileCont(runs, 0.75)) : WINNER_MIN_RUN_DAYS;

  return scored
    .filter((x) => x.runDays >= bar)
    .map((x) => ({
      ad: x.ad,
      runDays: x.runDays,
      score: Math.round((100 * runs.filter((r) => r <= x.runDays).length) / n),
    }))
    .sort((a, b) => b.runDays - a.runDays);
}

// --- rate limiting -----------------------------------------------------------
// Serialise requests with a floor between them. The ad library does not change
// by the second, so there is no reason to ever burst it.
const MIN_GAP_MS = 250;
let chain: Promise<unknown> = Promise.resolve();
let lastCall = 0;

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  // Keep the chain alive even if this link rejects.
  chain = run.then(() => undefined, () => undefined);
  return run;
}

// --- caching -----------------------------------------------------------------
const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

// --- core --------------------------------------------------------------------

async function request<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  const key = process.env.ATRIA_API_KEY;
  if (!key) throw new AtriaError('ATRIA_API_KEY is not set', 0);

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const cacheKey = url.toString();
  const hit = cached<T>(cacheKey);
  if (hit !== undefined) return hit;

  const value = await schedule(async () => {
    const res = await fetch(url, { headers: { 'X-API-Key': key }, cache: 'no-store' });

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AtriaError(`Atria returned non-JSON (HTTP ${res.status})`, res.status);
    }

    // Status first: gateway errors never carry an envelope, so reading `code`
    // before checking res.ok would misread them as success.
    if (!res.ok) {
      const err = parsed as GatewayError;
      throw new AtriaError(
        err?.message ?? `Atria request failed (HTTP ${res.status})`,
        res.status,
        undefined,
        err?.request_id,
      );
    }

    const env = parsed as Envelope<T>;
    if (env.code !== 0) {
      throw new AtriaError(env.message ?? `Atria error code ${env.code}`, res.status, env.code);
    }
    return env.data;
  });

  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

// --- public API --------------------------------------------------------------

interface SearchPayload {
  items?: AtriaAd[];
  cursor?: string | null;
  total?: number;
  page_size?: number;
}

export async function searchAds(params: SearchParams = {}): Promise<SearchResult> {
  if (params.page_size !== undefined && (params.page_size < 1 || params.page_size > 50)) {
    throw new AtriaError('page_size must be between 1 and 50', 0);
  }
  // The payload key is `items`, not `ads` — verified live.
  const data = await request<SearchPayload>('/ad-library/search', { ...params });
  return {
    ads: data.items ?? [],
    cursor: data.cursor ?? null,
    total: data.total ?? 0,
    page_size: data.page_size ?? params.page_size ?? 20,
  };
}

/**
 * Fetch one ad by its Atria id. Powers the Meta-URL paste path: a Facebook Ad
 * Library `?id=<libid>` URL maps to Atria id `'m' + libid` (Meta prefix).
 *
 * Path is `/ad-library/{id}`, NOT the `/library-ads/{id}` the docs (llms.txt)
 * advertise — that one returns code 40401 "no matching open API". Verified live
 * 2026-07-17. The response `data` is the ad object directly (no `items`
 * envelope), same field shape as a search hit.
 */
export async function getLibraryAd(adId: string): Promise<AtriaAd> {
  return request<AtriaAd>(`/ad-library/${encodeURIComponent(adId)}`);
}

/** Every ad Atria holds for one brand. The tracked-brand sync path. */
export async function listBrandAds(
  brandId: string,
  params: Omit<SearchParams, 'query'> = {},
): Promise<SearchResult> {
  const data = await request<SearchPayload>(
    `/brand-library/${encodeURIComponent(brandId)}/ads`,
    { ...params },
  );
  return {
    ads: data.items ?? [],
    cursor: data.cursor ?? null,
    total: data.total ?? 0,
    page_size: data.page_size ?? params.page_size ?? 20,
  };
}

/** Resolve a brand by name. Atria's brand search is name-only. */
export async function searchBrands(query: string): Promise<Array<{ id: string; name: string }>> {
  const data = await request<{ items?: Array<{ id: string; name: string }> }>(
    '/brand-library/search',
    { name: query },
  );
  return data.items ?? [];
}

/**
 * A Facebook page id maps straight to an Atria brand id — verified against all
 * three tracked pages: brand_id === 'm' + page_id for Meta-origin brands
 * ('t' prefixes TikTok). This means a page URL from the source doc resolves
 * with no name search, which is both faster and unambiguous.
 */
export function brandIdFromFacebookPageId(pageId: string): string {
  return `m${pageId}`;
}

/** Pull the page id out of a Facebook Ad Library URL (?view_all_page_id=...). */
export function facebookPageIdFromUrl(url: string): string | null {
  try {
    return new URL(url).searchParams.get('view_all_page_id');
  } catch {
    return null;
  }
}

/** Test-only. */
export function __clearCache() {
  cache.clear();
}
