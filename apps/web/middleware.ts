import { NextRequest, NextResponse } from 'next/server';

// Public routes — everything else requires a session cookie.
const PUBLIC = [
  // Root renders the marketing landing for anonymous visitors (page.tsx branches
  // on session itself); authed users still get the real app home at the same path.
  /^\/$/,
  /^\/login(\/.*)?$/,
  // Yandex ID SUGGEST token page — must be reachable without a session (Yandex
  // redirects the access token here before any login exists).
  /^\/auth\/yandex-token$/,
  /^\/g\/.*/,
  /^\/pricing$/,
  /^\/faq$/,
  /^\/support$/,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/legal\/.*/,
  /^\/i\/.*/,
];

// Pre-paywall anonymous browsing (2026-07-07): these four creative surfaces
// are reachable with NO session cookie at all — the page itself (server
// component) renders an anon-session bootstrap on first touch instead of
// bouncing here. Unlike PUBLIC above, an authenticated OR anonymous session
// still applies normally past this point; this list only turns off the
// redirect-to-/login for the cookie-less case. The credit-spending wall lives
// deeper, at the actual AI-model-call endpoints (jobs/assist), not here.
const ANON_BROWSABLE = [
  /^\/generate$/,
  /^\/boards(\/.*)?$/,
  /^\/scenario(\/.*)?$/,
  /^\/studio(\/.*)?$/,
];

// Better Auth session cookie names. The `better-auth.session_token` is the canonical one;
// the secure prefix variant ships when cookies.sameSite is 'none' and secure is true.
const SESSION_COOKIES = ['better-auth.session_token', '__Secure-better-auth.session_token'];
const DEVICE_COOKIE = 'seed_did';
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const existingDeviceId = req.cookies.get(DEVICE_COOKIE)?.value;
  const deviceId = existingDeviceId ?? crypto.randomUUID();

  // Server Components call /v1/me through a server-to-server fetch. Forward a
  // newly minted id in this very first request as well as setting it on the
  // response; otherwise the API's Set-Cookie would be swallowed by that hop and
  // the L0 cluster could receive a one-off id different from later requests.
  const next = (): NextResponse => {
    const requestHeaders = new Headers(req.headers);
    if (!existingDeviceId) {
      const cookie = requestHeaders.get('cookie');
      requestHeaders.set('cookie', `${cookie ? `${cookie}; ` : ''}${DEVICE_COOKIE}=${deviceId}`);
    }
    return withDeviceCookie(NextResponse.next({ request: { headers: requestHeaders } }));
  };
  const withDeviceCookie = (response: NextResponse): NextResponse => {
    if (!existingDeviceId) {
      response.cookies.set(DEVICE_COOKIE, deviceId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: DEVICE_COOKIE_MAX_AGE,
      });
    }
    return response;
  };

  if (pathname === '/styleguide' || pathname === '/showcase') {
    return withDeviceCookie(new NextResponse('Not found', { status: 404 }));
  }

  // P-4 launch policy: the curated Presets catalog is parked for every
  // visitor, including guests. Handle it before the session redirect so an
  // old deep link cannot turn into a misleading login destination.
  if (pathname === '/presets' || pathname.startsWith('/presets/')) {
    return withDeviceCookie(new NextResponse('Not found', { status: 404 }));
  }

  // Allow Next internals, static, API routes, and explicit public paths.
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/sounds/') ||
    pathname.startsWith('/brand/') ||
    pathname.startsWith('/landing/') ||
    // Asset-bucket paths are same-origin by design (assetSrc invariant) —
    // proxied to MinIO by Caddy (prod) or a next.config rewrite (previews);
    // never gate them behind a session.
    pathname.startsWith('/seed-assets/') ||
    pathname.startsWith('/seed-preset-previews/') ||
    pathname.startsWith('/seed-demo-assets/') ||
    pathname.startsWith('/plausible/') ||
    pathname === '/favicon.ico' ||
    pathname === '/manifest.webmanifest' ||
    // App-router metadata files (app/icon.png, app/apple-icon.png,
    // app/opengraph-image.png) are served at the root — crawlers and
    // anonymous visitors must reach them without a session.
    pathname === '/icon.png' ||
    pathname === '/apple-icon.png' ||
    pathname === '/opengraph-image.png' ||
    PUBLIC.some((re) => re.test(pathname))
  ) {
    return next();
  }

  const hasSession = SESSION_COOKIES.some((name) => req.cookies.get(name));
  if (!hasSession) {
    // AUDIT BYPASS — local UI audit only, OFF by default. Opens ONLY when both
    // hold: (1) AUDIT_AUTH_BYPASS is set to a non-empty value in the *process*
    // env (never committed, never provisioned on prod), (2) the request targets
    // loopback (localhost/127.0.0.1 — never a public host). Passed-through
    // requests still hit the API's own session wall (data fetches 401, spending
    // stays closed); only the page shells/layouts become inspectable.
    // RESTORE: unset AUDIT_AUTH_BYPASS and restart — the wall returns exactly
    // (proven by the safety test + the curl matrix in the audit evidence).
    const auditBypass =
      (process.env.AUDIT_AUTH_BYPASS ?? '').length > 0 &&
      /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.get('host') ?? '');
    if (auditBypass) {
      return next();
    }
    if (ANON_BROWSABLE.some((re) => re.test(pathname))) {
      return next();
    }
    const url = req.nextUrl.clone();
    // Carry the intended destination (path + query) so login can return the
    // visitor there — this is how the landing prompt bar's /generate?prompt=…
    // and preset deep links survive the login round-trip (login reads a
    // sanitized ?next= via loginNextTarget). Previously the original query was
    // left dangling on /login and dropped; now it's a proper ?next=.
    const dest = pathname + req.nextUrl.search;
    url.pathname = '/login';
    url.search = '';
    // Only a GET destination survives the round-trip: login returns the visitor
    // with a GET, so carrying a POST-only path (e.g. /workspace/resolve/:product)
    // would land them on a 405 instead of their work. Accepted cost: a visitor
    // whose session expired while a form was on screen loses their place and
    // lands on the default post-login page rather than back where they were.
    // That is strictly better than a 405, and the only non-GET path that can
    // reach here is the dock resolver.
    if (req.method === 'GET') url.searchParams.set('next', dest);
    // Behind a reverse proxy / tunnel, req.nextUrl carries the internal host
    // (localhost:3000). Pin the redirect to the configured public origin so
    // browsers aren't bounced to their own localhost.
    const pub = process.env.NEXT_PUBLIC_WEB_URL;
    if (pub) {
      const o = new URL(pub);
      url.protocol = o.protocol;
      url.hostname = o.hostname;
      url.port = o.port; // '' for default ports — clears the internal :3000
    }
    return withDeviceCookie(NextResponse.redirect(url));
  }

  return next();
}

export const config = {
  // Run on everything except Next internals + favicon. Public paths are handled above.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
