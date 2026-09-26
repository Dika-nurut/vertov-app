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
    // WS2 consume-on-read: drop the slot immediately so a reload never
    // replays the popup. The caller keeps the in-memory copy even if storage
    // becomes unavailable while the slot is being consumed.
    try {
      window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY);
    } catch {
      // The parsed result is still safe to show once in memory.
    }
    return value as PaymentResult;
  } catch {
    try {
      window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY);
    } catch {
      // Ignore storage failures; a corrupt slot must still not replay.
    }
    return null;
  }
}

function fmt(value: number): string {
  return value.toLocaleString('ru-RU');
}

/** Packs chooser presence probe — the toast must never sit open on top of it. */
function packsModalNode(): Element | null {
  try {
    return document.querySelector('[data-testid="packs-modal"]');
  } catch {
    return null;
  }
}

function focusFirstPackAction(): boolean {
  try {
    const target =
      document.querySelector('[data-testid="packs-modal"] [data-testid="buy-button"]') ??
      document.querySelector('[data-testid="mode-packs"]');
    if (target instanceof HTMLElement && !target.hasAttribute('disabled')) {
      target.focus();
      return true;
    }
  } catch {
    // Focus is best-effort; the packs chooser is already usable by pointer.
  }
  return false;
}

/** Route transitions can mount the pricing modal after this shell component. */
function focusFirstPackActionWhenReady(): void {
  let attempts = 0;
  const focus = () => {
    if (focusFirstPackAction() || attempts++ >= 30) return;
    window.setTimeout(focus, 100);
  };
  focus();
}

/**
 * One-shot payment result card shown after the PSP redirects back. The return
 * route stores the result and routes to the user's useful context; this
 * component consumes it once so a refresh never replays the popup.
 *
 * WS2 sequencing: the card never renders open on top of the packs chooser.
 * A pack result arriving while `packs-modal` is mounted stays in memory and
 * opens once the chooser closes; «К пакетам» dismisses first, then ensures
 * the chooser is open and focuses its first action.
 */
export function PaymentResultToast() {
  const router = useRouter();
  const [result, setResult] = useState<PaymentResult | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const next = readResult();
    if (!next) return;
    // In-memory copy survives the consumed storage slot.
    setResult(next);
    // Non-pack results open at once. Pack results wait out an open chooser
    // so the two dialogs never stack.
    if (next.kind !== 'pack' || !packsModalNode()) {
      setOpen(true);
      return;
    }
    const timer = window.setInterval(() => {
      if (!packsModalNode()) {
        window.clearInterval(timer);
        setOpen(true);
      }
    }, 250);
    return () => window.clearInterval(timer);
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

  /** WS2 sequence: close this card, then hand the viewer back to the packs
   *  chooser with keyboard focus on its first action. */
  function backToPacks() {
    dismiss();
    try {
      if (packsModalNode()) {
        focusFirstPackAction();
        return;
      }
      const trigger = document.querySelector('[data-testid="mode-packs"]');
      if (
        trigger instanceof HTMLElement &&
        !trigger.hasAttribute('disabled') &&
        trigger.getAttribute('aria-disabled') !== 'true'
      ) {
        trigger.click();
        focusFirstPackActionWhenReady();
        return;
      }
    } catch {
      // Fall through to the packs route below.
    }
    router.push('/pricing?packs=1');
    focusFirstPackActionWhenReady();
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
            ? 'Пакетные токены не сгорают. Откройте пакеты, чтобы выбрать следующий, или закройте карточку.'
            : 'Доступ к выбранному плану включён. Можно сразу перейти к генерации.'}
        </p>
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            data-testid="payment-result-primary"
            onClick={() => {
              if (isPack) {
                backToPacks();
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
