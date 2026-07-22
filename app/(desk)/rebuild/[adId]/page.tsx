import Link from 'next/link';
import { notFound } from 'next/navigation';

// runRebuild is a server action on this route: Claude's copy pass alone measured
// 178s on a ~2,000-word source ad, plus ~20s for Gemini's image. With no
// maxDuration set this inherited a limit far below that and 504'd mid-rebuild on
// long copy. Same 300s ceiling as /make.
export const maxDuration = 300;

import { createClient } from '@/lib/supabase/server';
import { Clamp } from '@/app/components/Clamp';
import { RebuildButton } from './RebuildButton';
import { RebuildEditor } from './RebuildEditor';
import { ReviewControls } from '@/app/(desk)/review/ReviewControls';

// Step 3b, the editorial layout: the source ad and its deconstruction on the
// left, our generated creative in the middle, our copy on the right — editable
// while it is the author's to change, read-only once a reviewer has it.
//
// The three columns are the judgement a buyer makes in order: what was the ad
// doing (left), what did we shoot (middle), does the copy borrow the structure
// and replace the substance (right).

interface ReviewEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string | null;
  created_at: string;
}

interface Mark {
  heading: string;
  body: string;
}

interface Rebuild {
  id: string;
  headline: string | null;
  alternates: string[] | null;
  copy: string | null;
  cta: string | null;
  notes: string | null;
  art_direction: string | null;
  image_path: string | null;
  status: 'draft' | 'waiting' | 'changes_asked' | 'approved';
  grounding_doc_ids: string[];
  created_at: string;
  brand_id: string;
}

interface Doc {
  id: string;
  brand_id: string;
  kind: 'brand' | 'audience' | 'mechanism';
  title: string;
  version: number;
  extracted_text: string | null;
}

