'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { refreshMetaStatuses } from './actions';

// Re-check Meta items against Atria and update their live/ended flag + dates.
// Soft signal: Atria lags Meta, so this is "what Atria last knew", not Meta's
// live truth (there is no Meta API). A winner that ended stays in the library.
export function RefreshStatuses() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function run() {
    setMsg(null);
    start(async () => {
      const res = await refreshMetaStatuses();
      if (res.error) return setMsg(res.error);
      setMsg(`Re-checked ${res.checked ?? 0} · ${res.updated ?? 0} changed`);
      router.refresh();
    });
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className="btn is-quiet" onClick={run} disabled={pending}>
        {pending ? 'Re-checking…' : 'Re-check statuses'}
      </button>
      {msg && (
        <p className="add-hint" style={{ marginTop: 6 }}>
          {msg}
        </p>
      )}
    </div>
  );
}
