'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getOnboardingCopy } from '@/lib/onboarding-copy';
import {
  isKnownMobileRoute,
  isMobileDesktopOnlyRoute,
  mobileGenerateHref,
  mobileRouteLabel,
} from '@/lib/mobile-routes';
import { readClientLocale, type Locale } from '@/lib/locale';
import { useEffect, useState } from 'react';

const MOBILE_QUERY = '(max-width: 767px)';

function useMobileViewport(): boolean | null {
  const [mobile, setMobile] = useState<boolean | null>(null);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return mobile;
}

function useRouteLocale(): Locale {
  const pathname = usePathname();
  const [locale, setLocale] = useState<Locale>('ru');
  useEffect(() => setLocale(readClientLocale()), [pathname]);
  return locale;
}

function MobileDesktopNotice({ locale, pathname }: { locale: Locale; pathname: string }) {
  const copy = getOnboardingCopy(locale).mobile;
  const router = useRouter();
  const label = mobileRouteLabel(pathname, locale);
  // Keep the intercepted pathname separate from Generate's `from=<jobId>`
  // remix-prefill query parameter; `lang` preserves the EN locale across the hop.
  const href = mobileGenerateHref(pathname, locale);
  const fallbackHref = locale === 'en' ? '/generate?lang=en' : '/generate';
  // R4 pattern: an empty history (deep link straight into the gated route)
  // makes router.back() a no-op — fall back to /generate instead.
  function goBack() {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push(fallbackHref);
  }
  const shortPath = pathname.length > 32 ? `${pathname.slice(0, 32)}…` : pathname;
  return (
    <main
      className="flex min-h-[100dvh] items-center justify-center px-6 py-12 pb-[calc(6rem+env(safe-area-inset-bottom))]"
      data-testid="mobile-desktop-notice"
    >
      <div className="w-full max-w-sm border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 text-center shadow-[5px_5px_0_0_var(--color-shadow)] onboarding-surface onboarding-surface-enter">
        <p className="label-eyebrow mb-2">VERTOV · MOBILE</p>
        <h1 className="font-display text-[21px] font-black uppercase leading-tight text-[color:var(--color-fg)]">
          {copy.title}
        </h1>
        <p className="mt-3 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          {copy.body}
        </p>
        <p
          data-testid="mobile-desktop-destination"
          title={pathname}
          className="mt-2 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-[color:var(--color-faint)]"
        >
          {label} · {shortPath}
        </p>
        <Link
          href={href}
          className="press mt-5 inline-flex min-h-11 items-center justify-center border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
          data-testid="mobile-desktop-link"
        >
          {copy.link}
        </Link>
        <button
          type="button"
          onClick={goBack}
          data-testid="mobile-desktop-back"
          className="press-inset mx-auto mt-2.5 flex min-h-11 items-center justify-center px-4 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
        >
          ← {copy.back}
        </button>
      </div>
    </main>
  );
}

export function MobileRouteGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const mobile = useMobileViewport();
  const locale = useRouteLocale();

  if (!isMobileDesktopOnlyRoute(pathname) || mobile === false) return children;
  if (mobile === null) return null;
  // Unknown paths are not gated: let not-found.tsx answer "page doesn't exist"
  // instead of "open on desktop".
  if (!isKnownMobileRoute(pathname)) return children;
  return <MobileDesktopNotice locale={locale} pathname={pathname} />;
}