export default async function RebuildAdPage({
  params,
}: {
  params: Promise<{ adId: string }>;
}) {
  const { adId } = await params;
  const db = await createClient();

  const { data: ad } = await db
    .from('ads_scored')
    .select('*')
    .eq('atria_ad_id', adId)
    .maybeSingle();
  if (!ad) notFound();

  const { data: ourBrands } = await db
    .from('brands')
    .select('id, name')
    .eq('is_tracked', false)
    .order('name');

  const { data: docRows } = await db
    .from('brand_docs')
    .select('id, brand_id, kind, title, version, extracted_text');
  const docs = (docRows ?? []) as unknown as Doc[];

  const groundedIds = new Set(
    docs.filter((d) => (d.extracted_text ?? '').trim()).map((d) => d.brand_id),
  );
  const brands = (ourBrands ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    grounded: groundedIds.has(b.id),
  }));

  const { data: decon } = await db
    .from('deconstructions')
    .select('summary, marks')
    .eq('ad_id', ad.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const marks = ((decon?.marks ?? []) as Mark[]).map((m) => ({
    heading: m.heading,
    body: m.body,
  }));

  const { data: rebuildRows } = await db
    .from('rebuilds')
    .select(
      'id, headline, alternates, copy, cta, notes, art_direction, image_path, status, grounding_doc_ids, created_at, brand_id',
    )
    .eq('ad_id', ad.id)
    .order('created_at', { ascending: false });

  const rebuilds = (rebuildRows ?? []) as unknown as Rebuild[];
  const latest = rebuilds[0] ?? null;

  // The review trail for the shown rebuild — oldest first, so it reads as a story.
  const { data: eventRows } = latest
    ? await db
        .from('review_events')
        .select('id, from_status, to_status, note, created_at')
        .eq('rebuild_id', latest.id)
        .order('created_at', { ascending: true })
    : { data: [] as ReviewEvent[] };
  const events = (eventRows ?? []) as ReviewEvent[];

  // Signed URL, not public: the rebuilds bucket is private and stays that way.
  let art: string | null = null;
  if (latest?.image_path) {
    const { data } = await db.storage.from('rebuilds').createSignedUrl(latest.image_path, 3600);
    art = data?.signedUrl ?? null;
  }

  const brandName = (id: string) => brands.find((b) => b.id === id)?.name ?? 'unknown brand';
  // Latest version we hold per brand+kind, so a grounding doc can be flagged when
  // it has since been superseded (CLAUDE.md known-open: show staleness, stay
  // quiet when current).
  const latestVersion = new Map<string, number>();
  for (const d of docs) {
    const key = `${d.brand_id}:${d.kind}`;
    latestVersion.set(key, Math.max(latestVersion.get(key) ?? 0, d.version));
  }
  const groundingDocs = (latest?.grounding_doc_ids ?? []).map((id) => {
    const d = docs.find((x) => x.id === id);
    if (!d) return { id, label: 'a doc since removed', kind: '', version: null, stale: false };
    const key = `${d.brand_id}:${d.kind}`;
    return {
      id,
      label: d.title,
      kind: d.kind,
      version: d.version,
      stale: (latestVersion.get(key) ?? d.version) > d.version,
    };
  });

  // The source creative. Uploaded files are in the private bucket → sign them;
  // references and Atria/Meta rows carry a URL (videos[] for a video, images[]
  // otherwise). A Meta row's source_url is the Facebook page, never the art.
  const sourceIsVideo = ad.kind === 'video';
  let sourceArt: string | null;
  if (ad.source === 'upload') {
    if (ad.storage_path) {
      const { data } = await db.storage.from('library').createSignedUrl(ad.storage_path, 3600);
      sourceArt = data?.signedUrl ?? null;
    } else {
      sourceArt = ad.source_url ?? null;
    }
  } else {
    sourceArt = sourceIsVideo
      ? ((ad.videos as { url: string }[] | null)?.[0]?.url ?? null)
      : ((ad.images as { url: string }[] | null)?.[0]?.url ?? null);
  }
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');
  const editable = latest?.status === 'draft' || latest?.status === 'changes_asked';

  return (
    <>
      <div className="proofbar">
        <Link href="/rebuild" className="backlink">
          ← Rebuild
        </Link>
        <span className="proofbar-title">{ad.brand_name ?? (ad.source === 'upload' ? 'Upload' : 'Meta ad')}</span>
        {ad.status && (
          <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
            {ad.status === 'active' ? 'live' : 'ended'}
          </span>
        )}
        {latest && (
          <span className="proofbar-brand">
            → {brandName(latest.brand_id)}
            <span
              className={`tag is-${latest.status === 'approved' ? 'live' : 'stamp'}`}
              style={{ marginLeft: 8 }}
            >
              {latest.status.replace('_', ' ')}
            </span>
          </span>
        )}
        <span className="spacer" />
        <RebuildButton adId={adId} brands={brands} again={!!latest} />
      </div>

      {!latest ? (
        // Nothing rebuilt yet — the source on the left, the pitch on the right.
        <div className="spread">
          <div className="proof-stage">
            <figure className="proof">
              <div className="proof-art">
                {sourceArt ? (
                  sourceIsVideo ? (
                    <video src={sourceArt} controls preload="metadata" style={{ width: '100%' }} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sourceArt} alt="" />
                  )
                ) : (
                  <div className="no-art">no image on this ad</div>
                )}
              </div>
              <figcaption className="proof-cap">
                <span>{ad.atria_ad_id}</span>
                <span>theirs</span>
                <span className="spacer" />
                <span>
                  {day(ad.start_date)} →{' '}
                  {ad.status === 'active' ? 'still running' : day(ad.end_date)}
                </span>
              </figcaption>
            </figure>
          </div>

          <aside className="notes">
            <div className="scoreblock">
              <p className="proxy" style={{ margin: 0 }}>
                Structure is borrowed from the ad on the left. Every claim comes from our own
                research — <b>nothing generates without it</b>.
              </p>
            </div>
            <div className="notes-sec">
              <p className="eyebrow">As it ran</p>
              {ad.title && (
                <p className="note-h" style={{ marginTop: 8, fontSize: 13 }}>
                  {ad.title}
                </p>
              )}
              {ad.body && <Clamp text={ad.body} lines={8} />}
            </div>
            <div className="notes-sec">
              <p className="eyebrow">Ours</p>
              <p className="rail-note" style={{ marginTop: 8 }}>
                Not rebuilt yet. Pick a grounded brand above — Claude writes the headline and copy
                against its research, then Gemini shoots the creative. One to three minutes,
                depending on how long the source ad&rsquo;s copy is.
              </p>
            </div>
          </aside>
        </div>
      ) : (
        <div className="editorial">
          {/* LEFT — the source and why it works */}
          <aside className="ed-col ed-source">
            <p className="eyebrow">Original</p>
            <figure className="proof" style={{ marginTop: 10, width: '100%' }}>
              <div className="proof-art">
                {sourceArt ? (
                  sourceIsVideo ? (
                    <video src={sourceArt} controls preload="metadata" style={{ width: '100%' }} />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sourceArt} alt="" />
                  )
                ) : (
                  <div className="no-art">no image on this ad</div>
                )}
              </div>
              <figcaption className="proof-cap">
                <span>theirs</span>
                <span className="spacer" />
                <span>
                  {day(ad.start_date)} → {ad.status === 'active' ? 'live' : day(ad.end_date)}
                </span>
              </figcaption>
            </figure>

            {/* The original copy we borrowed from — so a reviewer can see the
                source headline/body/CTA next to what we wrote. */}
            {(ad.title || ad.body) && (
              <div className="notes-sec">
                <p className="eyebrow">As it ran</p>
                {ad.title && (
                  <p className="note-h" style={{ marginTop: 8, fontSize: 13 }}>
                    {ad.title}
                  </p>
                )}
                {ad.body && (
                  <div style={{ marginTop: 6 }}>
                    <Clamp text={ad.body} lines={6} />
                  </div>
                )}
                {ad.cta_text && (
                  <p className="by" style={{ marginTop: 8 }}>
                    CTA: {ad.cta_text}
                  </p>
                )}
              </div>
            )}

            {decon?.summary && (
              <div className="notes-sec">
                <p className="eyebrow">Structure</p>
                <div style={{ marginTop: 8 }}>
                  <Clamp text={decon.summary} lines={6} />
                </div>
              </div>
            )}

            {marks.length > 0 && (
              <div className="notes-sec">
                <p className="eyebrow">The moves we marked</p>
                {marks.map((m, i) => (
                  <div key={i} className="ed-move">
                    <span className="ed-move-n">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <p className="note-h" style={{ fontSize: 11 }}>
                        {m.heading}
                      </p>
                      <p className="note-b">{m.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="notes-sec">
              <p className="eyebrow">Grounded in</p>
              {groundingDocs.map((d) => (
                <div key={d.id} className="ed-doc">
                  <span className="note-b" style={{ marginTop: 0 }}>
                    {d.kind ? `${d.kind}: ` : ''}
                    {d.label}
                  </span>
                  {d.version != null && (
                    <span className={`tag ${d.stale ? 'is-pencil' : ''} ed-ver`}>
                      v{d.version}
                      {d.stale ? ' · stale' : ''}
                    </span>
                  )}
                </div>
              ))}
              <p className="by">
                {day(latest.created_at)}
                {rebuilds.length > 1 ? ` · ${rebuilds.length - 1} earlier` : ''}
              </p>
            </div>
          </aside>

          {/* MIDDLE — our creative */}
          <div className="ed-col ed-art">
            {art ? (
              <figure className="proof" style={{ width: '100%' }}>
                <div className="proof-art">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={art} alt="" />
                </div>
                <figcaption className="proof-cap">
                  <span>ours</span>
                  <span className="spacer" />
                  <span>generated</span>
                </figcaption>
              </figure>
            ) : (
              <div className="ed-noart">
                <p className="note-h" style={{ fontSize: 12 }}>
                  No image
                </p>
                <p className="rail-note" style={{ marginTop: 6, border: 0, padding: 0 }}>
                  The copy generated but the art didn&rsquo;t. Use <b>Rebuild again</b> to reshoot.
                </p>
              </div>
            )}

            {latest.art_direction && (
              <div className="notes-sec" style={{ marginTop: 18 }}>
                <p className="eyebrow">Art direction</p>
                <div style={{ marginTop: 8 }}>
                  <Clamp text={latest.art_direction} lines={4} />
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — our copy */}
          <div className="ed-col ed-copy">
            {editable ? (
              <RebuildEditor
                adId={adId}
                rebuildId={latest.id}
                status={latest.status as 'draft' | 'changes_asked'}
                initial={{
                  headline: latest.headline ?? '',
                  alternates: latest.alternates ?? [],
                  copy: latest.copy ?? '',
                  cta: latest.cta ?? '',
                  notes: latest.notes,
                }}
              />
            ) : (
              <div className="ed-read">
                <p className="eyebrow">Headline</p>
                <p className="ed-headline">{latest.headline}</p>
                {latest.cta && (
                  <p className="ed-cta-line">
                    <span className="eyebrow">CTA</span> {latest.cta}
                  </p>
                )}
                <div className="notes-sec">
                  <p className="eyebrow">Body copy</p>
                  {latest.copy && (
                    <div style={{ marginTop: 8 }}>
                      <Clamp text={latest.copy} lines={16} />
                    </div>
                  )}
                </div>
                {latest.notes && (
                  <div className="notes-sec">
                    <p className="eyebrow">Notes from Claude</p>
                    <p className="note-b" style={{ marginTop: 6 }}>
                      {latest.notes}
                    </p>
                  </div>
                )}
              </div>
            )}

            <div className="notes-sec">
              <p className="eyebrow">Review</p>
              {events.length > 0 && (
                <div style={{ margin: '8px 0 12px' }}>
                  {events.map((e) => (
                    <div key={e.id} className="review-event">
                      <span className="review-event-move">
                        {(e.from_status ?? 'new').replace('_', ' ')} →{' '}
                        {e.to_status.replace('_', ' ')}
                      </span>
                      {e.note && <span className="review-event-note">{e.note}</span>}
                      <span className="by" style={{ margin: 0 }}>
                        {day(e.created_at)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/* Draft and changes_asked send from the editor; waiting/approved
                  get the reviewer's controls here. */}
              {!editable && (
                <div style={{ marginTop: 8 }}>
                  <ReviewControls rebuildId={latest.id} status={latest.status} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
