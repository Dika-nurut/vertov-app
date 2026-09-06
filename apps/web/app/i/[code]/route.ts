/**
 * /i/[code] — beta invite landing route handler (W4.Fri, fixed W4 audit).
 *
 * In Next.js 15, cookies can only be set in Route Handlers or Server Actions,
 * NOT in Server Components (page.tsx). This file replaces the original page.tsx
 * with a Route Handler that sets the cookie and redirects.
 *
 * Public route — accessible without a session cookie (see middleware.ts PUBLIC).
 * Sets a 30-day beta-invite cookie, then redirects to /login?next=/.
 *
 * #15 audit fix: secure: process.env.NODE_ENV === 'production' added so the
 * cookie is HTTPS-only in production and works on plain HTTP in dev.
 */
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code } = await params;

  // Sanitise the code — only uppercase alphanumeric + dash allowed.
  const safeCode = code.replace(/[^A-Za-z0-9-]/g, '').toUpperCase();

  if (safeCode.length > 0) {
    const jar = await cookies();
    jar.set('seed_beta_code', safeCode, {
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
      httpOnly: false, // must be readable by client-side JS for the redeem useEffect
      sameSite: 'lax',
      // Require HTTPS in production so the cookie is not transmitted over
      // plain HTTP. In development (http://localhost or http://IP) secure must
      // be false or the browser will silently drop the cookie. (#15 audit fix)
      secure: process.env.NODE_ENV === 'production',
    });
  }

  // Use the public web URL from env (same pattern as the rest of the codebase)
  // to avoid the request URL containing 0.0.0.0 when the server is bound to
  // all interfaces. Falls back to using the request URL's origin as a last resort.
  const publicBase =
    process.env.NEXT_PUBLIC_WEB_URL ??
    process.env.WEB_PUBLIC_URL ??
    process.env.NEXTAUTH_URL ??
    _req.nextUrl.origin;
  return NextResponse.redirect(`${publicBase}/login?next=/`);
}
