import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Refreshes the auth session and keeps signed-out users off the desk.
 *
 * This is a redirect for UX, NOT the security boundary — RLS is. A stranger who
 * defeated this would still read nothing, because every table requires a
 * profiles row via is_member(). Never move an access decision here from RLS.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getUser() revalidates against the auth server; getSession() trusts the
  // cookie and can be spoofed. Use getUser here.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isSignIn = pathname.startsWith('/signin');
  // /auth/* carries the email-link callback and the set-password page. The
  // callback runs with no session yet (it is what establishes one), so it must
  // not be bounced to /signin.
  const isAuthFlow = pathname.startsWith('/auth');

  if (!user && !isSignIn && !isAuthFlow) {
    const url = request.nextUrl.clone();
    url.pathname = '/signin';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  if (user && isSignIn) {
    const url = request.nextUrl.clone();
    url.pathname = '/library';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the sync endpoint (which carries its
    // own shared-secret guard and has no user session).
    '/((?!_next/static|_next/image|favicon.ico|api/sync|.*\\.(?:svg|png|jpg|jpeg|gif|webp|woff2?)$).*)',
  ],
};
