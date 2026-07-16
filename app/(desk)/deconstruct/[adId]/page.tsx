import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { Proof, type Mark } from '@/app/components/Proof';
import { Clamp } from '@/app/components/Clamp';
import { DeconstructButton } from './DeconstructButton';

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

  const art = (ad.images as { url: string }[] | null)?.[0]?.url ?? null;
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
        <span className="proofbar-title">{ad.brand_name}</span>
        <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
          {ad.status === 'active' ? 'live' : 'ended'}
        </span>
        <span className="spacer" />
        <DeconstructButton adId={adId} again={!!decon} />
      </div>

      <Proof
        art={art}
        marks={marks}
        caption={
          <>
            <span>{ad.atria_ad_id}</span>
            <span>{ad.display_format ?? '—'}</span>
            <span className="spacer" />
            <span>
              {day(ad.start_date)} → {ad.status === 'active' ? 'still running' : day(ad.end_date)}
            </span>
          </>
        }
        panel={
          <>
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
                    {day(ad.start_date)} → {ad.status === 'active' ? 'still running' : day(ad.end_date)}
                  </div>
                </div>
              </div>
              <p className="proxy">
                Percentile of run length among this brand&rsquo;s live ads. Atria returns no
                impressions, so this is a longevity proxy — <b>not reach</b>. The dates it was
                derived from are above.
              </p>
            </div>

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
