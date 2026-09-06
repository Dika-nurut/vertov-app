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
    // External provider page in a new tab; re-check + history stay.
    expect(RETURN_SOURCE).toContain('target="_blank"');
    expect(RETURN_SOURCE).toContain('Проверить снова');
    expect(RETURN_SOURCE).toContain('История платежей');
  });
});
