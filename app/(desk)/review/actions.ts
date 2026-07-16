'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

export type ActionState = { error: string | null };

type Status = 'draft' | 'waiting' | 'changes_asked' | 'approved';

/**
 * Step 3c: move a rebuild through review, writing the trail as review_events.
 *
 * The legal moves are fixed here rather than left to the UI, because the history
 * in review_events is only trustworthy if every transition went through this
 * gate. RLS still decides whether the actor may touch the row at all — this is
 * the workflow rule on top of that, not instead of it.
 *
 *   draft          → waiting                     (send to review)
 *   waiting        → approved | changes_asked     (the reviewer's call)
 *   changes_asked  → waiting                      (resubmit after edits)
 *
 * approved is terminal. A rejected direction just isn't offered and is refused
 * here too, so a stale button or a hand-crafted request can't skip a step.
 */
const ALLOWED: Record<Status, Status[]> = {
  draft: ['waiting'],
  waiting: ['approved', 'changes_asked'],
  changes_asked: ['waiting'],
  approved: [],
};

export async function transitionRebuild(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const rebuildId = String(formData.get('rebuildId') ?? '');
  const to = String(formData.get('to') ?? '') as Status;
  const note = String(formData.get('note') ?? '').trim() || null;

  if (!rebuildId) return { error: 'No rebuild given.' };
  if (!(to in ALLOWED)) return { error: 'Not a real status.' };

  // "Changes asked" with no note is useless to whoever has to act on it.
  if (to === 'changes_asked' && !note) {
    return { error: 'Say what needs changing — a bare rejection helps no one.' };
  }

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: 'Sign in first.' };

  const { data: rebuild } = await db
    .from('rebuilds')
    .select('id, status')
    .eq('id', rebuildId)
    .maybeSingle();
  if (!rebuild) return { error: 'That rebuild is gone.' };

  const from = rebuild.status as Status;
  if (!ALLOWED[from]?.includes(to)) {
    return { error: `Can't move a ${from.replace('_', ' ')} rebuild to ${to.replace('_', ' ')}.` };
  }

  const { error: upErr } = await db
    .from('rebuilds')
    .update({ status: to, updated_at: new Date().toISOString() })
    .eq('id', rebuildId)
    // Guard against a concurrent transition: only move if it's still where we
    // read it. If someone else already advanced it, this updates nothing.
    .eq('status', from);
  if (upErr) return { error: `Could not update: ${upErr.message}` };

  const { error: evErr } = await db.from('review_events').insert({
    rebuild_id: rebuildId,
    from_status: from,
    to_status: to,
    note,
    actor: user.id,
  });
  // The status already moved; a failed event write is a broken audit trail, not
  // a broken rebuild — surface it, but don't pretend the move didn't happen.
  if (evErr) return { error: `Moved, but the review note didn't save: ${evErr.message}` };

  revalidatePath('/review');
  return { error: null };
}
