import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Proof, type Mark } from '@/app/components/Proof';
import { Clamp } from '@/app/components/Clamp';
import { DeconstructButton } from './DeconstructButton';
import { CopyId } from './CopyId';

// runDeconstruction is a server action on this route: Gemini's read plus
// Claude's structural pass measured ~30s. Headroom for a slow CDN or a long ad.
export const maxDuration = 120;

// Step 3a: Gemini reads the image, Claude reads the structure.
// The score is never shown bare — the dates behind it and the note that it is
// not reach travel with it. See CLAUDE.md; this is not decoration.
export default async function DeconstructAdPage({
  params,
}: {
  params: Promise<{ adId: string }>;
}) {
  const { adId } = await params;
  const db = await createClient();

  const { data: ad } = await db.from('ads_scored').select('*').eq('atria_ad_id', adId).maybeSingle();
  if (!ad) notFound();

  // Latest run wins; re-running keeps the old rows rather than destroying work.
  const { data: decon } = await db
    .from('deconstructions')
    .select('summary, marks, model, created_at')
    .eq('ad_id', ad.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isVideo = ad.kind === 'video';
  // Resolve the creative. Uploaded files are signed from the private bucket;
  // references and Atria/Meta rows carry a URL (videos[] for a video, images[]
  // otherwise). A Meta row's source_url is the Facebook page, never the art.
  let art: string | null;
  if (ad.storage_path) {
    // Re-hosted in our private bucket (uploads, and meta winners) — permanent,
    // so Gemini reads our copy, not a CDN URL that may later expire.
    const { data: signed } = await db.storage
      .from('library')
      .createSignedUrl(ad.storage_path, 3600);
    art = signed?.signedUrl ?? null;
  } else if (ad.source === 'upload') {
    art = ad.source_url ?? null;
  } else {
    art = isVideo
      ? ((ad.videos as { url: string }[] | null)?.[0]?.url ?? null)
      : ((ad.images as { url: string }[] | null)?.[0]?.url ?? null);
  }

  const marks = ((decon?.marks ?? []) as Mark[]).filter(
    (m) => Number.isFinite(m?.x) && Number.isFinite(m?.y),
  );
  const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '—');

  return (
    <>
      <div className="proofbar">
        <Link href="/library" className="backlink">
          ← Library
        </Link>
        <span className="proofbar-title">{ad.brand_name ?? (ad.source === 'upload' ? 'Upload' : 'Meta ad')}</span>
        {ad.status && (
          <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
            {ad.status === 'active' ? 'live' : 'ended'}
          </span>
        )}
        <span className="spacer" />
        {isVideo ? (
          <span className="rail-note" style={{ border: 0, padding: 0 }}>
            Deconstruction supports images, not video, for now.
          </span>
        ) : (
          <DeconstructButton adId={adId} again={!!decon} />
        )}
      </div>

      <Proof
        art={art}
        isVideo={isVideo}
        marks={marks}
        caption={
          <>
            {ad.platform_native_id ? (
              // Copy, not link: Meta can't reliably deep-link a specific
              // low-impression clone, so we hand over the ID to paste into
              // Meta's own search rather than open a dead page.
              <CopyId id={ad.platform_native_id} />
            ) : (
              <span>{ad.atria_ad_id}</span>
            )}
            <span>{ad.display_format ?? '—'}</span>
            <span className="spacer" />
            {ad.start_date && (
              <span>
                {day(ad.start_date)} → {ad.status === 'active' ? 'still running' : day(ad.end_date)}
              </span>
            )}
          </>
        }
        panel={
          <>
            {/* Winner Score is a run-length proxy — only meaningful for ads that
                carry Atria run dates (meta/atria), never for a manual upload. */}
            {ad.source !== 'upload' && (
              <div className="scoreblock">
                <div className="scoreblock-row">
                  <span className="bignum">{ad.brand_percentile ?? '—'}</span>
                  <div className="scorefacts">
                    <div className="lead">Winner Score</div>
                    <div>
                      {ad.run_days ?? '—'} days running
                      {ad.winner_override ? ' · flagged by hand' : ''}
                    </div>
                    <div>
                      {day(ad.start_date)} →{' '}
                      {ad.status === 'active' ? 'still running' : day(ad.end_date)}
                    </div>
                  </div>
                </div>
                <p className="proxy">
                  Percentile of run length among this brand&rsquo;s live ads. Atria returns no
                  impressions, so this is a longevity proxy — <b>not reach</b>. The dates it was
                  derived from are above.
                </p>
              </div>
            )}

            {ad.title && (
              <div className="notes-sec">
                <p className="eyebrow">As it ran</p>
                <p className="note-h" style={{ marginTop: 8, fontSize: 13 }}>
                  {ad.title}
                </p>
                {ad.body && <Clamp text={ad.body} />}
                {ad.cta_text && (
                  <p className="by" style={{ marginTop: 8 }}>
                    CTA: {ad.cta_text}
                  </p>
                )}
              </div>
            )}

            {!decon && (
              <div className="notes-sec">
                <p className="eyebrow">Deconstruction</p>
                <p className="rail-note" style={{ marginTop: 8 }}>
                  Not run yet. Gemini reads the creative and Claude reads the structure; the
                  numbered marks land on the image and light up with these notes.
                </p>
              </div>
            )}
          </>
        }
        summary={decon?.summary ?? null}
        by={decon ? `${decon.model} · ${day(decon.created_at)}` : null}
      />
    </>
  );
}
