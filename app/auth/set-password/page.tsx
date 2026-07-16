import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { PasswordForm } from '../PasswordForm';

/**
 * Where an invite or reset link lands after /auth/confirm has established the
 * session. New members set their first password here; returning members reset a
 * forgotten one. Outside the desk shell on purpose — no nav, just the one task.
 */
export default async function SetPasswordPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  return (
    <main className="gate">
      <div className="gate-card">
        <div className="wordmark" style={{ fontSize: 18, marginBottom: 4 }}>
          Teardown
        </div>
        <p className="eyebrow" style={{ marginBottom: 18 }}>
          Choose a password
        </p>

        {user ? (
          <>
            <p className="rail-note" style={{ borderLeft: 0, paddingLeft: 0, marginBottom: 16 }}>
              Setting the password for <b>{user.email}</b>.
            </p>
            <PasswordForm label="Set password" />
            <p className="rail-note" style={{ marginTop: 18, borderLeft: 0, paddingLeft: 0 }}>
              Once it&rsquo;s set, head to the <Link href="/library">Library</Link>.
            </p>
          </>
        ) : (
          <p className="gate-error">
            This link has expired or was already used. Ask the admin to resend your invite, or use
            &ldquo;Forgot password&rdquo; on the <Link href="/signin">sign-in screen</Link>.
          </p>
        )}
      </div>
    </main>
  );
}
