'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteItem } from './actions';

// A small ✕ on each card. Deletion cascades any
// rebuilds, so it asks once before doing it. Lives OUTSIDE the card's <Link> so
// it isn't a button nested in an anchor.
export function DeleteButton({ adId, label }: { adId: string; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function run() {
    start(async () => {
      const res = await deleteItem(adId);
      if (res.error) {
        setErr(res.error);
        setArmed(false);
        return;
      }
      router.refresh();
    });
  }

  if (armed) {
    return (
      <span className="del-confirm" role="group" aria-label={`Delete ${label}?`}>
        <button type="button" className="del-yes" onClick={run} disabled={pending}>
          {pending ? '…' : 'Delete'}
        </button>
        <button type="button" className="del-no" onClick={() => setArmed(false)} disabled={pending}>
          Keep
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className="del-btn"
      title={err ?? `Remove “${label}” from the library`}
      aria-label={`Remove ${label}`}
      onClick={() => {
        setErr(null);
        setArmed(true);
      }}
    >
      ✕
    </button>
  );
}
