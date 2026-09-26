'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { TokenStar } from '@/components/ui/token-star';
import { formatUtcDate, planBlockNotice, type PlanAccessBlock } from '@/lib/plan-block';
import { tierLabel, type Tier } from '@/lib/tier-label';
import { ErrorState } from '../../_components/states/ErrorState';

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

/** UTC DD.MM.YYYY — SSR and hydration cannot cross a day boundary. */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return formatUtcDate(iso, true);
}

/** Order statuses in Russian, same voice as JobsTray. */
const HISTORY_STATUS_LABEL: Record<string, string> = {
  paid: 'Оплачен',
  pending: 'Ожидает',
  failed: 'Отклонён',
  refunded: 'Возврат',
  partially_refunded: 'Частичный возврат',
};

/** Friendly pack names for the breakdown (credit_packs seed titles) — a raw
 *  packId (pack-s, …) must never render as user-facing copy. */
const PACK_TITLES: Record<string, string> = {
  'pack-s': 'S',
  'pack-m': 'M',
  'pack-l': 'L',
  'pack-xl': 'XL',
  'pack-xxl': 'XXL',
  'pack-200': 'Стартовый',
  'pack-1000': 'Стандарт',
  'pack-5000': 'Студия',
};

function packTitle(packId: string): string {
  const known = PACK_TITLES[packId];
  return known ? `Пакет «${known}»` : 'Пакет';
}

/** Failed payment → support with the order id already in the subject. */
function supportHref(orderId: string): string {
  return `mailto:support@vertov.space?subject=${encodeURIComponent(`Платёж ${orderId}`)}`;
}

/**
 * Full-card outage fallback: at least one billing fetch failed, so rendering
 * zeros would lie. Client-side so the retry can refresh the server render.
 */
