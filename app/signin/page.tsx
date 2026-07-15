import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Invite-only: there is no sign-up link, and self-signup is disabled on the
 * Supabase project. Accounts are created by the admin.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  async function signIn(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');
    const target = String(formData.get('next') ?? '/library');

    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      // Deliberately vague: distinguishing "no such user" from "wrong password"
      // tells an outsider which addresses have accounts.
      redirect(`/signin?error=1${target ? `&next=${encodeURIComponent(target)}` : ''}`);
    }
    redirect(target.startsWith('/') ? target : '/library');
  }

  return (
    <main className="gate">
      <form className="gate-card" action={signIn}>
        <div className="wordmark" style={{ fontSize: 18, marginBottom: 4 }}>
          Teardown
        </div>
        <p className="eyebrow" style={{ marginBottom: 18 }}>
          The Standard Lab · invite only
        </p>

        <label className="field">
          <span className="eyebrow">Email</span>
          <input name="email" type="email" required autoComplete="email" autoFocus />
        </label>

        <label className="field">
          <span className="eyebrow">Password</span>
          <input name="password" type="password" required autoComplete="current-password" />
        </label>

        <input type="hidden" name="next" value={next ?? '/library'} />

        {error && <p className="gate-error">That didn&rsquo;t work. Check the address and password.</p>}

        <button className="btn" type="submit" style={{ width: '100%', marginTop: 6 }}>
          Sign in
        </button>

        <p className="rail-note" style={{ marginTop: 18, borderLeft: 0, paddingLeft: 0 }}>
          No public sign-up. Ask the admin for an invite.
        </p>
      </form>
    </main>
  );
}
