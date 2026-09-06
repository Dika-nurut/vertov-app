export type Locale = 'ru' | 'en';

/** RU is the product default; unsupported values deliberately fail back to RU. */
export function normalizeLocale(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'ru';
}

/** Read the same URL/cookie locale that the existing LanguageToggle writes. */
export function readClientLocale(fallback: Locale = 'ru'): Locale {
  if (typeof window === 'undefined') return fallback;
  const queryLocale = new URLSearchParams(window.location.search).get('lang');
  if (queryLocale) return normalizeLocale(queryLocale);
  const cookieLocale = document.cookie.match(/(?:^|;\s*)lang=([^;]+)/)?.[1];
  return cookieLocale ? normalizeLocale(cookieLocale) : fallback;
}
