import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/ui/wordmark';
import { Suspense } from 'react';
import { LanguageToggle } from '../_components/LanguageToggle';
import { SupportLink } from '../_components/SupportLink';
import { LandingFooter } from '../_components/landing/LandingFooter';

export const metadata: Metadata = {
  title: 'Поддержка — Vertov',
  description:
    'Поддержка Vertov: общие вопросы, возвраты, технические сбои, персональные данные и юридические обращения.',
  alternates: { canonical: '/support' },
};
export const dynamic = 'force-dynamic';

export default function SupportPage() {
  return (
    <div className="min-h-screen">
      <header className="bg-transparent">
        <nav className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <Link href="/" className="press inline-flex items-center">
            <Wordmark size={28} />
          </Link>
          <Suspense>
            <LanguageToggle />
          </Suspense>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-10">
        {/* Macro panel grammar (bible §3): surface + bone 2.5px + 6px periwinkle
            offset — the editorial content reads as one slab, like pricing plates. */}
        <div
          className="brutal-card px-6 py-7 sm:px-8"
          style={{ boxShadow: '6px 6px 0 0 var(--color-shadow)' }}
        >
          <h1 className="text-h1 text-[color:var(--color-fg)]">Поддержка</h1>
          <p className="mt-4 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Напишите на{' '}
            <SupportLink
              href="mailto:support@vertov.space"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              support@vertov.space
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Общие вопросы</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            По общим вопросам напишите в{' '}
            <SupportLink
              href="mailto:support@vertov.space"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              поддержку
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Возвраты и оплата</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Для возврата напишите на{' '}
            <SupportLink
              href="mailto:support@vertov.space?subject=Возврат"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              support@vertov.space
            </SupportLink>{' '}
            с темой «Возврат». Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Технические сбои</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Если генерация завершилась ошибкой, напишите на{' '}
            <SupportLink
              href="mailto:support@vertov.space?subject=Vertov+issue"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              support@vertov.space
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Персональные данные</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            По вопросам персональных данных напишите на{' '}
            <SupportLink
              href="mailto:privacy@vertov.space"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              privacy@vertov.space
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Юридические вопросы</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            По юридическим вопросам напишите на{' '}
            <SupportLink
              href="mailto:legal@vertov.space"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold text-[color:var(--color-accent)] underline"
            >
              legal@vertov.space
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>

          <h2 className="mt-8 text-h2 text-[color:var(--color-fg)]">Полезные ссылки</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            <li>
              <Link href="/faq" className="underline">
                Частые вопросы
              </Link>
            </li>
            <li>
              <Link href="/legal/requisites" className="underline">
                Реквизиты и контакты
              </Link>
            </li>
            <li>
              <Link href="/legal/refund" className="underline">
                Политика возврата
              </Link>
            </li>
            <li>
              <Link href="/legal/offer" className="underline">
                Публичная оферта
              </Link>
            </li>
          </ul>
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