export function BillingLoadError() {
  const router = useRouter();
  return (
    <ErrorState
      message="Не удалось загрузить данные биллинга. Попробуйте обновить страницу."
      onRetry={() => router.refresh()}
    />
  );
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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  // Elapsed period: the only honest primary is a resubscribe link — the
  // destructive close is demoted to «Закрыть» behind a confirm modal.
  const elapsed = notice?.offersResubscribe === true;

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
      // Always drop the modal so the result (refreshed card or error banner)
      // is visible instead of hiding behind the overlay.
      setConfirmCancel(false);
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
            {notice.tone === 'ended' && planAccessBlock && (
              <p
                data-testid="plan-ended-badge"
                className="mt-2 inline-block border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
              >
                Закончилась {formatDate(planAccessBlock.currentPeriodEnd)}
              </p>
            )}
            <p className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]">
              {notice.body}
            </p>
            {notice.recoveryHint && (
              <p className="mt-1.5 text-sm text-[color:var(--color-muted-foreground)]">
                {notice.recoveryHint}
              </p>
            )}
            {notice.recoveryOrderId && (
              <a
                data-testid="resume-payment-link"
                href={`/billing/return?orderId=${encodeURIComponent(notice.recoveryOrderId)}`}
                className="mt-2 inline-block font-bold text-[color:var(--color-accent)] underline underline-offset-2"
              >
                Продолжить оплату
              </a>
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
            {/* Cancel is always confirm-guarded (modal below states the
                effective date + token fate). Elapsed: primary is the
                resubscribe link, destructive close demoted to «Закрыть». */}
            <div className="flex flex-wrap items-center gap-2">
              {elapsed ? (
                <>
                  <a
                    href="/pricing"
                    data-testid="resubscribe-button"
                    className="press border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
                  >
                    Оформить заново
                  </a>
                  <button
                    type="button"
                    data-testid="cancel-button"
                    disabled={busy}
                    onClick={() => setConfirmCancel(true)}
                    className="press border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-60"
                  >
                    Закрыть
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="cancel-button"
                  disabled={busy}
                  onClick={() => setConfirmCancel(true)}
                  // Neutral even for a declined card — nothing may steer a
                  // customer whose subscription is still alive into cancelling.
                  className="press border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-1.5 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-60"
                >
                  Отменить
                </button>
              )}
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

        {/* Cancel confirm — states the effective date + token fate, mirroring
            the downgrade modal in PricingClient (scheduled, never instant). */}
        {confirmCancel && subscription && (
          <div
            data-testid="cancel-confirm"
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: 'color-mix(in srgb, var(--color-bg) 72%, transparent)' }}
            onClick={() => setConfirmCancel(false)}
          >
            <div
              className="w-full max-w-[440px] border-[2.5px] border-[color:var(--color-line)] p-6 shadow-[7px_7px_0_0_var(--color-accent)]"
              style={{ background: 'var(--color-card)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="font-display text-[20px] font-black uppercase leading-[1.1]">
                {elapsed ? 'Закрыть подписку?' : 'Отменить подписку?'}
              </h3>
              <p className="mt-3 text-[13px] leading-[1.5] text-[color:var(--color-muted-foreground)]">
                {elapsed ? (
                  <>
                    Оплаченный период закончился {formatDate(subscription.currentPeriodEnd)}. Токены
                    подписки уже недоступны, пакеты без срока действия сохраняются. Закрытие уберёт
                    подписку из списка.
                  </>
                ) : (
                  <>
                    Подписка закончится {formatDate(subscription.currentPeriodEnd)} — до этой даты
                    токены и уровень сохраняются. Возврат за текущий период не производится.
                  </>
                )}
              </p>
              <div className="mt-5 flex gap-2.5">
                <button
                  type="button"
                  data-testid="cancel-confirm-dismiss"
                  onClick={() => setConfirmCancel(false)}
                  className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em]"
                  style={{ background: 'var(--color-surface2)', color: 'var(--color-fg)' }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  data-testid="cancel-confirm-submit"
                  disabled={busy}
                  onClick={() => void cancel()}
                  className="press flex-1 border-[2.5px] border-[color:var(--color-line)] py-3 font-mono text-[13px] font-bold uppercase tracking-[0.1em] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-60"
                  style={{
                    background: 'var(--color-destructive)',
                    color: 'var(--color-destructive-foreground)',
                  }}
                >
                  {busy ? 'Ждите…' : 'Подтвердить'}
                </button>
              </div>
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
                    <td className="py-2 text-right text-xs">
                      {HISTORY_STATUS_LABEL[row.status] ?? row.status}
                    </td>
                    <td className="py-2 text-right">
                      {row.status === 'paid' ? (
                        <a
                          data-testid="invoice-link"
                          href={`${apiUrl}/v1/billing/invoice/${row.id}.pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-bold text-[color:var(--color-accent)] underline underline-offset-2"
                        >
                          PDF
                        </a>
                      ) : row.status === 'pending' ? (
                        <a
                          data-testid="resume-payment-link"
                          href={`/billing/return?orderId=${encodeURIComponent(row.id)}`}
                          className="font-bold text-[color:var(--color-accent)] underline underline-offset-2"
                        >
                          Продолжить оплату
                        </a>
                      ) : row.status === 'failed' ? (
                        <span className="inline-flex flex-col items-end gap-1">
                          <a
                            data-testid="resume-payment-link"
                            href={`/billing/return?orderId=${encodeURIComponent(row.id)}`}
                            className="font-bold text-[color:var(--color-accent)] underline underline-offset-2"
                          >
                            Продолжить оплату
                          </a>
                          <a
                            data-testid="support-link"
                            href={supportHref(row.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs font-bold text-[color:var(--color-muted-foreground)] underline underline-offset-2"
                          >
                            Поддержка
                          </a>
                        </span>
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
                {packTitle(p.packId)} от {formatDate(p.grantedAt)}
              </span>
              <span>{p.amount.toLocaleString('ru-RU')} (бессрочно)</span>
            </li>
          ))}
          {breakdown.pending > 0 && (
            <li className="flex justify-between">
              <span>В обработке</span>
              <span>{breakdown.pending.toLocaleString('ru-RU')}</span>
            </li>
          )}
          <li className="flex justify-between border-t-2 border-[color:var(--color-line)] pt-2">
            <span>Возвраты</span>
            <span>{breakdown.refund.toLocaleString('ru-RU')}</span>
          </li>
        </ul>
      </section>
    </div>
  );
}
