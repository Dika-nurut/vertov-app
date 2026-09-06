'use client';

import { useEffect } from 'react';
import { CircleNotch as Loader2 } from '@phosphor-icons/react/dist/ssr';

/**
 * Silent, zero-form anonymous session mint for the pre-paywall browsing flow
 * (2026-07-07): a visitor with no session cookie at all lands on a gated
 * surface (middleware now lets them through instead of bouncing to /login),
 * the server page sees `me.data === null` and renders this instead of the
 * real client, which mints the Better Auth anonymous() session then reloads
 * the exact same URL — so query prefills (?prompt=, ?preset=…) survive
 * untouched, no ?next= bookkeeping needed for this leg.
 */
export function AnonBootstrap({ apiUrl }: { apiUrl: string }) {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${apiUrl}/api/auth/sign-in/anonymous`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      } catch {
        // Fall through to /login — anon signup is a nicety, not a hard
        // requirement; a broken anon endpoint must not strand the visitor.
        if (!cancelled) window.location.href = '/login';
        return;
      }
      if (!cancelled) window.location.reload();
    })();
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex items-center gap-2 font-mono text-[13px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
        <Loader2 size={18} className="seed-spin" />
        Открываем…
      </div>
    </div>
  );
}
