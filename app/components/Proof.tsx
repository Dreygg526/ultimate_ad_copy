'use client';

import { useState, type ReactNode } from 'react';

/**
 * The signature element: numbered grease-pencil marks laid directly on the
 * creative, wired both ways to the annotation list. Hover a note and its mark
 * lights up on the image; hover a mark and its note lights up.
 *
 * Everything around this is deliberately quiet. The pencil red lives here and
 * nowhere else in the chrome.
 */

export interface Mark {
  /** 0–100, percentage of the creative's width. */
  x: number;
  /** 0–100, percentage of its height. */
  y: number;
  heading: string;
  body: string;
}

export function Proof({
  art,
  marks,
  caption,
  panel,
  summary,
  by,
}: {
  art: string | null;
  marks: Mark[];
  caption: ReactNode;
  /** The score block — server-rendered, static. */
  panel: ReactNode;
  summary: string | null;
  /**
   * Data, not JSX, and deliberately so — same as `summary`. A server-built
   * element landing in this list slot loses React's key bookkeeping crossing
   * the RSC boundary and trips a spurious "unique key prop" warning.
   */
  by: string | null;
}) {
  const [lit, setLit] = useState<number | null>(null);

  return (
    <div className="spread">
      <div className="proof-stage">
        <figure className="proof">
          <div className="proof-art">
            {art ? (
              // Real creative from Atria's CDN. next/image would proxy and
              // re-encode it; a clipped ad should be shown exactly as it ran.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={art} alt="" />
            ) : (
              <div className="no-art">no image on this ad</div>
            )}

            {marks.map((m, i) => (
              <button
                key={i}
                type="button"
                className={`mark${lit === i ? ' is-lit' : ''}`}
                style={{ left: `${m.x}%`, top: `${m.y}%`, transform: 'translate(-50%, -50%)' }}
                onMouseEnter={() => setLit(i)}
                onMouseLeave={() => setLit(null)}
                onFocus={() => setLit(i)}
                onBlur={() => setLit(null)}
                aria-label={`Note ${i + 1}: ${m.heading}`}
              >
                {i + 1}
              </button>
            ))}
          </div>
          <figcaption className="proof-cap">{caption}</figcaption>
        </figure>
      </div>

      <aside className="notes">
        {panel}

        {summary && (
          <div className="notes-sec">
            <p className="eyebrow">What it&rsquo;s doing</p>
            <p className="note-b" style={{ marginTop: 8 }}>
              {summary}
            </p>
          </div>
        )}

        {marks.length > 0 && (
          <div className="notes-sec">
            <p className="eyebrow">Deconstruction</p>
            {marks.map((m, i) => (
              <button
                key={i}
                type="button"
                className={`note${lit === i ? ' is-lit' : ''}`}
                onMouseEnter={() => setLit(i)}
                onMouseLeave={() => setLit(null)}
                onFocus={() => setLit(i)}
                onBlur={() => setLit(null)}
              >
                <span className="note-n">{i + 1}</span>
                <span>
                  <span className="note-h" style={{ display: 'block' }}>
                    {m.heading}
                  </span>
                  <span className="note-b" style={{ display: 'block' }}>
                    {m.body}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {by && <p className="by">{by}</p>}
      </aside>
    </div>
  );
}
