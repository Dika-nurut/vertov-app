// Known app routes for the mobile gate (MobileRouteGate). Anything else (typos,
// dead deep links) falls through so not-found.tsx can render instead of a
// mobile desktop notice.
const KNOWN_MOBILE_ROUTES = [
  /^\/$/u,
  /^\/generate(?:\/|$)/u,
  /^\/boards(?:\/|$)/u,
  /^\/scenario(?:\/|$)/u,
  /^\/studio(?:\/|$)/u,
  /^\/gallery(?:\/|$)/u,
  /^\/workspace(?:\/|$)/u,
  /^\/settings(?:\/|$)/u,
  /^\/billing(?:\/|$)/u,
  /^\/search(?:\/|$)/u,
  /^\/media(?:\/|$)/u,
  /^\/pricing(?:\/|$)/u,
  /^\/faq(?:\/|$)/u,
  /^\/support(?:\/|$)/u,
  /^\/legal(?:\/|$)/u,
  /^\/g(?:\/|$)/u,
  /^\/login(?:\/|$)/u,
  /^\/auth(?:\/|$)/u,
  /^\/i(?:\/|$)/u,
];

// These products are intentionally desktop-only on phones. Their dense canvas,
// timeline, and project-desk interactions are not being squeezed into a touch UI.
const MOBILE_DESKTOP_ONLY_ROUTES = [
  /^\/boards(?:\/|$)/u,
  /^\/studio(?:\/|$)/u,
  /^\/workspace(?:\/|$)/u,
];

export function isKnownMobileRoute(pathname: string): boolean {
  return KNOWN_MOBILE_ROUTES.some((re) => re.test(pathname));
}

export function isMobileDesktopOnlyRoute(pathname: string): boolean {
  return MOBILE_DESKTOP_ONLY_ROUTES.some((re) => re.test(pathname));
}
