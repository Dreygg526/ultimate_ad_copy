import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { AddToLibrary } from './AddToLibrary';
import { DeleteButton } from './DeleteButton';

// Step 1, rebuilt: the Library is a curated swipe file the buyer stocks — files
// uploaded straight to Storage, and ads pulled from a Meta Ad Library URL. Both
// are `ads` rows (source 'upload' | 'meta'), so opening one runs the same
// Deconstruct → Rebuild workflow. The old Atria tracked-brand feed and its
// Winner Score are retired here; those rows stay in the DB but are filtered out.

type Search = { source?: string; kind?: string; q?: string };

interface Item {
  id: string;
  atria_ad_id: string;
  source: 'upload' | 'meta';
  kind: 'image' | 'video' | null;
  storage_path: string | null;
  source_url: string | null;
  brand_name: string | null;
  title: string | null;
  status: 'active' | 'inactive' | null;
  images: { url: string }[] | null;
  videos: { url: string }[] | null;
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
      'id, atria_ad_id, source, kind, storage_path, source_url, brand_name, title, status, images, videos, created_at',
    )
    .in('source', ['upload', 'meta']);

  if (sp.source === 'upload' || sp.source === 'meta') q = q.eq('source', sp.source);
  if (sp.kind === 'image' || sp.kind === 'video') q = q.eq('kind', sp.kind);

  // Free-text over title / ids. Strip PostgREST-significant chars so the search
  // string can't break the .or() filter.
  const needle = (sp.q ?? '').trim().replace(/[,()*\\]/g, ' ').trim();
  if (needle) {
    q = q.or(
      `title.ilike.%${needle}%,atria_ad_id.ilike.%${needle}%,platform_native_id.ilike.%${needle}%`,
    );
  }

  const { data, error } = await q.order('created_at', { ascending: false }).limit(60);
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
      if (r.source === 'upload') {
        if (r.storage_path) {
          const { data: signed } = await db.storage
            .from('library')
            .createSignedUrl(r.storage_path, 3600);
          url = signed?.signedUrl ?? null;
        } else {
          url = r.source_url; // direct-link reference (image or video)
        }
      } else {
        url = isVideo ? (r.videos?.[0]?.url ?? null) : (r.images?.[0]?.url ?? null);
      }
      art.set(r.id, { url, isVideo });
    }),
  );

  // Rail counts, scoped by RLS like everything else.
  const countSource = async (src: 'upload' | 'meta') => {
    const { count } = await db
      .from('ads_scored')
      .select('id', { count: 'exact', head: true })
      .eq('source', src);
    return count ?? 0;
  };
  const [uploadN, metaN] = await Promise.all([countSource('upload'), countSource('meta')]);

  const qs = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, String(v));
    const s = next.toString();
    return s ? `/library?${s}` : '/library';
  };

  return (
    <div className="workbench">
      <aside className="rail">
        <AddToLibrary />

        <div className="rail-group">
          <p className="eyebrow">Source</p>
          <Link href={qs({ source: undefined })} className={`source${!sp.source ? ' is-on' : ''}`}>
            <span className="source-name">All</span>
            <span className="source-count num">{uploadN + metaN}</span>
          </Link>
          <Link
            href={qs({ source: sp.source === 'upload' ? undefined : 'upload' })}
            className={`source${sp.source === 'upload' ? ' is-on' : ''}`}
          >
            <span className="source-name">Uploads</span>
            <span className="source-count num">{uploadN}</span>
          </Link>
          <Link
            href={qs({ source: sp.source === 'meta' ? undefined : 'meta' })}
            className={`source${sp.source === 'meta' ? ' is-on' : ''}`}
          >
            <span className="source-name">From Meta</span>
            <span className="source-count num">{metaN}</span>
          </Link>
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
        </div>

        {error && <p style={{ color: 'var(--pencil)' }}>Could not load library: {error.message}</p>}

        {!error && rows.length === 0 && (
          <p style={{ color: 'var(--ink-soft)', maxWidth: '52ch' }}>
            Nothing here yet. Upload an image or video, or paste a Meta Ad Library URL, from the
            panel on the left.
          </p>
        )}

        <div className="grid">
          {rows.map((ad) => {
            const a = art.get(ad.id);
            return (
              <div key={ad.id} className="clip-wrap">
                <DeleteButton adId={ad.atria_ad_id} label={ad.title ?? ad.brand_name ?? 'this item'} />
                <Link href={`/deconstruct/${ad.atria_ad_id}`} className="clip">
                  <div className="clip-art">
                    {a?.isVideo && <span className="clip-play">▶ video</span>}
                    {a?.url ? (
                      a.isVideo ? (
                        <video src={a.url} muted preload="metadata" />
                      ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.url} alt="" loading="lazy" />
                      )
                    ) : (
                      <div className="no-art">{ad.kind ?? 'no preview'}</div>
                    )}
                  </div>
                  <div className="clip-meta">
                    <div className="clip-brand">
                      {ad.source === 'meta' ? (ad.brand_name ?? 'Meta ad') : 'Upload'}
                      {ad.source === 'meta' && ad.status && (
                        <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
                          {ad.status === 'active' ? 'live' : 'ended'}
                        </span>
                      )}
                      <span className="clip-kind">{ad.kind}</span>
                    </div>
                    {ad.title && <div className="clip-title">{ad.title}</div>}
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      </main>
    </div>
  );
}
