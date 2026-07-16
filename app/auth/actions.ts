'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';

export type ActionState = { error: string | null; ok?: string };

/**
 * Where the emailed links come back to. Supabase requires this origin to be in
 * the project's Auth → URL Configuration → Redirect URLs allow-list, so it must
 * be the real deployed origin, not a guess. Prefer an explicit env var; fall
 * back to the request's own origin for local dev.
 */
export async function siteOrigin(): Promise<string> {
  const env = process.env.NEXT_PUBLIC_SITE_URL;
  if (env) return env.replace(/\/$/, '');
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return host ? `${proto}://${host}` : 'http://localhost:3000';
}

/**
 * Set the signed-in user's own password.
 *
 * Used from two places with the same shape of session: the Settings screen (a
 * normal desk session) and the /auth/set-password page reached from an invite or
 * reset link (a recovery session). In both cases the request client is already
 * acting as that user, so updateUser changes only their own credential — there
 * is no way to aim this at someone else.
 */
export async function updateMyPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const password = String(formData.get('password') ?? '');
  const confirm = String(formData.get('confirm') ?? '');

  if (password.length < 8) return { error: 'Use at least 8 characters.' };
  if (password !== confirm) return { error: 'Those two passwords don’t match.' };

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) {
    return { error: 'Your session has expired — open the link from your email again.' };
  }

  const { error } = await db.auth.updateUser({ password });
  if (error) return { error: `Could not update: ${error.message}` };

  return { error: null, ok: 'Password updated.' };
}

/**
 * Sign out and return to the gate. Clears the session cookies via the
 * request-scoped client, so the very next request has no user and the
 * middleware keeps them out until they sign back in.
 */
export async function signOut(): Promise<void> {
  const db = await createClient();
  await db.auth.signOut();
  redirect('/signin');
}

/**
 * Forgot-password from the sign-in screen. Always reports the same thing whether
 * or not the address has an account — telling an outsider which emails are
 * registered is the same leak the vague sign-in error avoids.
 */
export async function requestReset(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '').trim();
  if (email) {
    const db = await createClient();
    await db.auth.resetPasswordForEmail(email, {
      redirectTo: `${await siteOrigin()}/auth/confirm?next=/auth/set-password`,
    });
  }
  redirect('/signin?sent=1');
}
