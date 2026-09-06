'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TokenStar } from '@/components/ui/token-star';

export const PAYMENT_RESULT_STORAGE_KEY = 'seed:payment-result';

type PaymentResult = {
  kind: 'pack' | 'subscription' | 'upgrade';
  amountRub: number;
  credits: number;
  orderId: string;
  createdAt: number;
};

function readResult(): PaymentResult | null {
  try {
    const raw = window.sessionStorage.getItem(PAYMENT_RESULT_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PaymentResult>;
    if (
      !value ||
      !['pack', 'subscription', 'upgrade'].includes(String(value.kind)) ||
      typeof value.amountRub !== 'number' ||
      typeof value.credits !== 'number' ||
      typeof value.orderId !== 'string' ||
      typeof value.createdAt !== 'number' ||
      Date.now() - value.createdAt > 15 * 60 * 1000
    ) {
      window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY);
      return null;
    }
    return value as PaymentResult;
  } catch {
    return null;
  }
}

function fmt(value: number): string {
  return value.toLocaleString('ru-RU');
}

/**
 * One-shot payment result card shown after the PSP redirects back. The return
 * route stores the result and routes to the user's useful context; this
 * component consumes it once so a refresh never replays the popup.
 */
export function PaymentResultToast() {
  const router = useRouter();
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const next = readResult();
    if (next) {
      setResult(next);
      setOpen(true);
    }
  }, []);

  function dismiss() {
    try {
      window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY);
    } catch {
      // Ignore storage failures; closing the dialog is still deterministic.
    }
    setOpen(false);
    setResult(null);
  }

  if (!result) return null;
  const isPack = result.kind === 'pack';
  const isSubscription = result.kind === 'subscription';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
        else setOpen(true);
      }}
    >
      <DialogContent
        data-testid="payment-result-dialog"
        className="max-w-[460px] gap-5 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-6 shadow-[5px_5px_0_0_var(--color-accent)]"
      >
        <DialogHeader>
          <DialogTitle className="font-display text-[22px] font-black uppercase leading-[1.1]">
            {isPack ? 'Пакет оплачен' : isSubscription ? 'Подписка активна' : 'План обновлён'}
          </DialogTitle>
        </DialogHeader>
        <div className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-4 py-4">
          <p className="font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-muted-foreground)]">
            Токены зачислены
          </p>
          <p className="mt-2 flex items-center gap-2 font-display text-[30px] font-black text-[color:var(--color-positive)]">
            <TokenStar size={20} />+{fmt(result.credits)}
          </p>
          <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
            Сумма: {fmt(result.amountRub)} ₽ · платёж подтверждён Точкой.
          </p>
        </div>
        <p className="text-sm leading-[1.5] text-[color:var(--color-muted-foreground)]">
          {isPack
            ? 'Пакетные токены не сгорают. Окно пакетов уже открыто — можно выбрать следующий или закрыть карточку.'
            : 'Доступ к выбранному плану включён. Можно сразу перейти к генерации.'}
        </p>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            data-testid="payment-result-primary"
            onClick={() => {
              if (isPack) {
                dismiss();
              } else {
                dismiss();
                router.push('/generate');
              }
            }}
            className="press border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-line)]"
          >
            {isPack ? 'К пакетам' : 'Начать генерировать'}
          </button>
          <button
            type="button"
            data-testid="payment-result-dismiss"
            onClick={dismiss}
            className="border-[2.5px] border-[color:var(--color-line)] px-4 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-muted-foreground)]"
          >
            Закрыть
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
