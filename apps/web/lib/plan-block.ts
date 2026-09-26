/**
 * Copy for the state where a subscription row exists but no longer grants live
 * plan access. Both billing and pricing render this same cause; each page owns
 * only its local recovery action.
 */

export type PlanAccessBlockReason = 'period_ended' | 'payment_failed';

/** `planAccessBlock` from GET /v1/billing/subscription. */
export interface PlanAccessBlock {
  reason: PlanAccessBlockReason;
  subscriptionId: string;
  tier: string;
  currentPeriodEnd: string;
  /** WS2: latest failed/pending subscription order for «Продолжить оплату».
   *  Absent on `period_ended` and when no recoverable order exists. */
  orderId?: string | null;
}

export interface PlanBlockNotice {
  tone: 'ended' | 'declined';
  title: string;
  /** Location-neutral explanation of the account state. */
  body: string;
  /** Billing-only recovery copy. Null when the live subscription must not be cancelled. */
  recoveryHint: string | null;
  /** WS2: same-tab resume target for a declined card, when the API supplied
   *  a recoverable order. Billing renders «Продолжить оплату» from this;
   *  pricing keeps its location-neutral «Управлять подпиской». */
  recoveryOrderId?: string | null;
  /** Whether cancelling + subscribing again is the recovery path for this state. */
  offersResubscribe: boolean;
}

/** Format an API timestamp in UTC so SSR and hydration cannot cross a day boundary. */
export function formatUtcDate(iso: string, includeYear = false): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        ...(includeYear ? { year: 'numeric' } : {}),
        timeZone: 'UTC',
      });
}

export function planBlockNotice(block: PlanAccessBlock | null): PlanBlockNotice | null {
  if (!block) return null;
  if (block.reason === 'payment_failed') {
    const recoveryOrderId =
      typeof block.orderId === 'string' && block.orderId.length > 0 ? block.orderId : null;
    return {
      tone: 'declined',
      title: 'Платёж не прошёл',
      body: 'Банк отклонил оплату подписки, поэтому доступ к платным моделям приостановлен. Подписка при этом не закрыта. Напишите в поддержку — поможем провести оплату и вернуть доступ.',
      recoveryHint: recoveryOrderId
        ? 'Продолжите оплату по кнопке ниже — повторное списание исключено. Если платёж не проходит, напишите в поддержку.'
        : null,
      recoveryOrderId,
      offersResubscribe: false,
    };
  }
  return {
    tone: 'ended',
    title: 'Подписка закончилась',
    body: `Оплаченный период закончился ${formatUtcDate(block.currentPeriodEnd, true)}, поэтому платные модели недоступны.`,
    // The dead row is closed with «Закрыть», never «Отменить чтобы купить
    // заново»: resubscribe is a plain link to /pricing (BillingClient owns it).
    recoveryHint:
      'Нажмите «Закрыть» ниже, чтобы убрать подписку из списка. Новый тариф можно оформить на странице тарифов.',
    offersResubscribe: true,
  };
}
