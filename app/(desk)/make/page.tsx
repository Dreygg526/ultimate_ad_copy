import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { AddToLibrary } from '../library/AddToLibrary';
import type { CardItem } from '../library/LibraryGrid';
import { MakeDesk, type BrandOption } from './MakeDesk';

// Deconstruct + rebuild run as one server action on this route and both call
// models. Measured against the real NAC/liver source ad (~2,000 words) on
// 2026-07-22: Gemini vision + Claude ~30s, then Claude's copy pass 178s. 60
// seconds is not enough — a long-copy source would 504 mid-generation. 300 is
// the ceiling Vercel allows on every plan; the image is shot separately, after
// the copy is already on screen, so it doesn't add to this budget.
export const maxDuration = 300;

// Step 1 → 3b on one screen. Pick a winner, press one button, get the concept.
// The per-step screens (/library, /deconstruct, /rebuild, /review) still exist
// for reading and editing; this is the path for getting a concept out fast.

type Search = {
  days?: string; // run-length window: 7 | 14 | 30 | 60
  brand?: string; // advertiser (atria_brand_id)
};

// Copied off the Facebook Ad Library's own date chips. Ours filters by how long
// the ad has been RUNNING, which is the signal we actually have — see the note
// under the chips and CLAUDE.md hard constraint 1.
const WINDOWS = [7, 14, 30, 60] as const;

export default async function MakePage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const db = await createClient();

  const days = WINDOWS.find((w) => String(w) === sp.days) ?? null;

  let q = db
    .from('ads_scored')
    .select(
      'id, atria_ad_id, platform_native_id, source, kind, storage_path, source_url, atria_brand_id, brand_name, title, status, images, videos, winner_score, run_days, start_date, end_date, created_at',
    )
    .in('source', ['upload', 'meta']);

  if (days) q = q.gte('run_days', days);
  if (sp.brand) q = q.eq('atria_brand_id', sp.brand);

  // Winner Score high→low. This is the honest stand-in for the Ad Library's
  // "highest impressions" sort — Atria returns no impressions, no reach and no
  // spend, so longevity is the only performance signal that exists.
  const { data, error } = await q
    .order('winner_score', { ascending: false, nullsFirst: false })
    .order('run_days', { ascending: false, nullsFirst: false })
    .limit(40);

  interface Row {
    id: string;
    atria_ad_id: string;
    platform_native_id: string | null;
    source: 'upload' | 'meta';
    kind: 'image' | 'video' | null;
    storage_path: string | null;
    source_url: string | null;
    atria_brand_id: string | null;
    brand_name: string | null;
    title: string | null;
    status: 'active' | 'inactive' | null;
    images: { url: string }[] | null;
    videos: { url: string }[] | null;
    winner_score: number | null;
    run_days: number | null;
    start_date: string | null;
    end_date: string | null;
  }
  const rows = (data ?? []) as unknown as Row[];

  // Same art resolution as the Library: prefer our re-hosted copy, fall back to
  // Atria's CDN. A Meta row's source_url is the page, never the creative.
  const art = new Map<string, { url: string | null; isVideo: boolean }>();
  await Promise.all(
    rows.map(async (r) => {
      const isVideo = r.kind === 'video';
      let url: string | null;
      if (r.storage_path) {
        const { data: signed } = await db.storage
          .from('library')
          .createSignedUrl(r.storage_path, 3600);
        url = signed?.signedUrl ?? null;
      } else if (r.source === 'upload') {
        url = r.source_url;
      } else {
        url = isVideo ? (r.videos?.[0]?.url ?? null) : (r.images?.[0]?.url ?? null);
      }
      art.set(r.id, { url, isVideo });
    }),
  );

  const items: CardItem[] = rows.map((r) => {
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

  // Our brands, flagged by whether they actually have readable research. A brand
  // without it can't ground a rebuild, so it isn't offered.
  const [{ data: ourBrands }, { data: docRows }] = await Promise.all([
    db.from('brands').select('id, name').eq('is_tracked', false).order('name'),
    db.from('brand_docs').select('brand_id, extracted_text'),
  ]);
  const groundedIds = new Set(
    ((docRows ?? []) as { brand_id: string; extracted_text: string | null }[])
      .filter((d) => (d.extracted_text ?? '').trim())
      .map((d) => d.brand_id),
  );
  const brands: BrandOption[] = (ourBrands ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    grounded: groundedIds.has(b.id),
  }));

  // Advertisers, for the rail sub-filter.
  const { data: metaBrandsRaw } = await db
    .from('ads_scored')
    .select('atria_brand_id, brand_name')
    .eq('source', 'meta');
  const tally = new Map<string, { name: string; n: number }>();
  for (const r of (metaBrandsRaw ?? []) as {
    atria_brand_id: string | null;
    brand_name: string | null;
  }[]) {
    if (!r.atria_brand_id) continue;
    const cur = tally.get(r.atria_brand_id);
    if (cur) cur.n += 1;
    else tally.set(r.atria_brand_id, { name: r.brand_name ?? 'Meta ad', n: 1 });
  }
  const advertisers = [...tally.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

  const qs = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/make?${s}` : '/make';
  };

  return (
    <div className="workbench">
      <aside className="rail">
        <AddToLibrary />

        <div className="rail-group">
          <p className="eyebrow">Running for</p>
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
          <p className="rail-note" style={{ marginTop: 10 }}>
            These are the Ad Library&rsquo;s date chips, filtering on <strong>how long the ad has
            been running</strong> — 30d+ means it has been live at least 30 days. Sorted by Winner
            Score, which is that same longevity. Meta publishes <strong>no impressions</strong> for
            ecom ads and neither does Atria, so there is nothing to sort by reach; an ad still
            paying to run after 60 days is the closest honest signal.
          </p>
        </div>

        {advertisers.length > 0 && (
          <div className="rail-group">
            <p className="eyebrow">Advertiser</p>
            <Link
              href={qs({ brand: undefined })}
              className={`source${!sp.brand ? ' is-on' : ''}`}
            >
              <span className="source-name">All</span>
            </Link>
            {advertisers.map((b) => (
              <Link
                key={b.id}
                href={qs({ brand: sp.brand === b.id ? undefined : b.id })}
                className={`source${sp.brand === b.id ? ' is-on' : ''}`}
              >
                <span className="source-name">{b.name}</span>
                <span className="source-count num">{b.n}</span>
              </Link>
            ))}
          </div>
        )}
      </aside>

      <main className="sheet">
        <div className="sheet-head">
          <h1 className="sheet-title">Make</h1>
          <p className="sheet-sub">
            pick a winner · one button · deconstruct + rebuild in one pass
            {days ? ` · running ${days}d+` : ''} · {items.length} shown
          </p>
          <Link className="chip" href="/library">
            Full library →
          </Link>
        </div>

        {error && <p className="gate-error">Could not load: {error.message}</p>}

        <MakeDesk items={items} brands={brands} />
      </main>
    </div>
  );
}
