'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { isNavItemActive } from '@/lib/nav-active';

export interface NavItem {
  href: string;
  label: string;
  activePrefix?: string;
}

/**
 * Desktop primary nav. Route-aware active state — the highlighted tab follows
 * the current section instead of being pinned to «Создать» (the old shell
 * hard-coded i===0, so every page falsely lit the first tab). A first-time
 * user reads "where am I" from the one periwinkle-filled segment; everything
 * else is a quiet surface block that brightens on hover.
 *
 * The match is prefix-based so /boards/<id>, /gallery/<id> etc. keep their
 * parent tab lit. «Создать» (/generate) must match exactly so it doesn't also
 * claim the root.
 */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? '';
  return (
    // Brutalist segmented nav — bordered blocks whose 2.5px bone borders collapse
    // into one continuous bar; the active section fills periwinkle (dark text for
    // AA), the rest are quiet surface blocks that fill on hover.
    <div className="hidden items-stretch md:flex" data-testid="product-nav">
      {items.map((n) => {
        const active = isNavItemActive(pathname, n);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // No `.press` — this is a fused bar cell with no individual
              // offset shadow (matches the header's other cells: AppShell.tsx
              // actionCellBase / ProfileMenu cellBase). `h-10` explicit (not
              // padding-derived) so the whole header bar is one uniform
              // height end to end. Compact at md (tablet 768–1024: tighter
              // tracking + smaller type/padding so all five RU labels fit),
              // full measure at lg+.
              'flex h-10 items-center -ml-[2.5px] border-[2.5px] border-[color:var(--color-line)] px-2.5 font-mono text-[12px] font-bold uppercase tracking-[0.04em] transition-colors duration-150 first:ml-0 lg:px-3.5 lg:text-[13px] lg:tracking-wide',
              active
                ? 'z-10 bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                : 'bg-[color:var(--color-surface)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]',
            )}
          >
            {n.label}
          </Link>
        );
      })}
    </div>
  );
}
