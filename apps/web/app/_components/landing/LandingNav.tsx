import Link from 'next/link';
import { NavLinks } from '../NavLinks';
import { Mark } from '@/components/ui/mark';

// Same four tabs AppShell shows once logged in — the product's own nav,
// browsable pre-paywall (owner: "let people see the menu like Runway/Krea/
// Higgsfield do"; clicking through still bounces to /login today, since the
// middleware gate itself is unchanged — that's a separate, still-open step).
const NAV = [
  { href: '/scenario', label: 'Сценарий' },
  { href: '/generate', label: 'Генерация' },
  { href: '/boards', label: 'Борды' },
  { href: '/studio/projects', activePrefix: '/studio', label: 'Студия' },
];

const cellBase =
  'press-inset -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3.5 py-1.5 font-mono text-[13px] font-bold uppercase tracking-wide text-[color:var(--color-muted-foreground)] transition-colors duration-150 first:ml-0 hover:text-[color:var(--color-fg)]';

/** Header (2026-07-07 redesign, owner-approved mockups/header-v3.html):
 *  `fixed` — floats directly on the hero's animated night sky with ZERO
 *  header-shell chrome (no background, no border); Hero's 100svh section is
 *  now the true first element in flow (this bar occupies no layout space),
 *  so the sky starts at the real viewport top exactly like the mock tested.
 *  Guest action cluster mirrors NavLinks' own fused-segment idiom: borders
 *  collapse, «Регистрация» fills solid accent (no separate signup flow exists
 *  today — it points at the same /login as «Войти», same as the mock). */
export function LandingNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-30">
      <nav className="mx-auto flex h-[72px] w-full max-w-[1600px] items-center gap-3 px-4 sm:px-6 md:gap-6">
        <div className="flex shrink-0 items-center gap-3">
          {/* final asterism mark (SPEC 11-04) — replaces the retired orchid logo.png (D14).
              Carries the accessible name since the wordmark is hidden on mobile. */}
          <Mark
            variant="plate"
            size={38}
            className="md:h-[42px] md:w-[42px]"
            role="img"
            aria-label="Вертов"
          />
          {/* outline wordmark (quiet-sky mockup pick, 2026-07-05) — decorative, mark names it */}
          <span
            aria-hidden
            className="font-display hidden text-[20px] font-black tracking-[0.05em] text-transparent [-webkit-text-stroke:1.4px_var(--color-line)] sm:inline md:text-[23px] md:[-webkit-text-stroke:1.6px_var(--color-line)]"
          >
            ВЕРТОВ
          </span>
        </div>

        <NavLinks items={NAV} />

        <div className="flex min-w-0 flex-1 items-center justify-end">
          <div className="hidden items-stretch sm:flex">
            <Link href="/pricing" className={cellBase}>
              Тарифы
            </Link>
            <Link href="/login" className={cellBase}>
              Войти
            </Link>
            <Link
              href="/login"
              className="press-inset -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3.5 py-1.5 font-mono text-[13px] font-bold uppercase tracking-wide text-[color:var(--color-primary-foreground)]"
            >
              Регистрация
            </Link>
          </div>
          <Link
            href="/login"
            className="press-inset border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3.5 py-1.5 font-mono text-[13px] font-bold uppercase tracking-wide text-[color:var(--color-primary-foreground)] sm:hidden"
          >
            Войти
          </Link>
        </div>
      </nav>
    </header>
  );
}
