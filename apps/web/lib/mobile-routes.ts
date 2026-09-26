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

// These products are intentionally desktop-only on phones. Their dense canvas,
// timeline, and project-desk interactions are not being squeezed into a touch UI.
// Everything else known (landing/home, Generate, Scenario, money + docs) stays
// fully usable on a phone (prod fix 14aedfc, 2026-09).
const MOBILE_DESKTOP_ONLY_ROUTES = [
  /^\/boards(?:\/|$)/u,
  /^\/studio(?:\/|$)/u,
  /^\/workspace(?:\/|$)/u,
];

export function isMobileDesktopOnlyRoute(pathname: string): boolean {
  return MOBILE_DESKTOP_ONLY_ROUTES.some((re) => re.test(pathname));
}

// First-segment → human route label for the mobile desktop notice
// (MobileRouteGate). RU-first; unknown/segment-less paths fall back to
// Generate — the notice's only onward route.
const MOBILE_ROUTE_LABELS_RU: Record<string, string> = {
  boards: 'Борды',
  studio: 'Студия',
  workspace: 'Среда',
  scenario: 'Сценарий',
  gallery: 'Архив',
  search: 'Поиск',
};

const MOBILE_ROUTE_LABELS_EN: Record<string, string> = {
  boards: 'Boards',
  studio: 'Studio',
  workspace: 'Workspace',
  scenario: 'Scenario',
  gallery: 'Archive',
  search: 'Search',
};

export function mobileRouteLabel(pathname: string, locale: 'ru' | 'en'): string {
  const segment = pathname.split('/').filter(Boolean)[0] ?? '';
  const labels = locale === 'en' ? MOBILE_ROUTE_LABELS_EN : MOBILE_ROUTE_LABELS_RU;
  return labels[segment] ?? (locale === 'en' ? 'Generate' : 'Генерация');
}

export function mobileGenerateHref(pathname: string, locale: 'ru' | 'en'): string {
  const params = new URLSearchParams({ gateFrom: pathname });
  if (locale === 'en') params.set('lang', 'en');
  return `/generate?${params.toString()}`;
}
