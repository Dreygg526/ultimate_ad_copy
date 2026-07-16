/**
 * Service-role Supabase client. BYPASSES RLS COMPLETELY.
 *
 * Two legitimate uses, both of which genuinely need to act as no user:
 *   1. Ingest, which writes ads on behalf of nobody and has no user JWT.
 *   2. Admin user-management (invite / remove), which calls the auth admin API —
 *      there is no user-scoped way to create or delete another auth account.
 *
 * Use (2) MUST verify the caller is the admin against their own session first
 * (see app/(desk)/settings/actions.ts → callingAdmin), because this client will
 * not do it for you. Never import this to serve an ordinary user request — use
 * the request-scoped client so RLS does its job.
 */
import 'server-only';
import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
