'use client';

import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DeleteButton } from './DeleteButton';
import { deleteItems } from './actions';
import { makeConcept, shootImage, type ConceptState } from './concept-actions';

// The Library IS the workflow. Click an ad and the build panel opens beside it:
// pick a brand, one button, the concept renders in place. /rebuild/[adId] is
// still a route, for editing a saved draft — reached from the concept just made,
// not walked through in order.
//
// Select mode (batch delete) still lives here too; picking a card for a concept
// and picking cards to delete are different modes, so they don't collide.

export interface CardItem {
  id: string;
  atria_ad_id: string;
  platform_native_id: string | null;
  source: 'upload' | 'meta';
  kind: 'image' | 'video' | null;
  brand_name: string | null;
  title: string | null;
  status: 'active' | 'inactive' | null;
  winner_score: number | null;
  run_days: number | null;
  start_date: string | null;
  end_date: string | null;
  artUrl: string | null;
  isVideo: boolean;
}

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
      {pending ? 'Writing…' : 'Build this ad'}
    </button>
  );
}

export function LibraryDesk({
  items,
  brands,
}: {
  items: CardItem[];
  brands: BrandOption[];
}) {
  const router = useRouter();

  // --- batch delete mode (unchanged behaviour) ---
  const [mode, setMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // --- build panel ---
  const grounded = brands.filter((b) => b.grounded);
  const [adId, setAdId] = useState<string | null>(null);
  const [brandId, setBrandId] = useState<string>(grounded[0]?.id ?? '');
  const [state, action] = useActionState<ConceptState, FormData>(makeConcept, { error: null });

  const [art, setArt] = useState<string | null>(null);
  const [artErr, setArtErr] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const shotFor = useRef<string | null>(null);

  // The image is generated only after the copy is on screen — it's the slow half
  // and a buyer judges the concept on the words.
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

  function toggleSel(id: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSel() {
    setMode(false);
    setArmed(false);
    setDelErr(null);
    setSel(new Set());
  }

  function runDelete() {
    setDelErr(null);
    start(async () => {
      const res = await deleteItems([...sel]);
      if (res.error) {
        setDelErr(res.error);
        setArmed(false);
        return;
      }
      exitSel();
      router.refresh();
    });
  }

  const allShown = items.length > 0 && sel.size === items.length;
  const picked = items.find((i) => i.atria_ad_id === adId) ?? null;

  return (
    <>
      <div className="grid-toolbar">
        {!mode ? (
          <>
            <button type="button" className="chip" onClick={() => setMode(true)}>
              Select
            </button>
            <span className="grid-tool-count">
              {picked ? 'Pick a brand, then build →' : 'Click an ad to build it'}
            </span>
          </>
        ) : (
          <>
            <span className="grid-tool-count num">{sel.size} selected</span>
            <button
              type="button"
              className="chip"
              onClick={() =>
                setSel(allShown ? new Set() : new Set(items.map((i) => i.atria_ad_id)))
              }
            >
              {allShown ? 'Clear' : 'Select all shown'}
            </button>
            {armed ? (
              <span className="del-confirm" role="group">
                <button type="button" className="del-yes" onClick={runDelete} disabled={pending}>
                  {pending ? '…' : `Delete ${sel.size}`}
                </button>
                <button
                  type="button"
                  className="del-no"
                  onClick={() => setArmed(false)}
                  disabled={pending}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="chip is-danger"
                disabled={sel.size === 0}
                onClick={() => setArmed(true)}
              >
                Delete{sel.size ? ` ${sel.size}` : ''}
              </button>
            )}
            <button type="button" className="chip" onClick={exitSel} disabled={pending}>
              Cancel
            </button>
            {delErr && <span className="gate-error">{delErr}</span>}
          </>
        )}
      </div>

      <div className="make-split">
        <div className="make-pick">
          {items.length === 0 ? (
            <p className="rail-note" style={{ border: 0, padding: 0 }}>
              Nothing here. Upload a file or paste an advertiser page URL on the left — or widen
              the run-length window.
            </p>
          ) : (
            <div className="grid make-grid">
              {items.map((ad) => {
                const selected = mode ? sel.has(ad.atria_ad_id) : ad.atria_ad_id === adId;

                const inner = (
                  <>
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
                        {ad.source === 'meta' && ad.status && (
                          <span className={`tag ${ad.status === 'active' ? 'is-live' : 'is-dead'}`}>
                            {ad.status === 'active' ? 'live' : 'ended'}
                          </span>
                        )}
                        <span className="clip-kind">{ad.kind}</span>
                      </div>
                      {ad.title && <div className="clip-title">{ad.title}</div>}
                      {ad.source === 'meta' && day(ad.start_date) && (
                        <div className="clip-run">
                          {day(ad.start_date)} →{' '}
                          {ad.status === 'active' ? 'still running' : (day(ad.end_date) ?? 'ended')}
                          {ad.run_days != null ? ` · ${ad.run_days}d` : ''}
                        </div>
                      )}
                    </div>
                  </>
                );

                return (
                  <div key={ad.id} className={`clip-wrap${selected ? ' is-selected' : ''}`}>
                    {ad.source === 'meta' && ad.winner_score != null && (
                      <span className={`score${ad.winner_score >= 75 ? ' is-hot' : ''}`}>
                        {ad.winner_score}
                      </span>
                    )}

                    {!mode && (
                      <>
                        <DeleteButton
                          adId={ad.atria_ad_id}
                          label={ad.title ?? ad.brand_name ?? 'this item'}
                        />
                        {ad.source === 'meta' && ad.platform_native_id && (
                          <a
                            className="meta-link"
                            href={`https://www.facebook.com/ads/library/?id=${ad.platform_native_id}`}
                            target="_blank"
                            rel="noreferrer noopener"
                            title="Open this ad on Meta Ad Library (a dead page means it went inactive)"
                          >
                            Meta ↗
                          </a>
                        )}
                      </>
                    )}

                    <button
                      type="button"
                      className="clip clip-pick"
                      aria-pressed={selected}
                      onClick={() =>
                        mode
                          ? toggleSel(ad.atria_ad_id)
                          : setAdId(selected ? null : ad.atria_ad_id)
                      }
                    >
                      <span className={`pick-box${selected ? ' is-on' : ''}`}>
                        {selected ? '✓' : ''}
                      </span>
                      {inner}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

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

          {!picked && grounded.length > 0 && !state.headline && (
            <p className="rail-note" style={{ marginTop: 12 }}>
              Click any ad in the grid. Its copy gets replicated beat for beat with our mechanism
              swapped in.
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

          {state.headline && (
            <div className="make-concept">
              <div className="notes-sec">
                <p className="eyebrow">Headline</p>
                <p className="ed-headline">{state.headline}</p>
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
    </>
  );
}
