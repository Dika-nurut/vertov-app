// Known app routes for the mobile gate (MobileRouteGate): the desktop notice
// applies to THESE on small screens. Anything else (typos, dead deep links)
// falls through so not-found.tsx can render instead of the notice.
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

export function isKnownMobileRoute(pathname: string): boolean {
  return KNOWN_MOBILE_ROUTES.some((re) => re.test(pathname));
}
