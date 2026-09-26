'use client';

/**
 * BetaPaymentBanner — W4.Fri.
 *
 * Shown on /pricing when YOOKASSA_SHOP_ID is not set (stub/beta mode).
 * Tells users payment is coming soon and captures their email so the
 * founder can notify them when it opens.
 *
 * 152-ФЗ: email is stored in users_pii.email via POST /v1/me/beta-email-capture.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function BetaPaymentBanner({ apiUrl }: { apiUrl: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setState('loading');
    try {
      const res = await fetch(`${apiUrl}/v1/me/beta-email-capture`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setState('done');
      } else {
        setState('error');
      }
    } catch {
      setState('error');
    }
  }

  // Kept (not deleted): Tochka is live behind BILLING_PROVIDER=tochka, but the
  // default provider is still yookassa and beta mode (no YOOKASSA_SHOP_ID) is
  // reachable — see page.tsx isBetaPaymentMode. So the banner stays, as a
  // brutal card in tokens like every other pricing slab (WS6).
  return (
    <div
      data-testid="beta-payment-banner"
      className="mb-8 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-6 text-[13px] shadow-[5px_5px_0_0_var(--color-shadow)]"
    >
      <p className="font-semibold text-[color:var(--color-accent)]">
        Бета: оплата откроется через несколько дней — мы напишем
      </p>
      <p className="mt-1 text-[color:var(--color-muted-foreground)]">
        Укажите почту, и мы сразу сообщим, когда оплата заработает.
      </p>

      {state === 'done' ? (
        <p className="mt-3 font-medium text-positive">
          Готово. Мы напишем вам, как только оплата откроется.
        </p>
      ) : (
        <form onSubmit={(e) => void submit(e)} className="mt-3 flex gap-2">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="pochta@example.com"
            required
            disabled={state === 'loading'}
            className="flex-1"
          />
          <Button type="submit" disabled={state === 'loading' || !email} className="shrink-0">
            {state === 'loading' ? 'Отправляем…' : 'Уведомить меня'}
          </Button>
        </form>
      )}

      {state === 'error' && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          Не удалось сохранить. Попробуйте ещё раз.
        </p>
      )}
    </div>
  );
}
