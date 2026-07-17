'use client';

/**
 * Browser Supabase client. Only for things the server can't do — namely
 * resumable large-file uploads straight to Storage, which must not pass through
 * a Next server action (a 1 GB body would blow the ~4.5 MB serverless limit).
 *
 * It carries the signed-in user's session (cookies), so Storage RLS still
 * applies: `storage_library` requires is_member(). The anon key is public by
 * design; RLS is the boundary.
 */
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
