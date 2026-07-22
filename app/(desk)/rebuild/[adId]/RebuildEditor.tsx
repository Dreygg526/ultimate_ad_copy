'use client';

import { useState, useTransition } from 'react';
import { saveRebuild } from './actions';
import { transitionRebuild } from '@/app/(desk)/review/actions';

type Status = 'draft' | 'changes_asked';

/**
 * The editorial editing surface from the approved mockup: headline, alternate
 * headlines a buyer can promote, body copy, Claude's rationale, and the CTA —
 * all editable in place. This is where "ask for changes" lands, so a buyer can
 * act on a note without regenerating the whole ad.
 *
 * Save runs before any send, in one transition, so edits are never lost to a
 * "send to review" click. Only draft and changes_asked reach here; a waiting or
 * approved rebuild is locked upstream.
 */
export function RebuildEditor({
  adId,
  rebuildId,
  status,
  initial,
}: {
  adId: string;
  rebuildId: string;
  status: Status;
  initial: { headline: string; copy: string; cta: string; notes: string | null };
}) {
  const [headline, setHeadline] = useState(initial.headline);
  const [copy, setCopy] = useState(initial.copy);
  const [cta, setCta] = useState(initial.cta);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const run = (then?: 'review') =>
    start(async () => {
      setErr(null);
      setSaved(false);
      const fd = new FormData();
      fd.set('adId', adId);
      fd.set('rebuildId', rebuildId);
      fd.set('headline', headline);
      fd.set('copy', copy);
      fd.set('cta', cta);
      const r = await saveRebuild({ error: null }, fd);
      if (r.error) return setErr(r.error);

      if (then === 'review') {
        const fd2 = new FormData();
        fd2.set('rebuildId', rebuildId);
        fd2.set('to', 'waiting');
        const r2 = await transitionRebuild({ error: null }, fd2);
        if (r2.error) return setErr(r2.error);
      }
      setSaved(true);
    });

  const sendLabel = status === 'changes_asked' ? 'Resubmit' : 'Send to review';

  return (
    <div className="editor">
      <div className="editor-bar">
        <button type="button" className="btn is-quiet" onClick={() => run()} disabled={pending}>
          {pending ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" className="btn is-go" onClick={() => run('review')} disabled={pending}>
          {pending ? 'Working…' : sendLabel}
        </button>
        {err && <span className="gate-error" style={{ margin: 0 }}>{err}</span>}
        {saved && !err && <span className="form-ok" style={{ margin: 0 }}>Saved.</span>}
      </div>

      <div className="field-block">
        <p className="eyebrow">
          Headline <span className="field-count">{headline.length}</span>
        </p>
        <textarea
          className="editable editable-h"
          rows={2}
          value={headline}
          onChange={(e) => setHeadline(e.target.value)}
        />
      </div>

      <div className="field-block">
        <p className="eyebrow">Body copy</p>
        <textarea
          className="editable editable-body"
          rows={14}
          value={copy}
          onChange={(e) => setCopy(e.target.value)}
        />
      </div>

      {initial.notes && (
        <div className="field-block">
          <p className="eyebrow">Notes from Claude</p>
          <p className="note-b" style={{ marginTop: 6 }}>
            {initial.notes}
          </p>
        </div>
      )}

      <div className="field-block">
        <p className="eyebrow">Call to action</p>
        <input
          className="editable editable-cta"
          value={cta}
          onChange={(e) => setCta(e.target.value)}
          placeholder="e.g. Take the 60-second quiz"
        />
      </div>
    </div>
  );
}
