'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { runRebuild, type ActionState } from './actions';

// Claude writes, then Gemini shoots — two model calls back to back, ~45s in
// practice. The button has to say so rather than going quiet.
function Submit({ again, disabled }: { again: boolean; disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn${again ? ' is-quiet' : ''}`} disabled={pending || disabled}>
      {pending ? 'Writing and shooting…' : again ? 'Rebuild again' : 'Rebuild this ad'}
    </button>
  );
}

export function RebuildButton({
  adId,
  brands,
  again = false,
}: {
  adId: string;
  brands: { id: string; name: string; grounded: boolean }[];
  again?: boolean;
}) {
  const [state, formAction] = useActionState<ActionState, FormData>(runRebuild, { error: null });
  const ready = brands.filter((b) => b.grounded);

  if (ready.length === 0) {
    return (
      <p className="rail-note" style={{ maxWidth: '34ch', textAlign: 'right' }}>
        No grounded brand to rebuild against.
      </p>
    );
  }

  return (
    <form action={formAction} className="upload-row">
      <input type="hidden" name="adId" value={adId} />
      <select name="brandId" className="input" defaultValue={ready[0].id} aria-label="Rebuild for">
        {ready.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <Submit again={again} disabled={false} />
      {state.error && <p className="gate-error">{state.error}</p>}
    </form>
  );
}
