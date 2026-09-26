'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';
import { normalizeLocale, readClientLocale, type Locale } from '@/lib/locale';

/**
 * LanguageToggle — #11 audit fix.
 *
 * Settings is the only surface that persists locale. Public documents update
 * only their URL by default, so switching a legal page cannot silently mutate
 * an account or a browser cookie. `readOnly` is available for surfaces that
 * should link to the preference screen instead of offering URL switching.
 *
 * apiUrl defaults to NEXT_PUBLIC_API_URL — must be present at runtime.
 */
export function LanguageToggle({
  apiUrl,
  persist = false,
  readOnly = false,
}: {
  apiUrl?: string;
  persist?: boolean;
  readOnly?: boolean;
} = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const currentLang: Locale = normalizeLocale(searchParams.get('lang') ?? readClientLocale());
  const _apiUrl = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '';

  function switchLang(lang: Locale) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('lang', lang);
    if (persist) {
      // Settings owns persistence; public documents only ever update their URL.
      document.cookie = `lang=${lang}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    }
    if (persist && _apiUrl) {
      void fetch(`${_apiUrl}/v1/me/locale`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: lang }),
      }).catch(() => undefined);
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  if (readOnly) {
    return (
      <Link
        href="/settings"
        data-testid="lang-settings-link"
        className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-2.5 py-1 font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
      >
        Язык: {currentLang.toUpperCase()} · настройки
      </Link>
    );
  }

  return (
    // Brutalist segmented control — two bordered blocks sharing one bone border;
    // the active locale fills periwinkle (dark on-accent text for AA), reading as
    // "you are here" the way a first-time user expects.
    <div
      className="flex items-stretch border-[2.5px] border-[color:var(--color-line)] font-mono text-[13px] font-bold"
      role="group"
      aria-label="Переключить язык"
    >
      {(['ru', 'en'] as const).map((lng, i) => {
        const active = currentLang === lng;
        return (
          <button
            key={lng}
            type="button"
            onClick={() => switchLang(lng)}
            aria-pressed={active}
            data-testid={`lang-${lng}`}
            className={
              'px-2.5 py-1 uppercase tracking-wide transition-colors ' +
              (i === 1 ? 'border-l-[2.5px] border-[color:var(--color-line)] ' : '') +
              (active
                ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                : 'bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
            }
          >
            {lng.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
