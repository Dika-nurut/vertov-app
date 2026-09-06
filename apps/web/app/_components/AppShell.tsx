import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { BalanceWidget } from './BalanceWidget';
import { MobileTabBar } from './MobileTabBar';
import { NavLinks } from './NavLinks';
import { ProfileMenu, type ProfilePlan } from './ProfileMenu';
import { Mark } from '@/components/ui/mark';
import { OnboardingWrapper } from './OnboardingWrapper';
import { PWAInstallPrompt } from './PWAInstallPrompt';
import { BetaFooterWrapper } from './BetaFooterWrapper';
import { apiGet } from '../../lib/server-api';
import { ProjectChrome } from './ProjectChrome';
import { SupportLink } from './SupportLink';
import { PaymentResultToast } from './PaymentResultToast';
import type { ParsedProjectContext } from '@/lib/project-context';
import { normalizeLocale } from '@/lib/locale';

// Fused action-segment cell — verbatim NavLinks.tsx idiom (borders collapse
// via -ml, first:ml-0 zeroes it for whichever cell is actually first-child).
// NO `.press` here: these cells are fused into one continuous bar with no
// individual offset shadow, so the tactile "sink into its shadow" press feel
// (which assumes a shadow already sitting under the element) looked broken —
// a shadow box popping in from nowhere on click. A plain color transition on
// hover reads correctly for a fused segment. `h-10` is explicit (not padding-
// derived) so every cell in the bar — including ProfileMenu's, which shares
// this same height — is pixel-identical regardless of its own content.
const actionCellBase =
  'flex h-10 items-center -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)] transition-colors duration-150 first:ml-0 hover:text-[color:var(--color-fg)] lg:px-4 lg:text-[12px] lg:tracking-wide';

