'use client';

import { useEffect, useRef, useState } from 'react';
import { TokenStar } from '@/components/ui/token-star';

export const BALANCE_INVALIDATE_EVENT = 'balance:invalidate';

type BalanceSubscriber = (value: number) => void;
interface BalanceStore {
  value: number;
  inFlight: Promise<void> | null;
  requestVersion: number;
  subscribers: Set<BalanceSubscriber>;
}

// AppShell and ProfileMenu render the balance independently. Keeping one small
// browser-local store means a focus/invalidation event performs one request and
// updates both displays together.
const balanceStores = new Map<string, BalanceStore>();

function getBalanceStore(apiUrl: string, initial: number): BalanceStore {
  const existing = balanceStores.get(apiUrl);
  if (existing) return existing;
  const store: BalanceStore = {
    value: initial,
    inFlight: null,
    requestVersion: 0,
    subscribers: new Set(),
  };
  balanceStores.set(apiUrl, store);
  return store;
}

function publishBalance(store: BalanceStore, value: number): void {
  store.value = value;
  for (const subscriber of store.subscribers) subscriber(value);
}

function refreshBalance(apiUrl: string): Promise<void> {
  const store = getBalanceStore(apiUrl, 0);
  if (store.inFlight) return store.inFlight;
  const requestVersion = store.requestVersion;

  const request = (async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/credits/balance`, { credentials: 'include' });
      if (!res.ok) {
        console.warn('useBalance: refresh failed', res.status);
        return;
      }
      const body = (await res.json()) as { available?: number };
      if (requestVersion === store.requestVersion && typeof body.available === 'number') {
        publishBalance(store, body.available);
      }
    } catch (err) {
      // Stale balance is preferable to a thrown error here, but a silent
      // failure mode is worse — surface it for operators.
      console.warn('useBalance: refresh threw', err);
    }
  })();

  store.inFlight = request;
  void request.then(
    () => {
      if (store.inFlight === request) store.inFlight = null;
    },
    () => {
      if (store.inFlight === request) store.inFlight = null;
    },
  );
  return request;
}

/**
 * Live-refreshing credit balance. Re-fetches on:
 *   - window focus (covers `back-from-checkout` / multi-tab)
 *   - a `balance:invalidate` custom event dispatched after any action known
 *     to mutate the ledger (job submit, billing return, dev grant)
 *
 * Extracted from the old BalanceWidget popover (2026-07-07 header redesign):
 * top-up now lives in ProfileMenu's plan card, so this is just the number.
 */
export function useBalance(initial: number, apiUrl: string): number {
  // Do not initialize the browser store during the server render: a module
  // singleton must never carry one request's balance into another request.
  const [balance, setBalance] = useState<number>(initial);
  const previousInitial = useRef(initial);

  useEffect(() => {
    const store = getBalanceStore(apiUrl, initial);
    // A store can outlive a route transition. Reset it before the first
    // subscriber of a new surface so a previous account's balance cannot flash.
    if (store.subscribers.size === 0) {
      store.value = initial;
      store.requestVersion += 1;
      store.inFlight = null;
    }
    // Server props are authoritative when they actually change, while a
    // parent rerender with the same stale prop must not overwrite a live value.
    if (previousInitial.current !== initial) {
      publishBalance(store, initial);
      previousInitial.current = initial;
    }

    const onBalance = (value: number) => setBalance(value);
    store.subscribers.add(onBalance);
    onBalance(store.value);

    function onFocus() {
      void refreshBalance(apiUrl);
    }
    function onInvalidate() {
      void refreshBalance(apiUrl);
    }
    window.addEventListener('focus', onFocus);
    window.addEventListener(BALANCE_INVALIDATE_EVENT, onInvalidate);
    void refreshBalance(apiUrl);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(BALANCE_INVALIDATE_EVENT, onInvalidate);
      store.subscribers.delete(onBalance);
    };
  }, [apiUrl, initial]);

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
