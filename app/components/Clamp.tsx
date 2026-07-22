'use client';

import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Ad copy runs long. These are direct-response stories — a liver ad on the desk
 * right now is ~2,000 words — and printed whole they push the marks and the
 * copy off the panel, which is the part of this screen worth reading.
 *
 * The toggle is measured, not guessed from a character count: a body only gets
 * one if it actually overflows at the current width, so the button never appears
 * over copy that already fits.
 */
export function Clamp({ text, lines = 10 }: { text: string; lines?: number }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Only measurable while clamped — an expanded element never overflows, so
    // checking one would always answer "no" and drop the button mid-read.
    const measure = () => {
      if (!open) setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, text]);

  return (
    <>
      <p
        ref={ref}
        className={`note-b clamp${open ? ' is-open' : ''}`}
        style={open ? undefined : { WebkitLineClamp: lines }}
      >
        {text}
      </p>
      {(overflows || open) && (
        <button type="button" className="clamp-more" onClick={() => setOpen(!open)}>
          {open ? 'See less' : 'See more'}
        </button>
      )}
    </>
  );
}