export async function AppShell({
  email,
  balance,
  apiUrl,
  onboardedAt,
  lang,
  fullBleed = false,
  isAnonymous = false,
  hideFooter = false,
  projectContext = { mode: 'standalone' },
  children,
}: {
  email: string;
  balance: number;
  apiUrl: string;
  onboardedAt?: string | null | undefined;
  lang?: string;
  /** App-surface mode (the Studio editor): lock the page to the viewport, give
   * `main` the remaining height with its own overflow, and drop the footer so a
   * fixed 4-zone editor shell never induces a document scroll. */
  fullBleed?: boolean;
  /** Hide the desktop footer on dock-fit tool screens (e.g. /generate at lg):
   * the dock already sizes itself to `100dvh - header`, so the footer's ~61px
   * would be pure page-level overflow. Footer links stay reachable via the
   * landing footer and /settings («Помощь и документы»). */
  hideFooter?: boolean;
  /** Pre-paywall anonymous browsing (2026-07-07 follow-up): an anonymous
   * ("Гость") session never went through a real signup, so it must NOT see
   * the full account menu (settings/billing/logout) — ProfileMenu renders a
   * lightweight "Войти" CTA instead. Defaults to false for the pages that
   * don't (yet) fetch `isAnonymous` off /v1/me. */
  isAnonymous?: boolean;
  /** Parsed by each server page so project URLs render their chrome shape on
   * the first paint; title/validity remain the client context's concern. */
  projectContext?: ParsedProjectContext;
  children: ReactNode;
}) {
  const activeLang = normalizeLocale(lang);

  function legalLink(path: string) {
    return `${path}?lang=${activeLang}`;
  }

  // Header redesign (2026-07-07, owner-approved mock mockups/header-v3.html):
  // primary nav keeps the creative surfaces plus the separate project-context
  // hub — Архив remains demoted into ProfileMenu. The curated Presets catalog
  // is parked by P-4 while Generate keeps in-context chips. «Создать» →
  // «Генерация».
  // 2026-07-27 (ruling R3): one vocabulary everywhere — the desk's set. «Доска»
  // → «Борды» and «Монтаж» → «Студия», so the same product is not called two
  // different things depending on which surface you read it from. These are
  // PRODUCT names; the document nouns («доска» as a board's title, «монтаж» as
  // a studio edit's title) are deliberately left alone.
  const nav = [
    { href: '/workspace', label: 'Среда' },
    { href: '/scenario', label: 'Сценарий' },
    { href: '/generate', label: 'Генерация' },
    { href: '/boards', label: 'Борды' },
    { href: '/studio/projects', activePrefix: '/studio', label: 'Студия' },
  ];

  // Plan/tier for ProfileMenu's card — best-effort: a fetch failure (or no
  // active subscription, i.e. the free tier) just renders the card without a
  // tier label rather than blocking the header.
  //
  // W0: the badge names the LIVE plan (`planAccess`), not the manageable row.
  // The label has to agree with what the model pickers will actually let the
  // viewer run — showing «Плюс» beside a catalogue of locked models is exactly
  // the disagreement canon §3 is about. `planAccess: null` renders «Free».
  const plan = await apiGet<{ planAccess: ProfilePlan | null } | null>('/v1/billing/subscription');

  return (
    <div
      className={
        fullBleed
          ? 'app-dense flex h-[100dvh] flex-col overflow-hidden'
          : 'flex min-h-screen flex-col'
      }
    >
      {/* Welcome card is server-truth gated; its own client dismissal is session-only. */}
      <Suspense>
        <OnboardingWrapper
          showOnboarding={onboardedAt === null}
          apiUrl={apiUrl}
          locale={activeLang}
          userKey={email}
        />
      </Suspense>
      <PaymentResultToast />

      {projectContext.mode !== 'standalone' ? (
        <ProjectChrome
          projectContext={projectContext}
          email={email}
          balance={balance}
          apiUrl={apiUrl}
          plan={plan.data?.planAccess ?? null}
          isAnonymous={isAnonymous}
        />
      ) : (
        <>
          {/* Header shell (2026-07-07 redesign): NO background, NO border — the
          bar is four floating groups directly on the page's own flat
          --color-bg canvas (matches the landing hero's sky test: zero header
          chrome reads as intentional there, and is invisible-but-correct here
          since the canvas is already dark). Still `sticky` so it stays put. */}
          <header className="sticky top-0 z-30 bg-transparent">
            <nav className="mx-auto flex w-full max-w-[1600px] items-center gap-2 px-3 py-3 sm:px-4 md:gap-3 lg:gap-6 lg:px-6">
              {/* Brand — final asterism mark (SPEC 11-04) + outline wordmark (D14);
              the retired periwinkle plate-wordmark is gone (the plate now lives
              only in the logo symbol). Always points home: / renders the launchpad
              for real accounts and the landing for guests (guest-CJM, 2026-07-09). */}
              <Link href="/" className="press flex shrink-0 items-center gap-1.5 lg:gap-2">
                <Mark variant="plate" size={30} aria-hidden />
                <span className="font-display text-[17px] font-black tracking-[0.05em] text-transparent [-webkit-text-stroke:1.4px_var(--color-line)] lg:text-[19px] md:[-webkit-text-stroke:1.6px_var(--color-line)]">
                  ВЕРТОВ
                </span>
              </Link>

              {/* Primary nav — route-aware active state (NavLinks is a client island). */}
              <NavLinks items={nav} />

              <div className="flex min-w-0 flex-1 items-center justify-end">
                {/* Action segment — fused bar mirroring NavLinks' own idiom
                (borders collapse via -ml, black cells, periwinkle = "active/
                open"). Replaces the old Language+Sound+JobsTray+Balance+
                Profile+email+logout row: language lives only in /settings
                now, sound/jobs/settings/archive/logout all moved into
                ProfileMenu. */}
                <div className="hidden items-stretch sm:flex">
                  {/* No search here: it is a Среда affordance and belongs to the
                  desk and the project bar, not to the site-wide header (owner,
                  2026-07-28 — «это фича среды была»). Note this also removes the
                  ⌘K/Ctrl+K listener from standalone routes, because the shortcut
                  is owned by the launcher component. */}
                  {/* "Апгрейд" implies upgrading an existing plan — nonsensical
                  next to "Войти" for a Гость who has no plan yet (owner,
                  2026-07-07: "u have upgrade and войти on the same header").
                  Anonymous sessions just see their (always-zero) balance. */}
                  {!isAnonymous && (
                    <Link href="/pricing" className={actionCellBase}>
                      Апгрейд
                    </Link>
                  )}
                  <BalanceWidget
                    initial={balance}
                    apiUrl={apiUrl}
                    className={actionCellBase + ' gap-1.5'}
                  />
                </div>
                <ProfileMenu
                  email={email}
                  balance={balance}
                  apiUrl={apiUrl}
                  plan={plan.data?.planAccess ?? null}
                  isAnonymous={isAnonymous}
                />
              </div>
            </nav>
          </header>
        </>
      )}

      {/* pb reserves room for the floating mobile dock (62px bar + gap + safe
          area). In fullBleed mode `main` owns the remaining height + overflow. */}
      <main
        className={
          fullBleed
            ? 'mx-auto flex w-full max-w-[1600px] min-h-0 flex-1 flex-col overflow-hidden'
            : 'mx-auto w-full max-w-[1600px] flex-1 pb-[88px] md:pb-0'
        }
      >
        {children}
      </main>

      <MobileTabBar isAnonymous={isAnonymous} />

      {!fullBleed && !hideFooter && (
        <footer className="hidden bg-[color:var(--color-surface)] md:block">
          {/* mobile: footer links live in the account screen (/settings) */}
          <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-6 font-mono text-[11px] uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
            <Link
              href={legalLink('/faq')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Вопросы и ответы
            </Link>
            <SupportLink
              href="mailto:support@vertov.space"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-[color:var(--color-accent)]"
              data-testid="support-link"
            >
              Поддержка
            </SupportLink>
            <Link
              href={legalLink('/legal/offer')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Оферта
            </Link>
            <Link
              href={legalLink('/legal/tos')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Условия
            </Link>
            <Link
              href={legalLink('/legal/aup')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Правила использования
            </Link>
            <Link
              href={legalLink('/legal/privacy')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Конфиденциальность
            </Link>
            <Link
              href={legalLink('/legal/refund')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Возврат
            </Link>
            <Link
              href={legalLink('/legal/requisites')}
              className="transition-colors hover:text-[color:var(--color-fg)]"
            >
              Реквизиты
            </Link>
            <span className="ml-auto">© Vertov 2026</span>
            <BetaFooterWrapper apiUrl={apiUrl} />
          </div>
        </footer>
      )}
      <PWAInstallPrompt />
    </div>
  );
}
