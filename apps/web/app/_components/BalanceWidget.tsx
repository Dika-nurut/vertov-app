'use client';

import { useCallback, useEffect, useState } from 'react';
import { TokenStar } from '@/components/ui/token-star';

export const BALANCE_INVALIDATE_EVENT = 'balance:invalidate';

/**
 * Live-refreshing credit balance. Re-fetches on:
 *   - window focus (covers `back-from-checkout` / multi-tab)
 *   - a `balance:invalidate` custom event dispatched after any action known
 *     to mutate the ledger (job submit, billing return, dev grant)
 *
 * Extracted from the old BalanceWidget popover (2026-07-07 header redesign):
 * top-up now lives in ProfileMenu's plan card, so this is just the number —
 * both the header's credits cell and ProfileMenu call this hook independently
 * rather than one polling and prop-drilling to the other.
 */
export function useBalance(initial: number, apiUrl: string): number {
  const [balance, setBalance] = useState<number>(initial);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/credits/balance`, { credentials: 'include' });
      if (!res.ok) {
        console.warn('useBalance: refresh failed', res.status);
        return;
      }
      const body = (await res.json()) as { available?: number };
      if (typeof body.available === 'number') setBalance(body.available);
    } catch (err) {
      // Stale balance is preferable to a thrown error here, but a
      // silent failure mode is worse — surface it for operators.
      console.warn('useBalance: refresh threw', err);
    }
  }, [apiUrl]);

  useEffect(() => {
    function onFocus() {
      void refresh();
    }
    function onInvalidate() {
      void refresh();
    }
    window.addEventListener('focus', onFocus);
    window.addEventListener(BALANCE_INVALIDATE_EVENT, onInvalidate);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(BALANCE_INVALIDATE_EVENT, onInvalidate);
    };
  }, [refresh]);

  return balance;
}

/**
 * The header's credits display — a plain segment cell (no popover: top-up
 * lives in ProfileMenu now). `className` carries the shared fused-segment
 * cell styling from the caller so this stays a pure display component.
 */
export function BalanceWidget({
  initial,
  apiUrl,
  className,
}: {
  initial: number;
  apiUrl: string;
  className?: string;
}) {
  const balance = useBalance(initial, apiUrl);
  return (
    <span
      data-testid="balance-widget"
      title={`Баланс ${balance.toLocaleString('ru-RU')} токенов`}
      className={className}
    >
      <TokenStar size={12} className="text-[color:var(--color-fg)]" />
      <b
        data-testid="balance-value"
        className="tnum text-[13px] font-bold text-[color:var(--color-fg)]"
      >
        {balance.toLocaleString('ru-RU')}
      </b>
    </span>
  );
}

/**
 * Tiny helper so callers don't have to remember the event name. Safe in
 * SSR (no-op when window is missing).
 */
export function invalidateBalance(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BALANCE_INVALIDATE_EVENT));
}
