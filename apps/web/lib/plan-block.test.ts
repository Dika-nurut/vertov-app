import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatUtcDate, planBlockNotice } from './plan-block';

describe('planBlockNotice', () => {
  const periodEnded = {
    reason: 'period_ended' as const,
    subscriptionId: 'sub_1',
    tier: 'start',
    currentPeriodEnd: '2026-07-01T00:30:00.000Z',
  };
  const paymentFailed = { ...periodEnded, reason: 'payment_failed' as const, tier: 'plus' };

  it('renders nothing while the plan is live', () => {
    expect(planBlockNotice(null)).toBeNull();
  });

  it('keeps the ended-period cause location-neutral and puts billing recovery in its hint', () => {
    const notice = planBlockNotice(periodEnded);
    expect(notice?.tone).toBe('ended');
    expect(notice?.title).toBe('Подписка закончилась');
    expect(notice?.body).toContain('01.07.2026');
    expect(notice?.body).not.toContain('Отменить');
    expect(notice?.recoveryHint).toContain('Отменить');
    expect(notice?.offersResubscribe).toBe(true);
  });

  it('never offers cancel or re-subscribe as the fix for a declined card', () => {
    const notice = planBlockNotice(paymentFailed)!;
    expect(notice.tone).toBe('declined');
    expect(notice.recoveryHint).toBeNull();
    expect(notice.offersResubscribe).toBe(false);
    const words = `${notice.title} ${notice.body}`;
    for (const forbidden of ['Отменить', 'отмен', 'заново', 'закончил', 'Выбрать тариф']) {
      expect(words, `declined-card copy must not say «${forbidden}»`).not.toContain(forbidden);
    }
    expect(notice.body).toContain('поддержк');
  });
});

describe('formatUtcDate', () => {
  it('formats a DD.MM date in UTC regardless of the process timezone', () => {
    expect(formatUtcDate('2026-07-01T00:30:00.000Z')).toBe('01.07');
  });
});

describe('shared plan-block wiring', () => {
  const APP = join(__dirname, '../app');
  const read = (file: string) => readFileSync(join(APP, file), 'utf8');

  it('billing renders the shared explanation and its page-specific recovery hint', () => {
    const client = read('settings/billing/BillingClient.tsx');
    expect(client).toContain("from '@/lib/plan-block'");
    expect(client).toContain('{notice.body}');
    expect(client).toContain('{notice.recoveryHint}');
    expect(client).not.toContain("=== 'payment_failed'");
  });

  it('pricing consumes the same notice and sends a blocked subscription to billing', () => {
    const client = read('pricing/PricingClient.tsx');
    expect(client).toContain("from '@/lib/plan-block'");
    expect(client).toContain('const planNotice = planBlockNotice(planAccessBlock);');
    expect(client).toContain("router.push('/settings/billing')");
    expect(client).toContain('data-testid="plan-access-block"');
  });
});
