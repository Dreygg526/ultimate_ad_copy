'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { deleteByBrand } from './actions';

// "Delete all" for one advertiser in the From-Meta sub-list (e.g. every Steven
// West item). Inline confirm — it can remove a lot of rows at once. Deletes the
// whole brand server-side (rows cascade + stored images removed), not just the
// items currently shown.
export function BrandDeleteButton({
  brandId,
  label,
  count,
}: {
  brandId: string;
  label: string;
  count: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function run() {
    start(async () => {
      const res = await deleteByBrand(brandId);
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
      <span className="brand-del-confirm" role="group" aria-label={`Delete all ${label}?`}>
        <button type="button" className="del-yes" onClick={run} disabled={pending}>
          {pending ? '…' : `Delete ${count}`}
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
      className="brand-del"
      title={err ?? `Delete all ${count} ${label} items`}
      aria-label={`Delete all ${label} items`}
      onClick={() => {
        setErr(null);
        setArmed(true);
      }}
    >
      ✕
    </button>
  );
}
