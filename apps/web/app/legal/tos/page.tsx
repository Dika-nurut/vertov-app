import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  alternates: { canonical: '/legal/tos' },
};
import { Wordmark } from '@/components/ui/wordmark';
import { Suspense } from 'react';
import { LegalPageContent } from '../../_components/LegalPage';
import { LanguageToggle } from '../../_components/LanguageToggle';
import { LandingFooter } from '../../_components/landing/LandingFooter';

export default async function TosPage({
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
        <LegalPageContent page="tos" searchParams={searchParams} />
      </main>
      <LandingFooter />
    </div>
  );
}
