'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { makeConcept, shootImage, type ConceptState } from './actions';
import type { CardItem } from '../library/LibraryGrid';

// The whole workflow on one screen: pick a winner on the left, press one button,
// read the concept on the right. Deconstruct and Rebuild still exist as detail
// screens, but a buyer no longer has to walk them to get a concept out.

export interface BrandOption {
  id: string;
  name: string;
  grounded: boolean;
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

function GoButton({ ready }: { ready: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn is-go make-go" disabled={pending || !ready}>
      {/* Measured: ~30s for the read, then Claude's copy pass runs 1–3 min
          depending on how long the source ad is. Say so rather than showing a
          spinner that looks stuck. */}
      {pending ? 'Working… 1–3 min' : 'Make concept'}
    </button>
  );
}

export function MakeDesk({
  items,
  brands,
}: {
  items: CardItem[];
  brands: BrandOption[];
}) {
  const grounded = brands.filter((b) => b.grounded);
  const [adId, setAdId] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string>(grounded[0]?.id ?? '');
  const [state, action] = useActionState<ConceptState, FormData>(makeConcept, { error: null });

  const [art, setArt] = useState<string | null>(null);
  const [artErr, setArtErr] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const shotFor = useRef<string | null>(null);

  // The image is generated after the copy is already on screen — it's the slow
  // half and the least useful one. Fire it once per concept.
  useEffect(() => {
    const id = state.rebuildId;
    if (!id || shotFor.current === id) return;
    shotFor.current = id;
    setArt(null);
    setArtErr(null);
    setShooting(true);
    shootImage(id)
      .then((res) => {
        if (res.error) setArtErr(res.error);
        else setArt(res.url ?? null);
      })
      .finally(() => setShooting(false));
  }, [state.rebuildId]);

  const picked = items.find((i) => i.atria_ad_id === adId) ?? null;

  return (
    <div className="make-split">
      {/* LEFT — pick the ad */}
      <div className="make-pick">
        {items.length === 0 ? (
          <p className="rail-note" style={{ border: 0, padding: 0 }}>
            Nothing matches. Paste an advertiser page URL on the left, or widen the run-length
            window.
          </p>
        ) : (
          <div className="grid make-grid">
            {items.map((ad) => {
              const on = ad.atria_ad_id === adId;
              return (
                <div key={ad.id} className={`clip-wrap${on ? ' is-selected' : ''}`}>
                  {ad.winner_score != null && (
                    <span className={`score${ad.winner_score >= 75 ? ' is-hot' : ''}`}>
                      {ad.winner_score}
                    </span>
                  )}
                  <button
                    type="button"
                    className="clip clip-pick"
                    aria-pressed={on}
                    onClick={() => setAdId(on ? null : ad.atria_ad_id)}
                  >
                    <span className={`pick-box${on ? ' is-on' : ''}`}>{on ? '✓' : ''}</span>
                    <div className="clip-art">
                      {ad.isVideo && <span className="clip-play">▶ video</span>}
                      {ad.artUrl ? (
                        ad.isVideo ? (
                          <video src={ad.artUrl} muted preload="metadata" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={ad.artUrl} alt="" loading="lazy" />
                        )
                      ) : (
                        <div className="no-art">{ad.kind ?? 'no preview'}</div>
                      )}
                    </div>
                    <div className="clip-meta">
                      <div className="clip-brand">
                        {ad.source === 'meta' ? (ad.brand_name ?? 'Meta ad') : 'Upload'}
                        {ad.status && (
                          <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
                            {ad.status === 'active' ? 'live' : 'ended'}
                          </span>
                        )}
                      </div>
                      {ad.title && <div className="clip-title">{ad.title}</div>}
                      {day(ad.start_date) && (
                        <div className="clip-run">
                          {day(ad.start_date)} →{' '}
                          {ad.status === 'active' ? 'still running' : (day(ad.end_date) ?? 'ended')}
                          {ad.run_days != null ? ` · ${ad.run_days}d` : ''}
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* RIGHT — make it, read it */}
      <aside className="make-out">
        <form action={action} className="make-bar">
          <input type="hidden" name="adId" value={adId ?? ''} />
          <input type="hidden" name="brandId" value={brandId} />
          <label className="make-field">
            <span className="eyebrow">Rebuild as</span>
            <select
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
              disabled={grounded.length === 0}
            >
              {grounded.length === 0 && <option value="">no grounded brand</option>}
              {grounded.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <GoButton ready={!!adId && !!brandId} />
        </form>

        {grounded.length === 0 && (
          <p className="gate-error">
            No brand has readable research yet. Upload brand, audience or mechanism docs on{' '}
            <Link href="/brand">Brand</Link> — nothing generates without grounding.
          </p>
        )}

        {picked && (
          <div className="notes-sec">
            <p className="eyebrow">Source — as it ran</p>
            {picked.title && (
              <p className="note-h" style={{ marginTop: 8, fontSize: 13 }}>
                {picked.title}
              </p>
            )}
            <p className="by">
              {picked.brand_name ?? 'Upload'}
              {picked.run_days != null ? ` · ran ${picked.run_days}d` : ''}
              {picked.winner_score != null ? ` · score ${picked.winner_score}` : ''}
            </p>
          </div>
        )}

        {state.error && <p className="gate-error">{state.error}</p>}
        {state.note && !state.error && <p className="rail-note">{state.note}</p>}

        {state.headline && (
          <div className="make-concept">
            <div className="notes-sec">
              <p className="eyebrow">Headline</p>
              <p className="ed-headline">{state.headline}</p>
              {state.alternates && state.alternates.length > 0 && (
                <ul className="make-alts">
                  {state.alternates.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
              {state.cta && (
                <p className="ed-cta-line">
                  <span className="eyebrow">CTA</span> {state.cta}
                </p>
              )}
            </div>

            <div className="notes-sec">
              <p className="eyebrow">Body copy</p>
              <p className="make-copy">{state.copy}</p>
            </div>

            {state.mirror && state.mirror.length > 0 && (
              <div className="notes-sec">
                <p className="eyebrow">What was replicated — theirs → ours</p>
                <ul className="make-mirror">
                  {state.mirror.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="notes-sec">
              <p className="eyebrow">Creative</p>
              {shooting && <p className="by">Shooting… the copy above is final either way.</p>}
              {artErr && <p className="rail-note">No art: {artErr}</p>}
              {art && (
                <figure className="proof" style={{ width: '100%', marginTop: 8 }}>
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
              )}
            </div>

            {state.adId && (
              <p className="by">
                Saved as a draft.{' '}
                <Link href={`/rebuild/${state.adId}`}>Open it to edit or send for review →</Link>
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
