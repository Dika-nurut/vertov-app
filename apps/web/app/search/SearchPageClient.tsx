'use client';

import Link from 'next/link';
import { SearchPanel } from '@/components/search/SearchPanel';

export function SearchPageClient({
  apiUrl,
  initialQuery,
  initialPage,
  initialProjectId,
}: {
  apiUrl: string;
  initialQuery: string;
  initialPage: number;
  initialProjectId?: string | undefined;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8 md:py-14">
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-accent-tint)]">
            Среда · общий индекс
          </p>
          <h1 className="mt-2 font-display text-4xl font-black tracking-tight md:text-6xl">
            Найти всё
          </h1>
        </div>
        <Link
          href="/workspace"
          className="hidden border-2 border-[color:var(--color-line)] px-4 py-2 font-mono text-[10px] font-bold uppercase md:block"
        >
          ← В Среду
        </Link>
      </div>
      <SearchPanel
        apiUrl={apiUrl}
        initialQuery={initialQuery}
        initialPage={initialPage}
        projectId={initialProjectId}
        syncUrl
        autoFocus
      />
    </div>
  );
}
