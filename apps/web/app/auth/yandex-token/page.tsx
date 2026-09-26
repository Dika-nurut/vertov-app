'use client';

import { useEffect, useState } from 'react';

/**
 * Yandex ID SUGGEST token page.
 *
 * `YaAuthSuggest` (response_type=token) redirects here with the access token in
 * the URL fragment; Yandex's token SDK reads it and postMessages it back to the
 * opener (our login page). This is the helper page Yandex requires — its URL must
 * be in the app's Redirect URI list. Never a blank tab: a status line is live
 * from the first paint, failures surface an error + a way back to /login.
 */
export default function YandexTokenPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The opener handshake should take a moment, not forever — surface the
    // escape hatch instead of stranding the visitor on a spinner.
    const timer = window.setTimeout(() => {
      if (!cancelled) setError('Вход через Яндекс затянулся. Попробуйте ещё раз.');
    }, 15_000);
    const s = document.createElement('script');
    s.src =
      'https://yastatic.net/s3/passport-sdk/autofill/v1/sdk-suggest-token-with-polyfills-latest.js';
    s.async = true;
    s.onload = () => {
      try {
        const send = (window as unknown as { YaSendSuggestToken?: (origin: string) => void })
          .YaSendSuggestToken;
        if (send) send(window.location.origin);
        else if (!cancelled) setError('Сервис Яндекса не ответил. Попробуйте ещё раз.');
      } catch {
        if (!cancelled) setError('Не удалось завершить вход через Яндекс.');
      }
    };
    s.onerror = () => {
      if (!cancelled) setError('Не удалось загрузить сервис Яндекса. Проверьте соединение.');
    };
    document.head.appendChild(s);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      s.onload = null;
      s.onerror = null;
      s.remove();
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <p
          role="status"
          className="text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]"
        >
          {error ?? 'Завершаем вход через Яндекс…'}
        </p>
        {error && (
          <p role="alert" className="mt-2 text-[13px] font-bold text-destructive">
            {error}
          </p>
        )}
        <a
          href="/login"
          className="mt-4 inline-block font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)]"
        >
          Вернуться ко входу
        </a>
      </div>
    </main>
  );
}
