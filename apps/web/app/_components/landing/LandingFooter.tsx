'use client';

import Link from 'next/link';
import { Mark } from '@/components/ui/mark';
import { SupportLink } from '../SupportLink';

const LINKS: [string, string][] = [
  ['Вопросы и ответы', '/faq'],
  ['Оферта', '/legal/offer'],
  ['Конфиденциальность', '/legal/privacy'],
  ['Реквизиты', '/legal/requisites'],
];

const SUPPORT_HREF = 'mailto:support@vertov.space';

export function LandingFooter() {
  return (
    <footer className="px-6 py-10 md:px-11">
      <div className="mx-auto flex w-full max-w-[1400px] flex-col items-start justify-between gap-6 md:flex-row md:items-center">
        <div className="flex items-center gap-3">
          {/* final asterism mark (SPEC 11-04) + outline wordmark (D14) */}
          <Mark variant="plate" size={30} aria-hidden />
          <span className="font-display text-[16px] font-black tracking-[0.04em] text-transparent [-webkit-text-stroke:1.4px_var(--color-line)]">
            ВЕРТОВ
          </span>
        </div>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <SupportLink
            href={SUPPORT_HREF}
            className="font-sans text-[13px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            Поддержка · 5 рабочих дней
          </SupportLink>
          {LINKS.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className="font-sans text-[13px] font-semibold text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
            >
              {label}
            </Link>
          ))}
        </nav>
        <span className="font-mono text-[11px] font-bold text-[color:var(--color-muted-foreground)]">
          © {new Date().getFullYear()} Вертов
        </span>
      </div>
    </footer>
  );
}
