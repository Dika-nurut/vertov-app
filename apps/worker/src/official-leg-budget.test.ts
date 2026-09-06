import { describe, expect, it } from 'vitest';
import { officialLegInvoiceOf } from './official-leg-budget';

/**
 * What may replace a reservation, and what must not.
 *
 * `capabilities.officialUsdPerUnit` is ONE observed charge copied by hand and
 * never re-checked, so a real `usage.cost` is worth having. But settlement
 * REPLACES the reservation with it, so an invoice that is not the whole bill for
 * this leg's own submit is worse than no invoice at all.
 */
describe('the invoice a settlement may be priced at', () => {
  it('takes a complete cost the official leg reported', () => {
    expect(
      officialLegInvoiceOf({
        servedBy: 'openrouter-official',
        providerCostUsd: 0.241344,
        providerCostComplete: true,
      }),
    ).toEqual({ providerCostUsd: 0.241344, costNote: null });
  });

  it('refuses a fan-out cost that priced only some of its calls', () => {
    // One image's bill would otherwise replace a four-image reservation, and the
    // row would then book the revenue of all four — which can read as profit and
    // free the whole cap.
    expect(
      officialLegInvoiceOf({
        servedBy: 'openrouter-official',
        providerCostUsd: 0.241344,
        providerCostComplete: false,
      }),
    ).toEqual({ providerCostUsd: null, costNote: 'partial_invoice' });
  });

  it('treats a missing completeness claim as not complete', () => {
    // Absence is not consent: a caller that never asserted the sum is the whole
    // bill has not told us it is.
    expect(
      officialLegInvoiceOf({ servedBy: 'openrouter-official', providerCostUsd: 0.241344 }),
    ).toEqual({ providerCostUsd: null, costNote: 'partial_invoice' });
  });

  it('refuses a cost another leg reported for the same job', () => {
    // A job can reserve on the official leg, fail retryably, and then succeed on
    // a relay that came back. That relay's bill prices a different vendor's work.
    expect(
      officialLegInvoiceOf({
        servedBy: 'laozhang',
        providerCostUsd: 0.09,
        providerCostComplete: true,
      }),
    ).toEqual({ providerCostUsd: null, costNote: 'no_invoice' });
  });

  it('refuses a zero or garbled figure rather than reading it as a free job', () => {
    // A 0 would silently zero out the reserved cost, turning a real loss into
    // no loss at all.
    const complete = { servedBy: 'openrouter-official', providerCostComplete: true };
    expect(officialLegInvoiceOf(undefined).providerCostUsd).toBeNull();
    expect(officialLegInvoiceOf({ ...complete, providerCostUsd: 0 }).providerCostUsd).toBeNull();
    expect(
      officialLegInvoiceOf({ ...complete, providerCostUsd: Number.NaN }).providerCostUsd,
    ).toBeNull();
    expect(
      officialLegInvoiceOf({ ...complete, providerCostUsd: '0.24' }).providerCostUsd,
    ).toBeNull();
  });
});
