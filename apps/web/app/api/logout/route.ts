import { NextResponse, type NextRequest } from 'next/server';

const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'; // SSR: internal origin

// Better Auth session cookies (kept in sync with middleware.ts SESSION_COOKIES).
const SESSION_COOKIES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

export async function POST(req: NextRequest) {
  // Invalidate the session server-side. Forward the caller's cookies AND an origin
  // header so Better Auth trusts the server-to-server call and actually signs out.
  const cookieHeader = req.headers.get('cookie') ?? '';
  const publicBase =
    process.env.NEXT_PUBLIC_WEB_URL ?? process.env.WEB_PUBLIC_URL ?? req.nextUrl.origin;
  const apiRes = await fetch(`${API_URL}/api/auth/sign-out`, {
    method: 'POST',
    headers: { cookie: cookieHeader, origin: publicBase },
  }).catch(() => null);

  // Land on the landing (/), not /login — a logged-out user is a guest, and / renders
  // the public landing for guests (guest-CJM). 303 forces a GET on the redirect.
  const res = NextResponse.redirect(new URL('/', publicBase), { status: 303 });

  // Propagate the sign-out's clear-cookie so the BROWSER drops its session cookie —
  // without this the API session is gone but the browser keeps the cookie and re-auths.
  const setCookies = apiRes?.headers.getSetCookie?.() ?? [];
  for (const c of setCookies) res.headers.append('set-cookie', c);

  // Guaranteed fallback: expire the known session cookies here too, in case the API's
  // Set-Cookie didn't survive the server-to-server hop. Clear both the plain and the
  // __Secure- (prod, https) variants so logout is final regardless of environment.
  for (const name of SESSION_COOKIES) {
    res.cookies.set(name, '', { path: '/', maxAge: 0, expires: new Date(0) });
  }
  return res;
}
