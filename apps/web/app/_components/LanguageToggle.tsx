'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useRouter } from 'next/navigation';

/**
 * LanguageToggle — #11 audit fix.
 *
 * Unified locale source of truth: clicking RU/EN does three things atomically:
 * 1. Updates the URL ?lang= param and lang cookie (immediate UI response).
 * 2. POSTs /v1/me/locale to persist the choice to users_app.locale (DB).
 *    This is fire-and-forget — a failure is non-fatal (user still sees the
 *    switched language; next /v1/me/profile response will re-sync from DB).
 * 3. The AppShell server component reads `users_app.locale` on each page
 *    load via /v1/me/profile and passes it as the `lang` prop, so DB is the
 *    canonical source.
 *
 * apiUrl defaults to NEXT_PUBLIC_API_URL — must be present at runtime.
 */
export function LanguageToggle({
  apiUrl,
}: {
  apiUrl?: string;
} = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const currentLang = searchParams.get('lang') ?? 'ru';
  const _apiUrl = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '';

  function switchLang(lang: 'ru' | 'en') {
    const params = new URLSearchParams(searchParams.toString());
    params.set('lang', lang);
    // 1. Persist in cookie for server components that read it.
    document.cookie = `lang=${lang}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    // 2. Persist to DB (fire-and-forget — non-fatal if the user is not signed in).
    if (_apiUrl) {
      void fetch(`${_apiUrl}/v1/me/locale`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ locale: lang }),
      }).catch(() => undefined);
    }
    // 3. Update URL so server components re-render with the new locale.
    router.push(`${pathname}?${params.toString()}`);
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
