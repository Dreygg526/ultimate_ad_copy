import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { ReviewControls } from './ReviewControls';

// Step 3c as a table, matching the approved mockup: one row per rebuild, ordered
// by what needs a human. Columns are the questions a reviewer asks at a glance —
// what is it, who built it, what grounds it, where is it, how long has it sat.

type Status = 'draft' | 'waiting' | 'changes_asked' | 'approved';

interface Row {
  id: string;
  ad_id: string;
  brand_id: string;
  headline: string | null;
  status: Status;
  image_path: string | null;
  updated_at: string;
  created_by: string | null;
  grounding_doc_ids: string[];
}

interface Doc {
  id: string;
  brand_id: string;
  kind: 'brand' | 'audience' | 'mechanism';
  version: number;
}

type Filter = 'waiting' | 'mine' | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'mine', label: 'Mine' },
  { key: 'all', label: 'All' },
];

// Waiting first (it needs a decision), then changes asked, drafts, approved.
const RANK: Record<Status, number> = { waiting: 0, changes_asked: 1, draft: 2, approved: 3 };

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const { show } = await searchParams;
  const filter: Filter = show === 'mine' || show === 'all' ? show : 'waiting';

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  const { data: rows, error } = await db
    .from('rebuilds')
    .select('id, ad_id, brand_id, headline, status, image_path, updated_at, created_by, grounding_doc_ids')
    .order('updated_at', { ascending: false });

  const all = (rows ?? []) as unknown as Row[];

  const filtered = all
    .filter((r) => {
      if (filter === 'waiting') return r.status === 'waiting';
      if (filter === 'mine') return r.created_by === user?.id;
      return true;
    })
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (a.updated_at < b.updated_at ? 1 : -1));

  // Resolve the ids in the visible rows back to things a person recognises.
  const adIds = [...new Set(filtered.map((r) => r.ad_id))];
  const brandIds = [...new Set(filtered.map((r) => r.brand_id))];
  const creatorIds = [...new Set(filtered.map((r) => r.created_by).filter(Boolean) as string[])];

  const { data: ads } = adIds.length
    ? await db.from('ads_scored').select('id, atria_ad_id, brand_name, brand_percentile').in('id', adIds)
    : { data: [] };
  const { data: brands } = brandIds.length
    ? await db.from('brands').select('id, name').in('id', brandIds)
    : { data: [] };
  const { data: people } = creatorIds.length
    ? await db.from('profiles').select('id, full_name, email').in('id', creatorIds)
    : { data: [] };
  const { data: docRows } = await db.from('brand_docs').select('id, brand_id, kind, version');
  const docs = (docRows ?? []) as unknown as Doc[];

  const adOf = new Map((ads ?? []).map((a) => [a.id, a]));
  const brandName = (id: string) => (brands ?? []).find((b) => b.id === id)?.name ?? '—';
  const personName = (id: string | null) => {
    if (!id) return '—';
    const p = (people ?? []).find((x) => x.id === id);
    return p?.full_name ?? p?.email ?? 'a teammate';
  };

  // Latest version per brand+kind, to flag a grounding doc that has been superseded.
  const docOf = new Map(docs.map((d) => [d.id, d]));
  const latestVersion = new Map<string, number>();
  for (const d of docs) {
    const key = `${d.brand_id}:${d.kind}`;
    latestVersion.set(key, Math.max(latestVersion.get(key) ?? 0, d.version));
  }
  const grounding = (ids: string[]) =>
    ids
      .map((id) => docOf.get(id))
      .filter((d): d is Doc => !!d)
      .sort((a, b) => a.kind.localeCompare(b.kind))
      .map((d) => ({
        key: d.id,
        label: `${d.kind[0].toUpperCase()} v${d.version}`,
        stale: (latestVersion.get(`${d.brand_id}:${d.kind}`) ?? d.version) > d.version,
      }));

  // Thumbnails: private bucket, so sign each visible one.
  const artOf = new Map<string, string>();
  await Promise.all(
    filtered.map(async (r) => {
      if (!r.image_path) return;
      const { data } = await db.storage.from('rebuilds').createSignedUrl(r.image_path, 3600);
      if (data?.signedUrl) artOf.set(r.id, data.signedUrl);
    }),
  );

  const counts = {
    waiting: all.filter((r) => r.status === 'waiting').length,
    changes: all.filter((r) => r.status === 'changes_asked').length,
    approved: all.filter((r) => r.status === 'approved').length,
  };

  const statusTag = (s: Status) => {
    const cls = s === 'approved' ? 'is-live' : s === 'changes_asked' ? 'is-pencil' : s === 'waiting' ? 'is-stamp' : '';
    return <span className={`tag ${cls}`}>{s.replace('_', ' ')}</span>;
  };

  return (
    <main className="sheet" style={{ padding: 24 }}>
      <div className="sheet-head">
        <h1 className="sheet-title">Review</h1>
        <p className="sheet-sub">
          {counts.waiting} waiting · {counts.changes} in changes · {counts.approved} approved
        </p>
        <div className="sortbar">
          <span className="eyebrow">Show</span>
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === 'waiting' ? '/review' : `/review?show=${f.key}`}
              className={`chip ${filter === f.key ? 'is-on' : ''}`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {error && <p style={{ color: 'var(--pencil)' }}>Could not load the queue: {error.message}</p>}

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
          {filter === 'waiting'
            ? 'Nothing waiting on a decision. '
            : filter === 'mine'
              ? 'You haven’t built any rebuilds yet. '
              : 'Nothing to review yet. '}
          Rebuild an ad on the <Link href="/rebuild">Rebuild</Link> screen, then send it here.
        </p>
      ) : (
        <div className="rev-table-wrap">
          <table className="rev-table">
            <thead>
              <tr>
                <th>Rebuild</th>
                <th>Built by</th>
                <th>Grounded in</th>
                <th>Status</th>
                <th>Waiting</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const ad = adOf.get(r.ad_id);
                const href = ad ? `/rebuild/${ad.atria_ad_id}` : '/rebuild';
                const pct = ad?.brand_percentile;
                return (
                  <tr key={r.id}>
                    <td>
                      <Link href={href} className="rev-rebuild">
                        <span className="rev-thumb">
                          {artOf.has(r.id) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={artOf.get(r.id)} alt="" />
                          ) : (
                            <span className="rev-thumb-none">—</span>
                          )}
                        </span>
                        <span className="rev-rebuild-txt">
                          <span className="rev-head">{r.headline ?? '(no headline)'}</span>
                          <span className="rev-sub">
                            for {brandName(r.brand_id)} · from {ad?.brand_name ?? 'an ad'}
                            {pct != null ? ` · score ${pct}` : ''}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td className="rev-who">{personName(r.created_by)}</td>
                    <td>
                      <span className="rev-ground">
                        {grounding(r.grounding_doc_ids).map((g) => (
                          <span key={g.key} className={`rev-ver ${g.stale ? 'is-stale' : ''}`}>
                            {g.label}
                            {g.stale ? '!' : ''}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td>{statusTag(r.status)}</td>
                    <td className="rev-age">{r.status === 'waiting' ? ago(r.updated_at) : '—'}</td>
                    <td className="rev-actions">
                      <ReviewControls rebuildId={r.id} status={r.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
