/**
 * Service-role Supabase client. BYPASSES RLS COMPLETELY.
 *
 * Only for ingest, which writes ads on behalf of nobody and so has no user JWT
 * to act under. Never import this to serve a user request — use the request-
 * scoped client so RLS does its job.
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
