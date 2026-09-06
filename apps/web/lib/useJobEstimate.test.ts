import { describe, expect, it } from 'vitest';
import { generationJobRequestSchema } from '@seed/shared/generation-request';
import {
  QUOTE_PLACEHOLDER_PROMPT,
  estimatePriceToShow,
  estimateRefusalFrom,
  hasKnownJobEstimate,
  pendingJobEstimate,
  recalculatingPriceToShow,
  canRequestJobEstimate,
} from './useJobEstimate';

/**
 * Phase 1.4 (pricing-correct-catalogue-build.md) — the client half of "a missing
 * price must be visible". `/v1/jobs/estimate` used to collapse every non-OK
 * response to `error: true`, and BOTH price surfaces then fell back to a locally
 * computed flat placeholder — so a configuration the server had explicitly
 * refused to quote still rendered a confident number on the Run button. That
 * placeholder was the legacy `creditCostPerUnit × units` rate: the exact
 * resolution-blind number the server just declined to charge.
 */
describe('estimateRefusalFrom — a refusal is not a network blip', () => {
  it('keeps the stable code and the RU message from a 400', () => {
    expect(estimateRefusalFrom(400, { error: 'price_unavailable', message: 'Нет цены' })).toEqual({
      code: 'price_unavailable',
      message: 'Нет цены',
    });
  });

  it('keeps the code when the server sent no message', () => {
    expect(estimateRefusalFrom(400, { error: 'config_not_available' })).toEqual({
      code: 'config_not_available',
      message: null,
    });
  });

  it('is NOT a refusal on a 5xx — the server said nothing about the price', () => {
    expect(estimateRefusalFrom(503, { error: 'upstream' })).toBeNull();
  });

  it('is NOT a refusal when the body has no code (unparseable / empty)', () => {
    expect(estimateRefusalFrom(400, null)).toBeNull();
    expect(estimateRefusalFrom(400, {})).toBeNull();
    expect(estimateRefusalFrom(400, { error: '' })).toBeNull();
  });
});

describe('estimatePriceToShow — one display rule for /generate and /boards', () => {
  const noQuote = { cost: null };

  it('prefers the authoritative server quote', () => {
    expect(estimatePriceToShow({ cost: 913 })).toBe(913);
  });

  it('shows nothing while the server quote is absent', () => {
    expect(estimatePriceToShow(noQuote)).toBeNull();
  });

  it('shows nothing once the server refused', () => {
    expect(estimatePriceToShow({ cost: null })).toBeNull();
  });
});

describe('quote-gated actions', () => {
  const quoted = {
    cost: 913,
    units: 1,
    loading: false,
    error: false,
    refusal: null,
    previousCost: null,
  };

  it.each([
    ['loading', { ...quoted, cost: null, loading: true }],
    ['transport error / timeout', { ...quoted, cost: null, error: true }],
    [
      'server refusal',
      { ...quoted, cost: null, refusal: { code: 'price_unavailable', message: null } },
    ],
  ])('blocks the action while the quote is %s', (_state, estimate) => {
    expect(hasKnownJobEstimate(estimate)).toBe(false);
  });

  it('clears a previous price immediately when a price-relevant parameter changes', () => {
    // This is the state useJobEstimate installs before its debounce for the new
    // params; the old 913-credit quote must not render or keep the action enabled.
    const requoting = pendingJobEstimate();

    expect(estimatePriceToShow(requoting)).toBeNull();
    expect(hasKnownJobEstimate(requoting)).toBe(false);
    expect(hasKnownJobEstimate(quoted)).toBe(true);
  });
});

/**
 * Blanking the number on every parameter click made a working price look broken.
 * The outgoing figure now stays on screen greyed while the new one is counted —
 * but it is NOT the price of the current configuration, so it must never become
 * the displayed price or re-enable the action.
 */
describe('the greyed number shown while a fresh quote is counted', () => {
  const quoted = {
    cost: 913,
    units: 1,
    loading: false,
    error: false,
    refusal: null,
    previousCost: null,
  };

  it('is offered for display while the new quote is in flight', () => {
    const requoting = pendingJobEstimate(913);

    expect(recalculatingPriceToShow(requoting)).toBe(913);
  });

  it('is still not the price, and still cannot be acted on', () => {
    const requoting = pendingJobEstimate(913);

    expect(estimatePriceToShow(requoting)).toBeNull();
    expect(hasKnownJobEstimate(requoting)).toBe(false);
  });

  it('yields to the settled quote the moment one arrives', () => {
    expect(recalculatingPriceToShow(quoted)).toBeNull();
  });

  it('is absent on the first quote, so nothing is invented', () => {
    expect(recalculatingPriceToShow(pendingJobEstimate())).toBeNull();
  });

  it('does not survive a refusal — a stale number must not outlive a rejection', () => {
    const refused = {
      ...quoted,
      cost: null,
      error: true,
      refusal: { code: 'price_unavailable', message: null },
    };

    expect(recalculatingPriceToShow(refused)).toBeNull();
  });
});

describe('quote eligibility', () => {
  it('quotes a Boards-shaped empty-prompt request once model and settings are ready', () => {
    expect(
      canRequestJobEstimate({
        enabled: true,
        modelId: 'seedream-4-5',
        prompt: '',
        requiresPrompt: false,
      }),
    ).toBe(true);
  });

  it('keeps the empty-prompt gate by default', () => {
    expect(
      canRequestJobEstimate({
        enabled: true,
        modelId: 'seedream-4-5',
        prompt: '',
      }),
    ).toBe(false);
  });
});

/**
 * /generate quotes before the user types anything, so the button carries a real
 * number the moment a model is picked instead of a dash. That only works while the
 * stand-in prompt still satisfies the server's request schema — if someone shortens
 * it to '', every quote turns into a 400 and the price silently becomes a dash again.
 */
describe('the placeholder prompt used to quote before typing', () => {
  it('satisfies the same schema the estimate endpoint validates against', () => {
    const parsed = generationJobRequestSchema.safeParse({
      modelId: 'seedream-4-5',
      prompt: QUOTE_PLACEHOLDER_PROMPT,
      params: { resolution: '2K' },
    });

    expect(parsed.success).toBe(true);
  });
});
