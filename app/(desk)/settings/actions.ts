'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { siteOrigin } from '@/app/auth/actions';

export type ActionState = { error: string | null; ok?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Confirm the caller is the admin before any user-management call.
 *
 * These actions reach for the service-role client, which bypasses RLS, so the
 * admin check cannot be left to the database the way the rest of the app leaves
 * it to RLS — it has to happen here, against the caller's real session, or a
 * plain member could invite and remove people. Only ai_support@… is admin
 * (CLAUDE.md § Auth).
 */
async function callingAdmin(): Promise<{ id: string; error: string | null }> {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { id: '', error: 'Sign in first.' };

  const { data: me } = await db.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (me?.role !== 'admin') return { id: user.id, error: 'Only the admin can manage members.' };
  return { id: user.id, error: null };
}

/**
 * Invite by email. Creates the auth user and emails an invite link, then writes
 * the membership row (RLS keys off profiles, so without it the invitee could
 * sign in yet read nothing). The link returns through /auth/confirm to the
 * set-password page.
 *
 * Requires SMTP configured on the Supabase project — the built-in email sender
 * is rate-limited and meant only for testing.
 */
export async function inviteMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'That doesn’t look like an email address.' };

  const admin_ = await callingAdmin();
  if (admin_.error) return { error: admin_.error };

  const admin = createAdminClient();
  const redirectTo = `${await siteOrigin()}/auth/confirm?next=/auth/set-password`;

  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (error) {
    const already = /already|registered|exists/i.test(error.message);
    return {
      error: already
        ? `${email} already has an account. Use “Resend link” instead.`
        : `Could not invite ${email}: ${error.message}`,
    };
  }

  const { error: pErr } = await admin
    .from('profiles')
    .upsert({ id: data.user.id, email, role: 'member' }, { onConflict: 'id' });
  if (pErr) return { error: `Invite email sent, but the membership row failed: ${pErr.message}` };

  // Audit record of who invited whom. Best-effort — never block the invite on it.
  await admin
    .from('invites')
    .upsert({ email, invited_by: admin_.id, accepted_at: null }, { onConflict: 'email' });

  revalidatePath('/settings');
  return { error: null, ok: `Invite sent to ${email}.` };
}

/**
 * Resend an access link to someone already on the list — a pending invite that
 * never got opened, or a member who's locked out. A recovery email works for
 * both: it lands on the same set-password page, and a never-confirmed account
 * gets confirmed by using it.
 */
export async function resendInvite(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'No valid email to resend to.' };

  const admin_ = await callingAdmin();
  if (admin_.error) return { error: admin_.error };

  const db = await createClient();
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: `${await siteOrigin()}/auth/confirm?next=/auth/set-password`,
  });
  if (error) return { error: `Could not resend: ${error.message}` };

  revalidatePath('/settings');
  return { error: null, ok: `Link resent to ${email}.` };
}

/**
 * Remove a member: delete the auth user, which cascades the profile away via its
 * FK. Guarded so the admin can't lock themselves out or delete another admin.
 */
export async function removeMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = String(formData.get('id') ?? '');
  if (!id) return { error: 'No member given.' };

  const admin_ = await callingAdmin();
  if (admin_.error) return { error: admin_.error };
  if (id === admin_.id) return { error: 'You can’t remove yourself.' };

  const admin = createAdminClient();
  const { data: target } = await admin
    .from('profiles')
    .select('role, email')
    .eq('id', id)
    .maybeSingle();
  if (!target) return { error: 'That member is already gone.' };
  if (target.role === 'admin') return { error: 'Can’t remove an admin from here.' };

  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return { error: `Could not remove: ${error.message}` };

  // Clear the audit row so the same address can be re-invited cleanly.
  await admin.from('invites').delete().eq('email', target.email);

  revalidatePath('/settings');
  return { error: null, ok: `Removed ${target.email}.` };
}
