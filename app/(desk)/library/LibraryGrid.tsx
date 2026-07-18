'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DeleteButton } from './DeleteButton';
import { deleteItems } from './actions';

// The Library grid, client-side so it can host a batch "select mode": toggle
// Select, click cards to pick them, delete the lot in one action (rows cascade
// + stored images removed, server-side). Out of select mode a card is just a
// link into Deconstruct, exactly as before.

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

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);

export function LibraryGrid({ items }: { items: CardItem[] }) {
  const router = useRouter();
  const [mode, setMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function toggle(id: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exit() {
    setMode(false);
    setArmed(false);
    setErr(null);
    setSel(new Set());
  }

  function run() {
    setErr(null);
    start(async () => {
      const res = await deleteItems([...sel]);
      if (res.error) {
        setErr(res.error);
        setArmed(false);
        return;
      }
      exit();
      router.refresh();
    });
  }

  const allShown = items.length > 0 && sel.size === items.length;

  return (
    <>
      <div className="grid-toolbar">
        {!mode ? (
          <button type="button" className="chip" onClick={() => setMode(true)}>
            Select
          </button>
        ) : (
          <>
            <span className="grid-tool-count num">{sel.size} selected</span>
            <button
              type="button"
              className="chip"
              onClick={() => setSel(allShown ? new Set() : new Set(items.map((i) => i.atria_ad_id)))}
            >
              {allShown ? 'Clear' : 'Select all shown'}
            </button>
            {armed ? (
              <span className="del-confirm" role="group">
                <button type="button" className="del-yes" onClick={run} disabled={pending}>
                  {pending ? '…' : `Delete ${sel.size}`}
                </button>
                <button type="button" className="del-no" onClick={() => setArmed(false)} disabled={pending}>
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
            <button type="button" className="chip" onClick={exit} disabled={pending}>
              Cancel
            </button>
            {err && <span className="gate-error">{err}</span>}
          </>
        )}
      </div>

      <div className="grid">
        {items.map((ad) => {
          const started = day(ad.start_date);
          const selected = sel.has(ad.atria_ad_id);

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
                {ad.source === 'meta' && started && (
                  <div className="clip-run">
                    {started} → {ad.status === 'active' ? 'still running' : (day(ad.end_date) ?? 'ended')}
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

              {mode ? (
                <button
                  type="button"
                  className="clip clip-pick"
                  aria-pressed={selected}
                  onClick={() => toggle(ad.atria_ad_id)}
                >
                  <span className={`pick-box${selected ? ' is-on' : ''}`}>{selected ? '✓' : ''}</span>
                  {inner}
                </button>
              ) : (
                <>
                  <DeleteButton adId={ad.atria_ad_id} label={ad.title ?? ad.brand_name ?? 'this item'} />
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
                  <Link href={`/deconstruct/${ad.atria_ad_id}`} className="clip">
                    {inner}
                  </Link>
                </>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
