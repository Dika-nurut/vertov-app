import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@/components/ui/wordmark';
import { Suspense } from 'react';
import { LegalPageContent } from '../_components/LegalPage';
import { LanguageToggle } from '../_components/LanguageToggle';
import { SupportLink } from '../_components/SupportLink';
import { LandingFooter } from '../_components/landing/LandingFooter';
import { serializeJsonLd } from '@/lib/json-ld';

const faqEntries = [
  ['Что такое Vertov?', 'Vertov — сервис генерации изображений и видео с помощью ИИ.'],
  ['Как начать?', 'Зарегистрируйтесь, получите стартовые токены и опишите сцену.'],
  [
    'Что такое токены?',
    'Токены — внутренняя валюта Vertov. Стоимость зависит от модели и параметров генерации.',
  ],
  [
    'Где хранятся мои изображения?',
    'Результаты хранятся в приватной галерее, пока вы сами не опубликуете их.',
  ],
  ['Как связаться с поддержкой?', 'Напишите на support@vertov.space. Ответим за 5 рабочих дней.'],
] as const;

export const metadata: Metadata = {
  title: 'FAQ — Vertov',
  description: 'Частые вопросы о Vertov: генерация видео и изображений, токены, подписки, права.',
  alternates: { canonical: '/faq' },
};
export const dynamic = 'force-dynamic';

export default async function FaqPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd({
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: faqEntries.map(([name, text]) => ({
                '@type': 'Question',
                name,
                acceptedAnswer: { '@type': 'Answer', text },
              })),
            }),
          }}
        />
        {/* Macro panel grammar (bible §3): surface + bone 2.5px + 6px periwinkle
            offset — the editorial content reads as one slab, like pricing plates. */}
        <div
          className="brutal-card px-6 py-7 sm:px-8"
          style={{ boxShadow: '6px 6px 0 0 var(--color-shadow)' }}
        >
          <LegalPageContent page="faq" searchParams={searchParams} />
          <p className="mt-6 text-[13px] text-[color:var(--color-muted-foreground)]">
            Не нашли ответ? Напишите в поддержку:
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
        </div>
      </main>
      <LandingFooter />
    </div>
  );
}
