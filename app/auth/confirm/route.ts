import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { type EmailOtpType } from '@supabase/supabase-js';

/**
 * The landing point for every emailed auth link — invites and password resets.
 *
 * Supabase sends the recipient here with either a PKCE `code` or a
 * `token_hash`+`type` pair. We exchange it for a session (setting the auth
 * cookies on the redirect response the same way the middleware does), then send
 * them on to `next` — normally /auth/set-password, where they choose a password.
 *
 * This runs with no prior session, which is exactly why proxy.ts lets /auth
 * through without bouncing to /signin.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/library';

  const done = NextResponse.redirect(new URL(next, origin));

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            done.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return done;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return done;
  }

  // Expired or reused link — the tokens are single-use and short-lived.
  return NextResponse.redirect(new URL('/signin?error=link', origin));
}
