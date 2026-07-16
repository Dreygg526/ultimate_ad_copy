import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { PasswordForm } from '@/app/auth/PasswordForm';
import { InviteForm, MemberActions } from './SettingsForms';

// Settings: who's on the team and your own password.
//
// Everyone reaches this screen — a member to change their password and see the
// team, the admin to invite and remove. The invite/remove controls only render
// for the admin, and the server actions re-check that anyway, since the UI is
// never the access boundary.

interface Member {
  id: string;
  email: string;
  full_name: string | null;
  role: 'admin' | 'member';
  pending: boolean;
}

export default async function SettingsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  const { data: me } = user
    ? await db.from('profiles').select('role').eq('id', user.id).maybeSingle()
    : { data: null };
  const isAdmin = me?.role === 'admin';

  // Any member may read the team (profiles_read RLS). Ordered admin-first.
  const { data: profileRows } = await db
    .from('profiles')
    .select('id, email, full_name, role')
    .order('role', { ascending: true })
    .order('email', { ascending: true });
  const profiles = profileRows ?? [];

  // Pending vs active needs auth metadata (last_sign_in_at), which only the
  // service-role client can read — so the "Invited" badge is an admin-only
  // detail. A member just sees the roster.
  const lastSignIn = new Map<string, string | null>();
  if (isAdmin) {
    try {
      const admin = createAdminClient();
      const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
      for (const u of data?.users ?? []) lastSignIn.set(u.id, u.last_sign_in_at ?? null);
    } catch {
      // Service key missing or the call failed — degrade to no pending badges
      // rather than breaking the page.
    }
  }

  const members: Member[] = profiles.map((p) => ({
    id: p.id,
    email: p.email,
    full_name: p.full_name,
    role: p.role as 'admin' | 'member',
    pending: isAdmin && lastSignIn.has(p.id) ? !lastSignIn.get(p.id) : false,
  }));

  return (
    <main className="sheet" style={{ padding: 24, maxWidth: 720 }}>
      <div className="sheet-head">
        <h1 className="sheet-title">Settings</h1>
        <p className="sheet-sub">
          {members.length} {members.length === 1 ? 'person' : 'people'} · invite only
        </p>
      </div>

      <section className="notes-sec">
        <p className="eyebrow">Your password</p>
        <p className="rail-note" style={{ margin: '6px 0 12px', borderLeft: 0, paddingLeft: 0 }}>
          Signed in as {user?.email}. Set a new one here — it takes effect immediately.
        </p>
        <PasswordForm />
      </section>

      <section className="notes-sec">
        <p className="eyebrow">Who&rsquo;s in</p>
        <div className="member-list">
          {members.map((m) => (
            <div key={m.id} className="member-row">
              <span className="avatar">{m.email.slice(0, 2).toUpperCase()}</span>
              <div className="member-id">
                <span className="member-email">{m.full_name ?? m.email}</span>
                {m.full_name && <span className="member-sub">{m.email}</span>}
              </div>
              <span className="member-role">
                {m.role === 'admin' ? 'Admin' : 'Member'}
                {m.id === user?.id ? ' · you' : ''}
                {m.pending && (
                  <span className="tag is-stamp" style={{ marginLeft: 8 }}>
                    invited
                  </span>
                )}
              </span>
              {isAdmin && m.id !== user?.id && m.role !== 'admin' && (
                <MemberActions id={m.id} email={m.email} pending={m.pending} />
              )}
            </div>
          ))}
        </div>

        {isAdmin ? (
          <div style={{ marginTop: 18 }}>
            <p className="eyebrow" style={{ marginBottom: 8 }}>
              Invite someone
            </p>
            <InviteForm />
            <p className="rail-note" style={{ marginTop: 8, maxWidth: '60ch' }}>
              They get an email with a link to set their own password. Only the admin can invite —
              anyone without one gets nothing, even with the URL.
            </p>
          </div>
        ) : (
          <p className="rail-note" style={{ marginTop: 14 }}>
            Only the admin can invite or remove people.
          </p>
        )}
      </section>
    </main>
  );
}
