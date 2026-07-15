import { TopBar } from '@/app/components/TopBar';
import { createClient } from '@/lib/supabase/server';

// The signed-in shell. proxy.ts already bounced anyone without a session; this
// only needs the identity for display. The real access boundary is RLS.
export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  return (
    <>
      <TopBar email={user?.email} />
      {children}
    </>
  );
}
