import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { RunDates } from '@/app/components/WinnerScoreNote';

// Step 3b, index: pick a deconstructed ad to rebuild.
//
// Deconstructed ads come first on purpose. A rebuild borrows the source ad's
// structure, and the deconstruction is where that structure is written down —
// rebuilding an ad nobody has read yet means Claude works from the copy alone.

interface Row {
  id: string;
  atria_ad_id: string;
  brand_name: string | null;
  title: string | null;
  status: 'active' | 'inactive';
  images: { url: string }[] | null;
  start_date: string | null;
  end_date: string | null;
  run_days: number | null;
  brand_percentile: number | null;
  is_winner: boolean;
}

export default async function RebuildIndexPage() {
  const db = await createClient();

  // Which ads have been read already, and which already have rebuilds.
  const { data: decons } = await db.from('deconstructions').select('ad_id');
  const readIds = [...new Set((decons ?? []).map((d) => d.ad_id as string))];

  const { data: existing } = await db.from('rebuilds').select('ad_id, status');
  const rebuildsByAd = new Map<string, number>();
  for (const r of existing ?? []) {
    rebuildsByAd.set(r.ad_id as string, (rebuildsByAd.get(r.ad_id as string) ?? 0) + 1);
  }

  const { data: ads } = readIds.length
    ? await db
        .from('ads_scored')
        .select(
          'id, atria_ad_id, brand_name, title, status, images, start_date, end_date, run_days, brand_percentile, is_winner',
        )
        .in('id', readIds)
        .order('brand_percentile', { ascending: false, nullsFirst: false })
        .limit(60)
    : { data: [] as Row[] };

  const rows = (ads ?? []) as unknown as Row[];

  // Grounding is a precondition, so say so here rather than at the point of failure.
  const { data: ourBrands } = await db.from('brands').select('id, name').eq('is_tracked', false);
  const { data: docs } = await db.from('brand_docs').select('brand_id, extracted_text');
  const groundedBrandIds = new Set(
    (docs ?? []).filter((d) => (d.extracted_text ?? '').trim()).map((d) => d.brand_id as string),
  );
  const ready = (ourBrands ?? []).filter((b) => groundedBrandIds.has(b.id));

  return (
    <main className="sheet" style={{ padding: 24 }}>
      <div className="sheet-head">
        <h1 className="sheet-title">Rebuild</h1>
        <p className="sheet-sub">
          {rows.length} deconstructed ad{rows.length === 1 ? '' : 's'} · {ready.length} grounded
          brand{ready.length === 1 ? '' : 's'} to rebuild against
        </p>
      </div>

      {ready.length === 0 && (
        <div className="scoreblock" style={{ marginBottom: 18 }}>
          <p className="proxy" style={{ margin: 0 }}>
            No brand has readable research on file, so every rebuild would be ungrounded —{' '}
            <b>which is blocked, not warned about</b>. Upload brand, audience, or mechanism docs
            on the <Link href="/brand">Brand</Link> screen first.
          </p>
        </div>
      )}

      {rows.length === 0 && (
        <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
          Nothing has been deconstructed yet. Read an ad on the{' '}
          <Link href="/library">Library</Link> first — the rebuild borrows its structure, and the
          deconstruction is where that structure gets written down.
        </p>
      )}

      <div className="grid">
        {rows.map((ad) => {
          const art = ad.images?.[0]?.url;
          const n = rebuildsByAd.get(ad.id) ?? 0;
          return (
            <Link key={ad.id} href={`/rebuild/${ad.atria_ad_id}`} className="clip">
              <div className="clip-art">
                <span
                  className={`score${ad.is_winner ? ' is-hot' : ''}`}
                  title="Percentile of run length among this brand's live ads — not reach"
                >
                  {ad.brand_percentile ?? '—'}
                </span>
                {n > 0 && (
                  <span className="tag is-stamp clip-flag">
                    {n} rebuild{n === 1 ? '' : 's'}
                  </span>
                )}
                {art ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={art} alt="" loading="lazy" />
                ) : (
                  <div className="no-art">no image</div>
                )}
              </div>
              <div className="clip-meta">
                <div className="clip-brand">{ad.brand_name}</div>
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
  );
}
