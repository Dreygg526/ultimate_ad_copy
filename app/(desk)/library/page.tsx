import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { AddToLibrary } from './AddToLibrary';
import { RefreshStatuses } from './RefreshStatuses';
import { BrandDeleteButton } from './BrandDeleteButton';
import { LibraryGrid, type CardItem } from './LibraryGrid';

// Headroom for the page-URL winner pull (Atria calls + image re-hosts) and the
// status re-check, which run as server actions on this route. Well under it in
// practice; this just stops a slow CDN from tripping the platform default.
export const maxDuration = 60;

// Step 1, rebuilt: the Library is a curated swipe file the buyer stocks — files
// uploaded straight to Storage, and ads pulled from a Meta Ad Library URL. Both
// are `ads` rows (source 'upload' | 'meta'), so opening one runs the same
// Deconstruct → Rebuild workflow. The old Atria tracked-brand feed and its
// Winner Score are retired here; those rows stay in the DB but are filtered out.

type Search = {
  source?: string;
  kind?: string;
  q?: string;
  brand?: string;
  // Filters/sort popovers (top-right).
  platform?: string; // facebook | instagram | audience_network | messenger | threads
  status?: string; // live | ended
  from?: string; // run-date window (YYYY-MM-DD) — NOT impressions
  to?: string;
  days?: string; // run-length window: 7 | 14 | 30 | 60 (the Ad Library's chips)
  sort?: string; // score | recent
};

// The Ad Library's date chips, filtering on how long an ad has been RUNNING —
// the signal we actually have. There is no impressions filter to build (hard
// constraint 1): Meta publishes none for ecom ads and neither does Atria.
const WINDOWS = [7, 14, 30, 60] as const;

const PLATFORMS: { id: string; label: string }[] = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'audience_network', label: 'Audience Network' },
  { id: 'messenger', label: 'Messenger' },
  { id: 'threads', label: 'Threads' },
];

