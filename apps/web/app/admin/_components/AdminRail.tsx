'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Wordmark } from '@/components/ui/wordmark';

// Live sections link; not-yet-built ones show muted with a «скоро» marker so the
// rail reflects the real state (backend is ready; these screens are the next increment).
const LIVE = [
  { href: '/admin', label: 'Кокпит' },
  { href: '/admin/generation', label: 'Генерация' },
  { href: '/admin/users', label: 'Пользователи' },
  { href: '/admin/models', label: 'Модели' },
  { href: '/admin/audit', label: 'Аудит' },
];
const SOON: string[] = [];

export function AdminRail() {
  const path = usePathname();
  return (
    <aside className="sticky top-0 flex h-screen w-[232px] flex-col gap-7 border-r-[2.5px] border-line bg-surface p-5">
      <div className="flex items-baseline gap-2">
        <Wordmark size={26} />
        <span className="border-2 border-line bg-accent2 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-[color:var(--color-accent2-foreground)]">
          АДМИН
        </span>
      </div>
      <nav className="flex flex-col gap-1">
        {LIVE.map((item) => {
          const active =
            item.href === '/admin' ? path === '/admin' : (path?.startsWith(item.href) ?? false);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={
                'flex items-center gap-3 border-[2.5px] px-3 py-2.5 text-sm font-semibold ' +
                (active
                  ? 'border-line bg-accent text-[color:var(--color-primary-foreground)] shadow-[4px_4px_0_0_var(--color-line)]'
                  : 'border-transparent text-faint hover:text-fg')
              }
            >
              <span
                className={
                  'size-[18px] rounded-[3px] border-[2.5px] ' +
                  (active
                    ? 'border-[color:var(--color-primary-foreground)] bg-[color:var(--color-primary-foreground)]'
                    : 'border-current')
                }
              />
              {item.label}
            </Link>
          );
        })}
        {SOON.map((label) => (
          <span
            key={label}
            className="flex items-center gap-3 px-3 py-2.5 text-sm font-semibold text-faint/60"
          >
            <span className="size-[18px] rounded-[3px] border-[2.5px] border-current" />
            {label}
            <span className="ml-auto font-mono text-[9px] tracking-widest text-faint/60">
              СКОРО
            </span>
          </span>
        ))}
      </nav>
    </aside>
  );
}
