'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { updateMyPassword, type ActionState } from './actions';

const EMPTY: ActionState = { error: null };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? 'Saving…' : label}
    </button>
  );
}

/**
 * The new-password form, shared by the Settings "Your password" section and the
 * /auth/set-password page an invite or reset link lands on. Same server action
 * either way — it only ever touches the caller's own credential.
 */
export function PasswordForm({ label = 'Update password' }: { label?: string }) {
  const [state, action] = useActionState<ActionState, FormData>(updateMyPassword, EMPTY);

  return (
    <form action={action} className="stack" style={{ maxWidth: 320 }}>
      <label className="field" style={{ width: '100%', margin: 0 }}>
        <span className="eyebrow">New password</span>
        <input
          name="password"
          type="password"
          className="input"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </label>
      <label className="field" style={{ width: '100%', margin: 0 }}>
        <span className="eyebrow">Confirm</span>
        <input
          name="confirm"
          type="password"
          className="input"
          required
          minLength={8}
          autoComplete="new-password"
        />
      </label>
      <Submit label={label} />
      {state.error && <p className="gate-error" style={{ margin: 0 }}>{state.error}</p>}
      {state.ok && <p className="form-ok" style={{ margin: 0 }}>{state.ok}</p>}
    </form>
  );
}
