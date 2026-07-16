'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { inviteMember, resendInvite, removeMember, type ActionState } from './actions';

const EMPTY: ActionState = { error: null };

function Submit({ label, busy, variant }: { label: string; busy: string; variant?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn${variant ? ` ${variant}` : ''}`} disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

export function InviteForm() {
  const [state, action] = useActionState<ActionState, FormData>(inviteMember, EMPTY);

  return (
    <form action={action} className="stack" style={{ maxWidth: 460 }}>
      <div className="invite-row">
        <input
          name="email"
          type="email"
          className="input"
          placeholder="name@thestandardlab.com"
          required
          autoComplete="off"
        />
        <Submit label="Send invite" busy="Sending…" />
      </div>
      {state.error && <p className="gate-error" style={{ margin: 0 }}>{state.error}</p>}
      {state.ok && <p className="form-ok" style={{ margin: 0 }}>{state.ok}</p>}
    </form>
  );
}

/**
 * The admin's per-member controls: resend a link to someone pending or locked
 * out, or remove them. Kept minimal — role changes are out of scope here.
 */
export function MemberActions({
  id,
  email,
  pending,
}: {
  id: string;
  email: string;
  pending: boolean;
}) {
  const [resendState, resend] = useActionState<ActionState, FormData>(resendInvite, EMPTY);
  const [removeState, remove] = useActionState<ActionState, FormData>(removeMember, EMPTY);
  const msg = removeState.error ?? resendState.error ?? removeState.ok ?? resendState.ok ?? null;
  const isErr = !!(removeState.error ?? resendState.error);

  return (
    <div className="member-actions">
      <div className="member-btns">
        <form action={resend}>
          <input type="hidden" name="email" value={email} />
          <Submit label={pending ? 'Resend' : 'Send reset'} busy="…" variant="is-quiet" />
        </form>
        <form action={remove}>
          <input type="hidden" name="id" value={id} />
          <Submit label="Remove" busy="…" variant="is-quiet" />
        </form>
      </div>
      {msg && (
        <p className={isErr ? 'gate-error' : 'form-ok'} style={{ margin: 0 }}>
          {msg}
        </p>
      )}
    </div>
  );
}
