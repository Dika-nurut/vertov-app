import Link from 'next/link';
import type { Metadata } from 'next';
import { Wordmark } from '@/components/ui/wordmark';
import { Suspense } from 'react';
import { LegalPageContent } from '../../_components/LegalPage';
import { LanguageToggle } from '../../_components/LanguageToggle';
import { SupportLink } from '../../_components/SupportLink';
import { LandingFooter } from '../../_components/landing/LandingFooter';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { alternates: { canonical: '/legal/requisites' } };

export default async function RequisitesPage({
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
        <LegalPageContent page="requisites" searchParams={searchParams} />
        <p className="mt-4 text-sm text-[color:var(--color-muted-foreground)]">
          Поддержка пользователей:
          <SupportLink
            href="/support"
            className="font-bold text-[color:var(--color-accent)] underline"
          >
            форма поддержки
          </SupportLink>
          . Ответим в течение 5 рабочих дней.
        </p>
      </main>
      <LandingFooter />
    </div>
  );
}
