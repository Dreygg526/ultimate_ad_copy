'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createBrand, uploadDoc, type ActionState } from './actions';
import { ACCEPT_ATTR } from '@/lib/doc-formats';

const EMPTY: ActionState = { error: null };

function Submit({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn" disabled={pending}>
      {pending ? busy : label}
    </button>
  );
}

function Result({ state }: { state: ActionState }) {
  if (state.error) return <p className="gate-error">{state.error}</p>;
  if (state.ok) return <p className="form-ok">{state.ok}</p>;
  return null;
}

export function AddBrandForm() {
  const [state, action] = useActionState<ActionState, FormData>(createBrand, EMPTY);
  return (
    <form action={action} className="stack">
      <div className="field">
        <p className="eyebrow">Add one of ours</p>
        <input
          name="name"
          className="input"
          placeholder="Brand name"
          required
          autoComplete="off"
        />
      </div>
      <Submit label="Add brand" busy="Adding…" />
      <Result state={state} />
    </form>
  );
}

export function UploadDocForm({ brandId }: { brandId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(uploadDoc, EMPTY);

  return (
    <form action={action} className="upload">
      <input type="hidden" name="brandId" value={brandId} />
      <div className="upload-row">
        <select name="kind" className="input" defaultValue="brand" aria-label="Doc kind">
          <option value="brand">Brand</option>
          <option value="audience">Audience</option>
          <option value="mechanism">Mechanism</option>
        </select>
        <input type="file" name="file" className="input" accept={ACCEPT_ATTR} required />
        {/* PDFs go through a vision model, so this is a wait, not a click. */}
        <Submit label="Upload & read" busy="Reading…" />
      </div>
      <Result state={state} />
    </form>
  );
}
