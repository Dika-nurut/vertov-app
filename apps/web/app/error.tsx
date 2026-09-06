'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { SupportLink } from './_components/SupportLink';

/**
 * Per-route error boundary. Next 15 surfaces unhandled exceptions thrown
 * during render or in client components inside the matching segment here.
 * Keep the page intentionally minimal — the user sees a single RU sentence
 * and a button that triggers Next's reset() to re-attempt the route.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('route error boundary caught:', error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <p className="text-label text-[color:var(--color-destructive)]">
        Ошибка 500 · Что-то сломалось
      </p>
      <h1 className="text-h1 text-[color:var(--color-fg)]">Что-то пошло не так</h1>
      <p className="max-w-md text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
        Мы уже разбираемся. Попробуйте обновить страницу — если ошибка повторится, напишите в
        <SupportLink
          href={`mailto:support@vertov.space?subject=Vertov+issue${error.digest ? `&body=Error+ID:+${encodeURIComponent(error.digest)}` : ''}`}
          className="underline underline-offset-2"
        >
          поддержку
        </SupportLink>
        . Ответим в течение 5 рабочих дней.
      </p>
      <p className="max-w-md text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
        Токены за неудачную генерацию возвращаются автоматически.
      </p>
      {error.digest && (
        <p className="font-mono text-xs text-[color:var(--color-faint)]">
          ID ошибки: <code>{error.digest}</code>
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <button type="button" onClick={() => reset()} className="btn btn-primary">
          Обновить
        </button>
        <Link href="/" className="btn btn-ghost">
          На главную
        </Link>
      </div>
    </div>
  );
}
