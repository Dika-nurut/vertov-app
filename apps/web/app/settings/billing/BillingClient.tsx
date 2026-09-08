'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TokenStar } from '@/components/ui/token-star';
import { planBlockNotice, type PlanAccessBlock } from '@/lib/plan-block';
import { tierLabel, type Tier } from '@/lib/tier-label';

export interface Subscription {
  id: string;
  tier: Tier;
  title?: string | null;
  status: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  autoRenew: boolean;
  priceRub: number;
  creditsPerCycle: number;
  cycleNumber: number;
}

export interface HistoryRow {
  id: string;
  kind: 'pack' | 'subscription';
  amountRub: number;
  status: string;
  paidAt: string | null;
  createdAt: string;
  title: string;
  purpose: string | null;
}

export interface Breakdown {
  subscriptionGrant: { amount: number; expiresAt: string | null };
  packGrant: {
    packId: string;
    amount: number;
    grantedAt: string | null;
    expiresAt: string | null;
  }[];
  pending: number;
  refund: number;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU');
  } catch {
    return iso;
  }
}

export function BillingClient({
  subscription,
  planAccessBlock = null,
  history,
  breakdown,
  apiUrl,
}: {
  subscription: Subscription | null;
  /** Why this subscription no longer entitles any model, when it doesn't
   *  (W0/D6.2). The locked-model upsell routes here precisely to read it. */
  planAccessBlock?: PlanAccessBlock | null;
  history: HistoryRow[];
  breakdown: Breakdown;
  apiUrl: string;
}) {
  const router = useRouter();
  // The cause comes from the server, never from re-reading `status` here: after
  // W3 a declined card and an ended period look alike on this page and need
  // opposite advice.
  const notice = planBlockNotice(planAccessBlock);
  const [busy, setBusy] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setBillingError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/billing/cancel-subscription`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error ?? `Ошибка ${res.status}`;
        setBillingError(`Не удалось отменить подписку: ${msg}`);
        return;
      }
      router.refresh();
    } catch {
      setBillingError('Сетевая ошибка при отмене подписки. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleAutoRenew(next: boolean) {
    setBusy(true);
    setBillingError(null);
    try {
      const res = await fetch(`${apiUrl}/v1/billing/renew-toggle`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRenew: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = (body as { error?: string }).error ?? `Ошибка ${res.status}`;
        setBillingError(`Не удалось изменить авторенью: ${msg}`);
        return;
      }
      router.refresh();
    } catch {
      setBillingError('Сетевая ошибка при изменении авторенью. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 grid gap-6">
      {billingError && (
        <div
          data-testid="billing-error"
          className="rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-destructive)] bg-[rgba(var(--destructive-rgb),0.14)] px-4 py-3 text-sm font-bold text-destructive"
        >
          {billingError}
        </div>
      )}
      <section
        data-testid="subscription-card"
        className="rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-5 shadow-[var(--shadow-card)]"
      >
        <h2 className="font-display text-lg font-extrabold uppercase tracking-tight">Подписка</h2>
        {notice && (
          <div
            data-testid="plan-access-block"
            className={
              notice.tone === 'declined'
                ? 'mt-3 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-destructive)] bg-[rgba(var(--destructive-rgb),0.14)] px-4 py-3'
                : 'mt-3 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-accent)] bg-[color:var(--color-surface2)] px-4 py-3'
            }
          >
            <p className="font-display text-sm font-black uppercase tracking-tight">
              {notice.title}
            </p>
            <p className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]">
              {notice.body}
            </p>
            {notice.recoveryHint && (
              <p className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]">
                {notice.recoveryHint}
              </p>
            )}
          </div>
        )}
        {!subscription ? (
          <p className="mt-3 text-sm text-[color:var(--color-muted-foreground)]">
            Активной подписки нет.{' '}
            <a
              href="/pricing"
              className="font-bold text-[color:var(--color-accent)] underline underline-offset-2"
            >
              Выбрать тариф
            </a>
          </p>
        ) : (
          <div className="mt-3 space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-base font-medium">
                  {tierLabel(subscription.tier, subscription.title)}
                </div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  Период: {formatDate(subscription.currentPeriodStart)} —{' '}
                  {formatDate(subscription.currentPeriodEnd)} (цикл {subscription.cycleNumber})
                </div>
              </div>
              <div className="text-right">
                <div className="text-base font-semibold">
                  {subscription.priceRub.toLocaleString('ru-RU')} ₽/мес
                </div>
                <div className="text-xs text-[color:var(--color-muted-foreground)]">
                  <TokenStar size={11} /> {subscription.creditsPerCycle.toLocaleString('ru-RU')}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="cancel-button"
                disabled={busy}
                onClick={() => void cancel()}
                // Emphasised ONLY when closing this subscription is genuinely the
                // way back (an ended period). For a declined card the control
                // stays available but neutral — nothing may steer a customer
                // whose subscription is still alive into cancelling it.
                className={`press border-[2.5px] border-[color:var(--color-line)] px-3 py-1.5 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-60 ${
                  notice?.offersResubscribe
                    ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                    : 'bg-[color:var(--color-surface)]'
                }`}
              >
                Отменить
              </button>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="autorenew-checkbox"
                  checked={subscription.autoRenew}
                  onChange={(e) => void toggleAutoRenew(e.target.checked)}
                  className="seed-check"
                />
                Продлевать автоматически
              </label>
            </div>
          </div>
        )}
      </section>

      <section
        data-testid="history-card"
        className="rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-5 shadow-[var(--shadow-card)]"
      >
        <h2 className="font-display text-lg font-extrabold uppercase tracking-tight">
          История платежей
        </h2>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Номер каждой покупки указан под её названием. Для оплаты или возврата скопируйте номер из
          строки с нужной датой и суммой.
        </p>
        {history.length === 0 ? (
          <p className="mt-3 text-sm text-[color:var(--color-muted-foreground)]">
            Платежей ещё не было.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)]">
                <tr className="border-b-[2.5px] border-[color:var(--color-line)]">
                  <th className="py-2">Дата</th>
                  <th className="py-2">Описание</th>
                  <th className="py-2 text-right">Сумма</th>
                  <th className="py-2 text-right">Статус</th>
                  <th className="py-2 text-right">Счёт</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr
                    key={row.id}
                    data-testid="history-row"
                    data-order-id={row.id}
                    className="border-b-[2.5px] border-[color:var(--color-line-soft)] transition-colors last:border-0 hover:bg-[color:var(--color-surface2)]"
                  >
                    <td className="py-2 tnum">{formatDate(row.paidAt ?? row.createdAt)}</td>
                    <td className="py-2">
                      <div>{row.title}</div>
                      <div className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
                        Номер заказа:{' '}
                        <code
                          data-testid="history-order-id"
                          className="select-all break-all font-mono text-[color:var(--color-fg)]"
                        >
                          {row.id}
                        </code>
                      </div>
                    </td>
                    <td className="tnum py-2 text-right">
                      {row.amountRub.toLocaleString('ru-RU')} ₽
                    </td>
                    <td className="py-2 text-right text-xs">{row.status}</td>
                    <td className="py-2 text-right">
                      {row.status === 'paid' ? (
                        <a
                          data-testid="invoice-link"
                          href={`${apiUrl}/v1/billing/invoice/${row.id}.pdf`}
                          className="font-bold text-[color:var(--color-accent)] underline underline-offset-2"
                        >
                          PDF
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        data-testid="breakdown-card"
        className="rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] p-5 shadow-[var(--shadow-card)]"
      >
        <h2 className="font-display text-lg font-extrabold uppercase tracking-tight">
          Баланс по сроку
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li className="flex justify-between">
            <span>Подписка</span>
            <span>
              {breakdown.subscriptionGrant.amount.toLocaleString('ru-RU')} (сгорят{' '}
              {formatDate(breakdown.subscriptionGrant.expiresAt)})
            </span>
          </li>
          {breakdown.packGrant.map((p, i) => (
            <li key={`${p.packId}-${i}`} className="flex justify-between">
              <span>
                {p.packId} от {formatDate(p.grantedAt)}
              </span>
              <span>{p.amount.toLocaleString('ru-RU')} (бессрочно)</span>
            </li>
          ))}
          <li className="flex justify-between border-t-2 border-[color:var(--color-line)] pt-2">
            <span>Возвраты</span>
            <span>{breakdown.refund.toLocaleString('ru-RU')}</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
