'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Client only because the active-tab state reads the pathname.
const SCREENS = [
  { href: '/library', label: 'Library' },
  { href: '/deconstruct', label: 'Deconstruct' },
  { href: '/rebuild', label: 'Rebuild' },
  { href: '/review', label: 'Review' },
  { href: '/brand', label: 'Brand' },
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
        {email ?? 'not signed in'}
      </div>
    </header>
  );
}
