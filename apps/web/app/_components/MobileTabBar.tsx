'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Images, Wand2 } from '@/components/ui/icons';
import { withLocale, type Locale } from '@/lib/locale';

/**
 * Bottom tab bar — the mobile primary navigation (the desktop nav links are
 * hidden below md). Design = "floating brutalist dock" (owner-picked variant B):
 * the bar lifts off the screen edge with the Slate Brutal signature — a 2.5px
 * bone border + a hard periwinkle offset-shadow, sharp corners — and the active
 * tab is marked by an accent icon/label + a short periwinkle under-block. Safe-
 * area aware.
 *
 * Scope: the mobile app surfaces only what actually works on a phone —
 * Генерация (/generate) and Архив (/gallery). The curated preset catalog is
 * parked by the P-4 launch policy; in-context chips remain inside Generate.
 * Boards/Монтаж are desktop-only (canvas + editor backlogged for touch); the
 * account/profile lives in the header avatar → /settings.
 *
 * The two slots stay fixed for anonymous and authenticated sessions. A locked
 * route is handled by the existing mobile gate after the tap rather than
 * shifting the user's muscle memory when auth state changes.
 */
const TABS = [
  { href: '/generate', label: 'Генерация', icon: Wand2 },
  { href: '/gallery', label: 'Архив', icon: Images },
] as const;

export function MobileTabBar({ locale = 'ru' }: { isAnonymous?: boolean; locale?: Locale }) {
  const pathname = usePathname();

  return (
    // Outer = fixed positioning layer (pointer-events off so the gap below the
    // floating bar doesn't eat taps); the inner dock re-enables pointer events.
    <nav
      data-testid="mobile-tab-bar"
      aria-label="Основная навигация"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-3 pb-[calc(0.625rem+env(safe-area-inset-bottom))] md:hidden"
    >
      <div
        className={
          'pointer-events-auto grid h-[62px] overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[4px_4px_0_0_var(--color-shadow)] ' +
          'grid-cols-2'
        }
      >
        {TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          const Icon = t.icon;
          return (
            <Link
              key={t.href}
              href={withLocale(t.href, locale)}
              aria-current={active ? 'page' : undefined}
              className={
                'press-inset relative flex flex-col items-center justify-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wide transition-colors ' +
                (active
                  ? 'text-[color:var(--color-accent)]'
                  : 'text-[color:var(--color-muted-foreground)]')
              }
            >
              <Icon size={22} aria-hidden strokeWidth={active ? 2.4 : 1.8} />
              {t.label}
              {active && (
                <span
                  aria-hidden
                  className="absolute bottom-[7px] left-1/2 h-[3px] w-5 -translate-x-1/2 bg-[color:var(--color-accent)]"
                />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
