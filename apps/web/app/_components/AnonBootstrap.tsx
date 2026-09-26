'use client';

import { useEffect, useState } from 'react';
import { CircleNotch as Loader2 } from '@phosphor-icons/react/dist/ssr';
import { rateLimitMessage, retryAfterSeconds } from '@/lib/rate-limit';

// The anon mint must never strand the visitor on a spinner: 10–15s, then fail
// over to login (with the context to come back).
const ANON_TIMEOUT_MS = 12_000;

/**
 * Silent, zero-form anonymous session mint for the pre-paywall browsing flow
 * (2026-07-07): a visitor with no session cookie at all lands on a gated
 * surface (middleware now lets them through instead of bouncing to /login),
 * the server page sees `me.data === null` and renders this instead of the
 * real client, which mints the Better Auth anonymous() session then reloads
 * the exact same URL — so query prefills (?prompt=, ?preset=…) survive
 * untouched, no ?next= bookkeeping needed for this leg.
 *
 * Failure still preserves context the other way: /login?next= carries the
 * exact path+query (?prompt=, ?preset=, ?model= survive the round-trip), so
 * the visitor lands back where they started after signing in.
 */
export function AnonBootstrap({ apiUrl }: { apiUrl: string }) {
  const [loginHref, setLoginHref] = useState('/login');
  const [limited, setLimited] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const loginWithContext = () => {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    };
    setLoginHref(
      `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`,
    );
    const timer = window.setTimeout(() => controller.abort(), ANON_TIMEOUT_MS);
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/api/auth/sign-in/anonymous`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: controller.signal,
        });
        if (!r.ok) {
          if (r.status === 429 && !cancelled) {
            // Specific 429 copy first, then fall through to login — a broken
            // anon endpoint must not strand the visitor.
            const retryAfter = r.headers.get('retry-after');
            setLimited(rateLimitMessage(retryAfter));
            const waitMs = Math.min((retryAfterSeconds(retryAfter) ?? 5) * 1000, 60_000);
            window.setTimeout(() => {
              if (!cancelled) loginWithContext();
            }, waitMs);
            return;
          }
          throw new Error(`HTTP ${r.status}`);
        }
      } catch {
        // Fall through to /login — anon signup is a nicety, not a hard
        // requirement; a broken anon endpoint must not strand the visitor.
        if (!cancelled) loginWithContext();
        return;
      } finally {
        window.clearTimeout(timer);
      }
      if (!cancelled) window.location.reload();
    })();
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [apiUrl]);

  if (limited) {
    return (
      <div className="grid min-h-screen place-items-center px-6">
        <div className="w-full max-w-sm border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-5 text-center shadow-[5px_5px_0_0_var(--color-shadow)]">
          <p role="alert" className="text-sm leading-snug text-[color:var(--color-fg)]">
            {limited}
          </p>
          <a
            href={loginHref}
            className="mt-3 inline-block font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)] underline decoration-[color:var(--color-line)] underline-offset-2 hover:text-[color:var(--color-accent)]"
          >
            Перейти ко входу
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center">
      <div
        role="status"
        className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]"
      >
        <Loader2 size={18} className="seed-spin" />
        Открываем…
      </div>
    </div>
  );
}
