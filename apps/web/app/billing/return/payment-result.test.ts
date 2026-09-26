import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RETURN_SOURCE = readFileSync(join(__dirname, 'ReturnClient.tsx'), 'utf8');
const TOAST_SOURCE = readFileSync(
  join(__dirname, '../../_components/PaymentResultToast.tsx'),
  'utf8',
);
const SHELL_SOURCE = readFileSync(join(__dirname, '../../_components/AppShell.tsx'), 'utf8');
const PRICING_PAGE_SOURCE = readFileSync(join(__dirname, '../../pricing/page.tsx'), 'utf8');
const PRICING_CLIENT_SOURCE = readFileSync(
  join(__dirname, '../../pricing/PricingClient.tsx'),
  'utf8',
);

describe('payment return UX wiring', () => {
  it('routes paid packs back to the pack chooser and subscriptions home', () => {
    expect(RETURN_SOURCE).toContain(
      "router.replace(body.kind === 'pack' ? '/pricing?packs=1' : '/')",
    );
    expect(RETURN_SOURCE).toContain('PAYMENT_RESULT_STORAGE_KEY');
    expect(RETURN_SOURCE).toContain('body.amountRub');
  });

  it('mounts a one-shot result card in the authenticated shell', () => {
    expect(SHELL_SOURCE).toContain('<PaymentResultToast />');
    expect(TOAST_SOURCE).toContain('window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY)');
    expect(TOAST_SOURCE).toContain('data-testid="payment-result-dialog"');
    expect(TOAST_SOURCE).toContain('Начать генерировать');
  });

  it('opens the pack modal from the return destination', () => {
    expect(PRICING_PAGE_SOURCE).toContain("initialPacksOpen={pageParams.packs === '1'}");
    expect(PRICING_CLIENT_SOURCE).toContain('useState(Boolean(initialPacksOpen))');
  });

  it('routes a 409 checkout_in_progress to the return page with a resume button', () => {
    // Dead-end copy replaced: the button carries the live orderId to the
    // return page, which now holds the same payment link.
    expect(PRICING_CLIENT_SOURCE).toContain('Продолжить оплату');
    expect(PRICING_CLIENT_SOURCE).toContain('resume-payment-link');
    expect(PRICING_CLIENT_SOURCE).toContain('/billing/return?orderId=');
    // No-double-charge reassurance + analytics stay as-is.
    expect(PRICING_CLIENT_SOURCE).toContain('не списать деньги дважды');
    expect(PRICING_CLIENT_SOURCE).toContain("reason: 'in_progress'");
  });

  it('offers the same-payment resume link on the pending return card', () => {
    expect(RETURN_SOURCE).toContain('Продолжить оплату');
    expect(RETURN_SOURCE).toContain('resume-payment-button');
    expect(RETURN_SOURCE).toContain('resumeUrl');
    // WS2 same-tab: the resume anchor itself carries no new-tab target;
    // no-double-charge reassurance + re-check + history + tariffs stay.
    const resumePart =
      RETURN_SOURCE.split('data-testid="resume-payment-button"')[1]?.slice(0, 300) ?? '';
    expect(resumePart, 'resume button must stay same-tab').not.toContain('target="_blank"');
    expect(RETURN_SOURCE).toContain('повторное списание исключено');
    expect(RETURN_SOURCE).toContain('Проверить снова');
    expect(RETURN_SOURCE).toContain('К тарифам');
    expect(RETURN_SOURCE).toContain('История платежей');
  });
});

describe('resume-payment follow-through (WS2)', () => {
  const RETURN_PAGE_SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

  it('consumes the one-shot slot on read so a reload never replays the popup', () => {
    // readResult drops the key immediately after a successful parse and
    // keeps only the in-memory copy; corrupt slots are dropped too.
    const readBlock = TOAST_SOURCE.split('function readResult')[1]?.split('function fmt')[0] ?? '';
    expect(readBlock).toContain('window.sessionStorage.removeItem(PAYMENT_RESULT_STORAGE_KEY)');
    expect(TOAST_SOURCE).toContain('consume-on-read');
    expect(TOAST_SOURCE).toContain('setResult(next)');
  });

  it('never stacks the result card over the packs chooser (sequence, then focus)', () => {
    expect(TOAST_SOURCE).toContain('packs-modal');
    expect(TOAST_SOURCE).toContain('packsModalNode');
    expect(TOAST_SOURCE).toContain('focusFirstPackAction');
    expect(TOAST_SOURCE).toContain('backToPacks');
    // Pack primary hands back to the chooser; subscription primary generates.
    expect(TOAST_SOURCE).toContain('К пакетам');
    expect(TOAST_SOURCE).toContain("router.push('/pricing?packs=1')");
    expect(TOAST_SOURCE).toContain("router.push('/generate')");
  });

  it('keeps the paid fallback contextual (packs vs generation)', () => {
    expect(RETURN_SOURCE).toContain('К пакетам');
    expect(RETURN_SOURCE).toContain("'/pricing?packs=1'");
    expect(RETURN_SOURCE).toContain('Начать генерировать');
    expect(RETURN_SOURCE).toContain('paidKind');
  });

  it('gives the error state retry (when orderId) + tariffs + history', () => {
    expect(RETURN_SOURCE).toContain("status === 'error'");
    expect(RETURN_SOURCE).toContain('canRetry');
    expect(RETURN_SOURCE).toContain('Проверить снова');
    expect(RETURN_SOURCE).toContain('К тарифам');
    expect(RETURN_SOURCE).toContain('href="/pricing"');
    expect(RETURN_SOURCE).toContain('История платежей');
  });

  it('gates forceSuccess to non-prod on both return layers', () => {
    expect(RETURN_SOURCE).toContain("process.env.NODE_ENV !== 'production'");
    expect(RETURN_PAGE_SOURCE).toContain("process.env.NODE_ENV !== 'production'");
    expect(RETURN_PAGE_SOURCE).toContain("forceSuccess === '1'");
  });
});
