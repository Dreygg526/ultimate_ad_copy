'use client';

import { useActionState, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { transitionRebuild, type ActionState } from './actions';

type Status = 'draft' | 'waiting' | 'changes_asked' | 'approved';

function Btn({ label, busy, variant }: { label: string; busy: string; variant?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={`btn${variant ? ` ${variant}` : ''}`} disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

/**
 * The controls a buyer sees on a rebuild, shaped by where it is in review.
 * Only the legal next moves are offered — the server refuses the rest anyway,
 * but showing an illegal button just invites a confusing error.
 */
export function ReviewControls({ rebuildId, status }: { rebuildId: string; status: Status }) {
  const [state, action] = useActionState<ActionState, FormData>(transitionRebuild, { error: null });
  const [asking, setAsking] = useState(false);

  const err = state.error ? <p className="gate-error">{state.error}</p> : null;

  if (status === 'approved') {
    return (
      <p className="form-ok" style={{ margin: 0 }}>
        Approved — this one&rsquo;s cleared.
      </p>
    );
  }

  if (status === 'draft') {
    return (
      <form action={action} className="review-controls">
        <input type="hidden" name="rebuildId" value={rebuildId} />
        <input type="hidden" name="to" value="waiting" />
        <Btn label="Send to review" busy="Sending…" />
        {err}
      </form>
    );
  }

  if (status === 'changes_asked') {
    return (
      <form action={action} className="review-controls">
        <input type="hidden" name="rebuildId" value={rebuildId} />
        <input type="hidden" name="to" value="waiting" />
        <Btn label="Resubmit" busy="Sending…" />
        {err}
      </form>
    );
  }

  // waiting — the reviewer's decision.
  return (
    <div className="review-controls">
      {!asking ? (
        <div className="review-row">
          <form action={action}>
            <input type="hidden" name="rebuildId" value={rebuildId} />
            <input type="hidden" name="to" value="approved" />
            <Btn label="Approve" busy="Approving…" variant="is-go" />
          </form>
          <button type="button" className="btn is-quiet" onClick={() => setAsking(true)}>
            Ask for changes
          </button>
        </div>
      ) : (
        <form action={action} className="stack">
          <input type="hidden" name="rebuildId" value={rebuildId} />
          <input type="hidden" name="to" value="changes_asked" />
          <textarea
            name="note"
            className="input"
            rows={3}
            placeholder="What needs changing?"
            required
            autoFocus
          />
          <div className="review-row">
            <Btn label="Send back" busy="Sending…" variant="is-quiet" />
            <button type="button" className="btn is-quiet" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {err}
    </div>
  );
}
