'use client';

import { useState } from 'react';

// The Meta Ad Library can't reliably deep-link a specific low-impression clone
// ("Ad isn't in the Ad Library"), so we don't send the buyer to a dead page —
// we make the Library ID one click to copy, to paste into Meta's own search.
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions) — leave the ID
      // visible so it can still be selected by hand.
    }
  }

  return (
    <button
      type="button"
      className="copyid"
      onClick={copy}
      title="Copy the Meta Ad Library ID"
      aria-label={`Copy Library ID ${id}`}
    >
      Library ID {id} {copied ? '✓ copied' : '⧉'}
    </button>
  );
}
