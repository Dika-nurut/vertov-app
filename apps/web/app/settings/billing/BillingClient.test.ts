import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// WS1 billing-honesty wiring, source-string pattern like
// app/billing/return/payment-result.test.ts (no jsdom in this repo).
const CLIENT = readFileSync(join(__dirname, 'BillingClient.tsx'), 'utf8');
const PAGE = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

describe('billing honesty (WS1)', () => {
  it('gates the whole card on ANY fetch failing, never zeros as truth', () => {
    expect(PAGE).toContain('breakdownFailed');
    expect(PAGE).toContain('subscriptionFailed');
    expect(PAGE).toContain('balanceFailed');
    expect(PAGE).toContain(
      'const billingFailed = balanceFailed || historyFailed || breakdownFailed || subscriptionFailed;',
    );
    expect(PAGE).toContain('{billingFailed ?');
    expect(PAGE).toContain('<BillingLoadError />');
  });

  it('retries the outage through router.refresh(), always with onRetry', () => {
    expect(CLIENT).toContain("from '../../_components/states/ErrorState'");
    expect(CLIENT).toContain('onRetry={() => router.refresh()}');
  });

  it('labels history statuses in Russian', () => {
    for (const label of ['Оплачен', 'Ожидает', 'Отклонён', 'Возврат']) {
      expect(CLIENT, `missing RU status «${label}»`).toContain(label);
    }
    expect(CLIENT).toContain('HISTORY_STATUS_LABEL[row.status]');
  });

  it('opens invoices in a new tab and recovers failed/pending rows', () => {
    expect(CLIENT).toContain('data-testid="invoice-link"');
    expect(CLIENT).toContain('target="_blank"');
    expect(CLIENT).toContain('noreferrer');
    expect(CLIENT).toContain('data-testid="resume-payment-link"');
    expect(CLIENT).toContain('/billing/return?orderId=');
    expect(CLIENT).toContain('Продолжить оплату');
    expect(CLIENT).toContain('data-testid="support-link"');
    expect(CLIENT).toContain('mailto:support@vertov.space?subject=');
  });

  it('guards cancel behind a confirm modal with date + token fate', () => {
    expect(CLIENT).toContain('data-testid="cancel-confirm"');
    expect(CLIENT).toContain('data-testid="cancel-confirm-submit"');
    expect(CLIENT).toContain('data-testid="cancel-confirm-dismiss"');
    expect(CLIENT).toContain('Подписка закончится');
    expect(CLIENT).toContain('токены и уровень сохраняются');
    // One-tap cancel is gone: both cancel buttons open the modal, and only
    // the modal submit calls cancel().
    expect(CLIENT).toContain('onClick={() => setConfirmCancel(true)}');
    expect(CLIENT).toContain('data-testid="cancel-confirm-submit"');
    expect(CLIENT).not.toContain('cancel stays one-tap');
  });

  it('reads elapsed as «Закончилась DD.MM.YYYY» + resubscribe primary, close demoted', () => {
    expect(CLIENT).toContain('data-testid="plan-ended-badge"');
    expect(CLIENT).toContain('Закончилась');
    expect(CLIENT).toContain('data-testid="resubscribe-button"');
    expect(CLIENT).toContain('Оформить заново');
    expect(CLIENT).toContain('href="/pricing"');
  });

  it('renders pending only when non-zero and never a raw packId', () => {
    expect(CLIENT).toContain('breakdown.pending > 0');
    expect(CLIENT).toContain('В обработке');
    expect(CLIENT).toContain('PACK_TITLES');
    expect(CLIENT).toContain('Пакет «');
    expect(CLIENT).toContain('(бессрочно)');
    expect(CLIENT).not.toContain('{p.packId} от');
  });

  it('formats every date DD.MM.YYYY in UTC', () => {
    expect(CLIENT).toContain('formatUtcDate(iso, true)');
    expect(CLIENT).not.toContain('toLocaleDateString');
  });
});

describe('resume-payment follow-through (WS2)', () => {
  it('links failed AND pending rows same-tab to the return page, support kept', () => {
    // Both recoverable statuses route through the same return page.
    const resumeHits = CLIENT.split('data-testid="resume-payment-link"').length - 1;
    expect(resumeHits, 'pending + failed + declined-notice resume links').toBeGreaterThanOrEqual(3);
    expect(CLIENT).toContain("row.status === 'failed'");
    expect(CLIENT).toContain("row.status === 'pending'");
    expect(CLIENT).toContain('/billing/return?orderId=');
    // WS1 support affordance survives as the failed-row secondary.
    expect(CLIENT).toContain('data-testid="support-link"');
    expect(CLIENT).toContain('mailto:support@vertov.space?subject=');
  });

  it('keeps every resume link same-tab (new tabs stay invoice + support only)', () => {
    // Slice each resume link anchor and assert no new-tab target inside it.
    const parts = CLIENT.split('data-testid="resume-payment-link"').slice(1);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      const anchor = part.slice(0, 400);
      expect(anchor, 'resume link must stay same-tab').not.toContain('target="_blank"');
    }
    // Invoices (PDF) and the support mailto are the only new-tab links left.
    expect(CLIENT).toContain('data-testid="invoice-link"');
  });

  it('renders the declined-card recovery link from plan-block orderId', () => {
    expect(CLIENT).toContain('notice.recoveryOrderId');
    expect(CLIENT).toContain('notice.recoveryHint');
    expect(CLIENT).toContain('encodeURIComponent(notice.recoveryOrderId)');
    expect(CLIENT).toContain('Продолжить оплату');
  });
});
