'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { invalidateBalance } from '../../_components/BalanceWidget';
import { creditBucket, trackEvent, PlausibleEvent } from '../../_components/PlausibleEvents';
import { PAYMENT_RESULT_STORAGE_KEY } from '../../_components/PaymentResultToast';

type Status =
  | 'polling'
  | 'paid'
  | 'pending'
  | 'failed'
  | 'partially_refunded'
  | 'refunded'
  | 'error';

export function ReturnClient({
  orderId,
  forceSuccess,
  apiUrl,
}: {
  orderId: string | null;
  forceSuccess: boolean;
  apiUrl: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('polling');
  const [credits, setCredits] = useState<number>(0);
  // WS2: paid fallback keeps its kind so the inline card stays contextual
  // (pack buyers go back to packs, subscriptions to generation).
  const [paidKind, setPaidKind] = useState<'pack' | 'subscription' | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Same-payment resume link from the return API (bounced Tochka form stays
  // pending with a live confirmation page). Shown only while pending.
  const [resumeUrl, setResumeUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasOrderId(orderId)) {
      setStatus('error');
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams({ orderId: orderId! });
    // WS2: the stub-only success shortcut must never reach prod — page.tsx
    // already strips it server-side; this keeps stray client props harmless
    // while e2e (non-prod) keeps working.
    if (forceSuccess && process.env.NODE_ENV !== 'production') params.set('forceSuccess', '1');
    async function poll() {
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`${apiUrl}/v1/billing/return?${params.toString()}`, {
            credentials: 'include',
            // A hung request must not freeze the bounded poll on «Проверяем
            // оплату…» — bound each attempt so the loop keeps advancing.
            signal: AbortSignal.timeout(10_000),
          });
          if (cancelled) return;
          if (!res.ok) {
            setStatus('error');
            return;
          }
          const body = (await res.json()) as {
            kind: 'pack' | 'subscription';
            amountRub: number;
            status: 'pending' | 'paid' | 'failed' | 'partially_refunded' | 'refunded';
            creditsGranted: number;
            resumeUrl?: string | null;
          };
          if (body.status === 'paid') {
            // The provider return → /v1/billing/return applies the grant inline.
            // Tell the header widget to re-fetch so the new balance shows
            // up immediately, no full reload required.
            invalidateBalance();
            trackEvent(PlausibleEvent.checkoutCompleted, {
              credits: creditBucket(body.creditsGranted),
            });
            // The PSP always returns to this route, but the useful context is
            // where checkout started: packs reopen the pack chooser, while a
            // subscription lands on the authenticated home. Store a one-shot
            // result so the destination can render a real success card.
            try {
              window.sessionStorage.setItem(
                PAYMENT_RESULT_STORAGE_KEY,
                JSON.stringify({
                  kind: body.kind,
                  amountRub: body.amountRub,
                  credits: body.creditsGranted,
                  orderId,
                  createdAt: Date.now(),
                }),
              );
            } catch {
              // Storage can be disabled; the inline fallback below still
              // gives the user a useful result instead of failing the return.
              setPaidKind(body.kind);
              setStatus('paid');
              setCredits(body.creditsGranted);
              return;
            }
            router.replace(body.kind === 'pack' ? '/pricing?packs=1' : '/');
            return;
          }
          if (
            body.status === 'failed' ||
            body.status === 'partially_refunded' ||
            body.status === 'refunded'
          ) {
            setStatus(body.status);
            trackEvent(
              body.status === 'partially_refunded' || body.status === 'refunded'
                ? PlausibleEvent.checkoutRefunded
                : PlausibleEvent.checkoutFailed,
              { status: body.status },
            );
            return;
          }
          // Still pending — remember the resume link for the pending card.
          if (typeof body.resumeUrl === 'string' && body.resumeUrl.length > 0) {
            setResumeUrl(body.resumeUrl);
          }
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled) return;
      }
      setStatus('pending');
    }
    void poll();
    return () => {
      cancelled = true;
    };
  }, [orderId, forceSuccess, apiUrl, router, attempt]);

  if (status === 'paid') {
    // WS2 contextual fallback (storage disabled): pack buyers return to the
    // packs chooser, subscriptions go straight to generation.
    const packFallback = paidKind === 'pack';
    return (
      <div className="mt-6 space-y-4">
        <p data-testid="return-message" className="text-lg">
          Токены зачислены:{' '}
          <b className="font-display text-[color:var(--color-positive)]">+{credits}</b>
        </p>
        <Link
          href={packFallback ? '/pricing?packs=1' : '/generate'}
          className="press inline-flex items-center border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
        >
          {packFallback ? 'К пакетам' : 'Начать генерировать'}
        </Link>
      </div>
    );
  }
  if (status === 'polling') {
    return (
      <p
        className="mt-6 text-sm text-[color:var(--color-muted-foreground)]"
        data-testid="return-message"
      >
        Проверяем оплату…
      </p>
    );
  }
  if (status === 'pending') {
    return (
      <div className="mt-6 space-y-3">
        <p
          className="text-sm text-[color:var(--color-muted-foreground)]"
          data-testid="return-message"
        >
          Оплата ещё не подтверждена банком. Обновите страницу через минуту.
        </p>
        {resumeUrl && (
          <div>
            <a
              data-testid="resume-payment-button"
              href={resumeUrl}
              className="press inline-flex items-center border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
            >
              Продолжить оплату
            </a>
            <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
              Продолжите оплату — повторное списание исключено.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setStatus('polling');
              setAttempt((n) => n + 1);
            }}
            className="press inline-flex items-center border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-2 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            Проверить снова
          </button>
          <Link href="/pricing" className="text-sm font-semibold underline">
            К тарифам
          </Link>
          <Link href="/settings/billing" className="text-sm font-semibold underline">
            История платежей
          </Link>
        </div>
      </div>
    );
  }
  // WS2: every terminal state offers a way forward. `error` (fetch failed
  // or missing order) retries only when an orderId exists to re-check,
  // plus tariff + history links. Failed/refunded rows explain the outcome
  // and route to tariffs + history instead of dead-ending.
  const canRetry = hasOrderId(orderId);
  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-destructive" data-testid="return-message">
        {status === 'failed'
          ? 'Платёж отменён.'
          : status === 'partially_refunded'
            ? 'Частичный возврат проведён. Оставшаяся часть покупки сохраняется.'
            : status === 'refunded'
              ? 'Возврат проведён.'
              : 'Не удалось проверить статус.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {status === 'error' && canRetry && (
          <button
            type="button"
            onClick={() => {
              setStatus('polling');
              setAttempt((n) => n + 1);
            }}
            className="press inline-flex items-center border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-2 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            Проверить снова
          </button>
        )}
        <Link href="/pricing" className="text-sm font-semibold underline">
          К тарифам
        </Link>
        <Link href="/settings/billing" className="text-sm font-semibold underline">
          История платежей
        </Link>
      </div>
    </div>
  );
}

function hasOrderId(orderId: string | null): boolean {
  return Boolean(orderId);
}
