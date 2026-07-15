import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { WinnerScoreNote, RunDates } from '@/app/components/WinnerScoreNote';

// Steps 1–2 of the workflow: find ads, filter for winners.
// Server Component — the Supabase client here acts as the signed-in user, so
// RLS decides what comes back. A non-member gets an empty desk, not a 403.

type Search = {
  brand?: string;
  format?: string;
  status?: string;
  winners?: string;
  sort?: string;
};

interface ScoredAd {
  id: string;
  atria_ad_id: string;
  brand_name: string | null;
  title: string | null;
  status: 'active' | 'inactive';
  display_format: string | null;
  images: { url: string; width: number; height: number }[] | null;
  start_date: string | null;
  end_date: string | null;
  run_days: number | null;
  brand_percentile: number | null;
  is_winner: boolean;
  winner_override: boolean | null;
}

const SORTS = {
  score: { col: 'brand_percentile', label: 'Score' },
  run: { col: 'run_days', label: 'Longest run' },
  new: { col: 'start_date', label: 'Newest' },
} as const;

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const sortKey = (sp.sort && sp.sort in SORTS ? sp.sort : 'score') as keyof typeof SORTS;
  const db = await createClient();

  const { data: brands } = await db
    .from('brands')
    .select('id, name, atria_brand_id')
    .eq('is_tracked', true)
    .order('name');

  let q = db
    .from('ads_scored')
    .select(
      'id, atria_ad_id, brand_name, title, status, display_format, images, start_date, end_date, run_days, brand_percentile, is_winner, winner_override',
    );

  if (sp.brand) q = q.eq('atria_brand_id', sp.brand);
  if (sp.format) q = q.eq('display_format', sp.format);
  if (sp.status) q = q.eq('status', sp.status);
  if (sp.winners === '1') q = q.is('is_winner', true);

  const { data: ads, error } = await q
    .order(SORTS[sortKey].col, { ascending: false, nullsFirst: false })
    .limit(60);

  // Counts for the rail, scoped the same way RLS scopes everything else.
  const counts = await Promise.all(
    (brands ?? []).map(async (b) => {
      const { count } = await db
        .from('ads_scored')
        .select('id', { count: 'exact', head: true })
        .eq('atria_brand_id', b.atria_brand_id!);
      return { id: b.atria_brand_id!, count: count ?? 0 };
    }),
  );

  const { count: totalAds } = await db
    .from('ads_scored')
    .select('id', { count: 'exact', head: true });
  const { count: winnerCount } = await db
    .from('ads_scored')
    .select('id', { count: 'exact', head: true })
    .is('is_winner', true);

  const qs = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/library?${s}` : '/library';
  };

  const rows = (ads ?? []) as unknown as ScoredAd[];

  return (
    <div className="workbench">
      <aside className="rail">
        <div className="rail-group">
          <p className="eyebrow">Tracked sources</p>
          <Link href={qs({ brand: undefined })} className={`source${!sp.brand ? ' is-on' : ''}`}>
            <span className="source-name">All brands</span>
            <span className="source-count num">{totalAds ?? 0}</span>
          </Link>
          {(brands ?? []).map((b) => (
            <Link
              key={b.id}
              href={qs({ brand: b.atria_brand_id ?? undefined })}
              className={`source is-tracked${sp.brand === b.atria_brand_id ? ' is-on' : ''}`}
            >
              <span className="source-name">{b.name}</span>
              <span className="source-count num">
                {counts.find((c) => c.id === b.atria_brand_id)?.count ?? 0}
              </span>
            </Link>
          ))}
        </div>

        <div className="rail-group">
          <p className="eyebrow">Format</p>
          {['image', 'video', 'carousel', 'dco', 'dpa'].map((f) => (
            <Link
              key={f}
              href={qs({ format: sp.format === f ? undefined : f })}
              className="opt"
              style={{ color: sp.format === f ? 'var(--pencil)' : undefined }}
            >
              {f}
            </Link>
          ))}
        </div>

        <div className="rail-group">
          <p className="eyebrow">Status</p>
          {(['active', 'inactive'] as const).map((s) => (
            <Link
              key={s}
              href={qs({ status: sp.status === s ? undefined : s })}
              className="opt"
              style={{ color: sp.status === s ? 'var(--pencil)' : undefined }}
            >
              {s === 'active' ? 'Live' : 'Ended'}
            </Link>
          ))}
        </div>

        <div className="rail-group">
          <p className="eyebrow">Winner Score</p>
          <Link
            href={qs({ winners: sp.winners === '1' ? undefined : '1' })}
            className="opt"
            style={{ color: sp.winners === '1' ? 'var(--pencil)' : undefined }}
          >
            Winners only <span className="num">{winnerCount ?? 0}</span>
          </Link>
          <div style={{ marginTop: 10 }}>
            <WinnerScoreNote />
          </div>
        </div>
      </aside>

      <main className="sheet">
        <div className="sheet-head">
          <h1 className="sheet-title">{sp.winners === '1' ? 'Winners' : 'Library'}</h1>
          <p className="sheet-sub">
            {totalAds ?? 0} ads pulled · {winnerCount ?? 0} winners · showing {rows.length}
          </p>
          <div className="sortbar">
            <span className="eyebrow">Sort</span>
            {Object.entries(SORTS).map(([k, v]) => (
              <Link key={k} href={qs({ sort: k })} className={`chip${sortKey === k ? ' is-on' : ''}`}>
                {v.label}
              </Link>
            ))}
          </div>
        </div>

        {error && (
          <p style={{ color: 'var(--pencil)' }}>Could not load ads: {error.message}</p>
        )}

        {!error && rows.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
            Nothing matches. If the whole library is empty, ingest hasn&rsquo;t run yet.
          </p>
        )}

        <div className="grid">
          {rows.map((ad) => {
            const art = ad.images?.[0]?.url;
            return (
              <Link key={ad.id} href={`/deconstruct/${ad.atria_ad_id}`} className="clip">
                <div className="clip-art">
                  <span
                    className={`score${ad.is_winner ? ' is-hot' : ''}`}
                    title="Percentile of run length among this brand's live ads — not reach"
                  >
                    {ad.brand_percentile ?? '—'}
                  </span>
                  {ad.winner_override && <span className="tag is-pencil clip-flag">by hand</span>}
                  {art ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={art} alt="" loading="lazy" />
                  ) : (
                    <div className="no-art">{ad.display_format ?? 'no image'}</div>
                  )}
                </div>
                <div className="clip-meta">
                  <div className="clip-brand">
                    {ad.brand_name}
                    <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
                      {ad.status === 'active' ? 'live' : 'ended'}
                    </span>
                  </div>
                  {ad.title && <div className="clip-title">{ad.title}</div>}
                  <div className="clip-run">
                    <RunDates
                      startDate={ad.start_date}
                      endDate={ad.end_date}
                      status={ad.status}
                      runDays={ad.run_days}
                    />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
