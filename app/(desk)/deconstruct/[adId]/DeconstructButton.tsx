'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { runDeconstruction, type ActionState } from './actions';

// Two model calls back to back — this is a ~30s wait, so the button has to say
// so rather than just going quiet.
function Submit({ again }: { again: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn${again ? ' is-quiet' : ''}`} disabled={pending}>
      {pending ? 'Reading the creative…' : again ? 'Run again' : 'Deconstruct this ad'}
    </button>
  );
}

export function DeconstructButton({ adId, again = false }: { adId: string; again?: boolean }) {
  const [state, formAction] = useActionState<ActionState, FormData>(runDeconstruction, {
    error: null,
  });

  return (
    <form action={formAction}>
      <input type="hidden" name="adId" value={adId} />
      <Submit again={again} />
      {state.error && (
        <p className="gate-error" style={{ marginTop: 8 }}>
          {state.error}
        </p>
      )}
    </form>
  );
}