interface Item {
  id: string;
  atria_ad_id: string;
  platform_native_id: string | null;
  source: 'upload' | 'meta';
  kind: 'image' | 'video' | null;
  storage_path: string | null;
  source_url: string | null;
  brand_name: string | null;
  title: string | null;
  status: 'active' | 'inactive' | null;
  images: { url: string }[] | null;
  videos: { url: string }[] | null;
  // Winner Score, from ads_scored. Meta rows carry these; uploads don't.
  winner_score: number | null;
  run_days: number | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
}

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const db = await createClient();

  let q = db
    .from('ads_scored')
    .select(
      'id, atria_ad_id, platform_native_id, source, kind, storage_path, source_url, brand_name, title, status, images, videos, winner_score, run_days, start_date, end_date, created_at',
    )
    .in('source', ['upload', 'meta']);

  if (sp.source === 'upload' || sp.source === 'meta') q = q.eq('source', sp.source);
  if (sp.kind === 'image' || sp.kind === 'video') q = q.eq('kind', sp.kind);
  // Advertiser sub-filter under "From Meta" (keyed on the stable brand id, not
  // the display name). Implies Meta source.
  if (sp.brand) q = q.eq('atria_brand_id', sp.brand);

  // --- Filters popover ---
  if (PLATFORMS.some((p) => p.id === sp.platform)) q = q.contains('platforms', [sp.platform!]);
  if (sp.status === 'live') q = q.eq('status', 'active');
  if (sp.status === 'ended') q = q.eq('status', 'inactive');
  // Run-date window (NOT impressions): keep ads whose run overlaps [from, to].
  // An ad overlaps if it was still running at/after `from` and started at/before
  // `to`. Active ads carry a ~now end_date, so they pass the `from` bound.
  if (sp.from) q = q.gte('end_date', sp.from);
  if (sp.to) q = q.lte('start_date', `${sp.to}T23:59:59`);
  // Run-length window (7d+ / 14d+ / …): the ad has been live at least that long.
  const days = WINDOWS.find((w) => String(w) === sp.days) ?? null;
  if (days) q = q.gte('run_days', days);

  // Free-text over title / ids. Strip PostgREST-significant chars so the search
  // string can't break the .or() filter.
  const needle = (sp.q ?? '').trim().replace(/[,()*\\]/g, ' ').trim();
  if (needle) {
    q = q.or(
      `title.ilike.%${needle}%,atria_ad_id.ilike.%${needle}%,platform_native_id.ilike.%${needle}%`,
    );
  }

  // --- Sort popover. 'score' = Winner Score high→low (the honest replacement
  // for Meta's "impressions high→low"; Atria has no impressions). 'recent' =
  // most recently launched. Uploads carry null score/date, so they sort last.
  const sort = sp.sort === 'recent' ? 'recent' : 'score';
  if (sort === 'recent') {
    q = q
      .order('start_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
  } else {
    q = q
      .order('winner_score', { ascending: false, nullsFirst: false })
      .order('run_days', { ascending: false, nullsFirst: false });
  }

  const { data, error } = await q.limit(60);
  const rows = (data ?? []) as unknown as Item[];

  // Resolve each thumbnail. Uploads: a signed URL for a stored file, or the
  // direct-link reference. Meta/Atria: the creative straight off Atria's CDN —
  // videos[] for a video, images[] otherwise. (source_url on a Meta row is the
  // Facebook page URL, NOT an image — never use it as art.)
  const art = new Map<string, { url: string | null; isVideo: boolean }>();
  await Promise.all(
    rows.map(async (r) => {
      const isVideo = r.kind === 'video';
      let url: string | null;
      if (r.storage_path) {
        // Re-hosted in our own bucket (uploads, and now meta winners) — permanent.
        const { data: signed } = await db.storage
          .from('library')
          .createSignedUrl(r.storage_path, 3600);
        url = signed?.signedUrl ?? null;
      } else if (r.source === 'upload') {
        url = r.source_url; // direct-link reference (image or video)
      } else {
        // Meta row whose re-host failed/was skipped — fall back to Atria's CDN.
        url = isVideo ? (r.videos?.[0]?.url ?? null) : (r.images?.[0]?.url ?? null);
      }
      art.set(r.id, { url, isVideo });
    }),
  );

  // Flatten into the serializable shape the client grid renders.
  const cardItems: CardItem[] = rows.map((r) => {
    const a = art.get(r.id);
    return {
      id: r.id,
      atria_ad_id: r.atria_ad_id,
      platform_native_id: r.platform_native_id,
      source: r.source,
      kind: r.kind,
      brand_name: r.brand_name,
      title: r.title,
      status: r.status,
      winner_score: r.winner_score,
      run_days: r.run_days,
      start_date: r.start_date,
      end_date: r.end_date,
      artUrl: a?.url ?? null,
      isVideo: a?.isVideo ?? false,
    };
  });

  // Rail counts, scoped by RLS like everything else.
  const countSource = async (src: 'upload' | 'meta') => {
    const { count } = await db
      .from('ads_scored')
      .select('id', { count: 'exact', head: true })
      .eq('source', src);
    return count ?? 0;
  };
  const [uploadN, metaN] = await Promise.all([countSource('upload'), countSource('meta')]);

  // Advertisers behind the Meta items, for the "From Meta" sub-list. A curated
  // library is small, so pull the id/name pairs and tally in JS rather than an
  // RPC. Sorted by count desc, then name.
  const { data: metaBrandsRaw } = await db
    .from('ads_scored')
    .select('atria_brand_id, brand_name')
    .eq('source', 'meta');
  const brandTally = new Map<string, { name: string; n: number }>();
  for (const r of (metaBrandsRaw ?? []) as { atria_brand_id: string | null; brand_name: string | null }[]) {
    if (!r.atria_brand_id) continue;
    const cur = brandTally.get(r.atria_brand_id);
    if (cur) cur.n += 1;
    else brandTally.set(r.atria_brand_id, { name: r.brand_name ?? 'Meta ad', n: 1 });
  }
  const metaBrands = [...brandTally.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

  const qs = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/library?${s}` : '/library';
  };

  const activeFilters = [sp.platform, sp.kind, sp.status, sp.from, sp.to].filter(Boolean).length;

  return (
    <div className="workbench">
      <aside className="rail">
        <AddToLibrary />

        <div className="rail-group">
          <p className="eyebrow">Source</p>
          <Link
            href={qs({ source: undefined, brand: undefined })}
            className={`source${!sp.source && !sp.brand ? ' is-on' : ''}`}
          >
            <span className="source-name">All</span>
            <span className="source-count num">{uploadN + metaN}</span>
          </Link>
          <Link
            href={qs({ source: sp.source === 'upload' ? undefined : 'upload', brand: undefined })}
            className={`source${sp.source === 'upload' ? ' is-on' : ''}`}
          >
            <span className="source-name">Uploads</span>
            <span className="source-count num">{uploadN}</span>
          </Link>
          <Link
            href={qs({ source: sp.source === 'meta' && !sp.brand ? undefined : 'meta', brand: undefined })}
            className={`source${sp.source === 'meta' && !sp.brand ? ' is-on' : ''}`}
          >
            <span className="source-name">From Meta</span>
            <span className="source-count num">{metaN}</span>
          </Link>

          {metaBrands.length > 0 && (
            <div className="source-subs">
              {metaBrands.map((b) => (
                <div key={b.id} className="source-sub-row">
                  <Link
                    href={qs({
                      source: 'meta',
                      brand: sp.brand === b.id ? undefined : b.id,
                    })}
                    className={`source source-sub${sp.brand === b.id ? ' is-on' : ''}`}
                  >
                    <span className="source-name">{b.name}</span>
                    <span className="source-count num">{b.n}</span>
                  </Link>
                  <BrandDeleteButton brandId={b.id} label={b.name} count={b.n} />
                </div>
              ))}
            </div>
          )}

          {metaN > 0 && (
            <p className="rail-note">
              The score on each Meta clip is the Winner Score — run length in the top quartile of
              that advertiser&rsquo;s own live ads. It&rsquo;s a longevity proxy, <strong>not
              reach</strong>: Atria returns no impressions. The dates behind it are on every clip.
            </p>
          )}
          {metaN > 0 && <RefreshStatuses />}
        </div>

        <div className="rail-group">
          <p className="eyebrow">Kind</p>
          {(['image', 'video'] as const).map((k) => (
            <Link
              key={k}
              href={qs({ kind: sp.kind === k ? undefined : k })}
              className="opt"
              style={{ color: sp.kind === k ? 'var(--pencil)' : undefined }}
            >
              {k}
            </Link>
          ))}
        </div>

        <form className="rail-group field" action="/library" method="get">
          <label className="eyebrow" htmlFor="q-search">
            Search
          </label>
          {sp.source && <input type="hidden" name="source" value={sp.source} />}
          {sp.kind && <input type="hidden" name="kind" value={sp.kind} />}
          {sp.brand && <input type="hidden" name="brand" value={sp.brand} />}
          <input
            id="q-search"
            name="q"
            type="search"
            defaultValue={sp.q ?? ''}
            placeholder="title or ID"
            autoComplete="off"
          />
        </form>
      </aside>

      <main className="sheet">
        <div className="sheet-head">
          <h1 className="sheet-title">Library</h1>
          <p className="sheet-sub">
            {uploadN + metaN} items · {uploadN} uploaded · {metaN} from Meta · showing {rows.length}
          </p>

          <div className="lib-controls">
            {/* Run-length chips, straight off the Ad Library. Not impressions —
                see the rail note and hard constraint 1. */}
            <div className="daybar">
              <Link href={qs({ days: undefined })} className={`chip${!days ? ' is-on' : ''}`}>
                any
              </Link>
              {WINDOWS.map((w) => (
                <Link
                  key={w}
                  href={qs({ days: days === w ? undefined : String(w) })}
                  className={`chip${days === w ? ' is-on' : ''}`}
                >
                  {w}d+
                </Link>
              ))}
            </div>

            {/* Filters — SSR popover via <details>, submits a GET form. */}
            <details className="pop">
              <summary className="chip">
                Filters{activeFilters > 0 ? ` · ${activeFilters}` : ''}
              </summary>
              <form className="pop-panel" action="/library" method="get">
                {/* preserve params the panel doesn't own */}
                {sp.source && <input type="hidden" name="source" value={sp.source} />}
                {sp.brand && <input type="hidden" name="brand" value={sp.brand} />}
                {sp.q && <input type="hidden" name="q" value={sp.q} />}
                {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
                {days && <input type="hidden" name="days" value={String(days)} />}

                <label className="pop-field">
                  <span className="eyebrow">Platform</span>
                  <select name="platform" defaultValue={sp.platform ?? ''}>
                    <option value="">All platforms</option>
                    {PLATFORMS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="pop-field">
                  <span className="eyebrow">Media type</span>
                  <select name="kind" defaultValue={sp.kind ?? ''}>
                    <option value="">All media types</option>
                    <option value="image">Image</option>
                    <option value="video">Video</option>
                  </select>
                </label>

                <label className="pop-field">
                  <span className="eyebrow">Active status</span>
                  <select name="status" defaultValue={sp.status ?? ''}>
                    <option value="">All</option>
                    <option value="live">Live</option>
                    <option value="ended">Ended</option>
                  </select>
                </label>

                <div className="pop-field">
                  <span className="eyebrow">
                    Run dates <span className="pop-hint">— not reach</span>
                  </span>
                  <div className="pop-dates">
                    <input type="date" name="from" defaultValue={sp.from ?? ''} aria-label="From" />
                    <span>→</span>
                    <input type="date" name="to" defaultValue={sp.to ?? ''} aria-label="To" />
                  </div>
                </div>

                <div className="pop-actions">
                  <Link
                    className="chip"
                    href={qs({
                      platform: undefined,
                      kind: undefined,
                      status: undefined,
                      from: undefined,
                      to: undefined,
                    })}
                  >
                    Clear
                  </Link>
                  <button type="submit" className="chip is-on">
                    Apply
                  </button>
                </div>
              </form>
            </details>

            {/* Sort by — Winner Score replaces Meta's impressions sort (no reach data). */}
            <details className="pop">
              <summary className="chip">
                Sort: {sort === 'recent' ? 'Most recent' : 'Longest running'}
              </summary>
              <div className="pop-panel">
                <Link
                  className={`pop-opt${sort === 'score' ? ' is-on' : ''}`}
                  href={qs({ sort: undefined })}
                >
                  <span className="pop-dot" /> Longest running (Winner Score)
                </Link>
                <Link
                  className={`pop-opt${sort === 'recent' ? ' is-on' : ''}`}
                  href={qs({ sort: 'recent' })}
                >
                  <span className="pop-dot" /> Most recent
                </Link>
                <p className="pop-hint" style={{ marginTop: 8 }}>
                  No “impressions” sort — Atria returns no reach.
                </p>
              </div>
            </details>
          </div>
        </div>

        {error && <p style={{ color: 'var(--pencil)' }}>Could not load library: {error.message}</p>}

        {!error && rows.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
            Nothing here yet. Upload an image or video, or paste a Meta Ad Library URL, from the
            panel on the left.
          </p>
        )}

        <LibraryGrid items={cardItems} />
      </main>
    </div>
  );
}
