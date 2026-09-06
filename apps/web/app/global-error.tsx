'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { SupportLink } from './_components/SupportLink';

/**
 * Top-level error boundary. Runs when the root layout itself throws — Next
 * cannot mount `app/layout.tsx`, so we must provide a self-contained
 * `<html>` + `<body>` here. Same RU copy as the per-route boundary.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('global error boundary caught:', error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ru">
      <body
        style={{
          /* Theme tokens (single source: app/globals.css @theme) — no hardcoded
             hex / system font stack here; the per-route boundary matches. */
          fontFamily: 'var(--font-sans)',
          minHeight: '100vh',
          margin: 0,
          background: 'var(--color-bg)',
          color: 'var(--color-fg)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ maxWidth: 480, padding: 24, textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, marginBottom: 12 }}>Что-то пошло не так</h1>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 16 }}>
            Попробуйте обновить страницу. Если ошибка повторится — напишите в{' '}
            <SupportLink href="mailto:support@vertov.space" style={{ color: 'inherit' }}>
              поддержку
            </SupportLink>
            . Ответим в течение 5 рабочих дней.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, opacity: 0.6, marginBottom: 16 }}>
              ID ошибки: <code>{error.digest}</code>
            </p>
          )}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              border: 'var(--border-w) solid var(--color-line)',
              background: 'var(--color-surface)',
              color: 'var(--color-fg)',
              padding: '8px 16px',
              borderRadius: 'var(--radius-md)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Обновить
          </button>
        </div>
      </body>
    </html>
  );
}
