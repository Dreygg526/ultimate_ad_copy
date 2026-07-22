'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/app/auth/actions';

// Client only because the active-tab state reads the pathname.
//
// Deconstruct and Rebuild are deliberately NOT tabs. They are still routes —
// /deconstruct/[adId] for the marks, /rebuild/[adId] for editing a saved draft —
// but a buyer reaches them from the ad they're looking at, not by walking the
// steps in order. Putting them back in the nav rebuilds the four-screen errand
// the user rejected.
const SCREENS = [
  { href: '/library', label: 'Library' },
  { href: '/review', label: 'Review' },
  { href: '/brand', label: 'Brand' },
  { href: '/settings', label: 'Settings' },
] as const;

export function TopBar({ email }: { email?: string }) {
  const pathname = usePathname();
  const initials = email ? email.slice(0, 2).toUpperCase() : '··';

  return (
    <header className="topbar">
      <Link href="/library" className="wordmark">
        Teardown
      </Link>
      <nav className="nav">
        {SCREENS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className={pathname.startsWith(s.href) ? 'is-on' : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      <div className="whoami">
        <span className="avatar">{initials}</span>
        <span>{email ?? 'not signed in'}</span>
        <form action={signOut}>
          <button type="submit" className="signout">
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
