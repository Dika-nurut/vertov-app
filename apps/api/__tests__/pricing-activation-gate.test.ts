import { describe, expect, it } from 'vitest';
import {
  evaluatePricePointActivation,
  UNDELIVERABLE_ON_ROUTE,
  type ActivationInput,
} from '../src/pricing-activation-gate';

const base: ActivationInput = {
  active: true,
  force: false,
  modelId: 'seedance-2-0',
  resolution: '720p',
  routedFamily: 'openrouter',
  hasCanonicalPrice: true,
  hasCostData: true,
  // Above the signed 25% primary floor. It was 0.235 until 2026-08-11, when this suite
  // was the evidence that the endpoint enforced break-even instead of the floor.
  margin: 0.31,
  floorRub: 0.3311,
  fallback: null,
};

describe('evaluatePricePointActivation — the price-point money gate', () => {
  it('allows a healthy activation (positive margin, deliverable, not forced)', () => {
    expect(evaluatePricePointActivation(base)).toBeNull();
  });

  it('DEACTIVATION is always allowed, even for an otherwise-blocked row', () => {
    expect(
      evaluatePricePointActivation({ ...base, active: false, hasCostData: false, margin: null }),
    ).toBeNull();
    expect(
      evaluatePricePointActivation({
        ...base,
        active: false,
        modelId: 'veo-3-1',
        resolution: '1080p',
      }),
    ).toBeNull();
  });

  it('BLOCKS a below-break-even activation (409 below_break_even)', () => {
    const block = evaluatePricePointActivation({ ...base, margin: -0.087 });
    expect(block?.status).toBe(409);
    expect(block?.error).toBe('below_break_even');
  });

  /**
   * The panel is the only path that writes margin policy into a live database, and it
   * was the only path not enforcing the policy: it refused a LOSS and waved through a
   * profitable-but-thin row. CI cannot cover for it — the catalogue guardrail reads the
   * seed file, so a row activated at 23.5% in production is invisible there.
   */
  it('BLOCKS a thin-but-profitable primary activation at the signed 25% floor', () => {
    const block = evaluatePricePointActivation({ ...base, margin: 0.235 });
    expect(block?.status).toBe(409);
    expect(block?.error).toBe('below_margin_floor');
    // The operator must be told which decision they are making: this row earns money.
    expect(block?.reason).toContain('23.5%');
    expect(block?.reason).not.toContain('lose money');
  });

  it('lets a reserve leg stand at break-even — R-1 floors the fallback at ZERO', () => {
    // Refusing to fail over converts a vendor outage into ours, so a thin reserve is
    // deliberate. Only a loss on the reserve is refused.
    const thin = {
      ...base,
      fallback: { gateway: 'kie', hasCostData: true, margin: 0.004 },
    };
    expect(evaluatePricePointActivation(thin)).toBeNull();
    const losing = {
      ...base,
      fallback: { gateway: 'kie', hasCostData: true, margin: -0.02 },
    };
    expect(evaluatePricePointActivation(losing)?.error).toBe('below_break_even');
  });

  it('BLOCKS an unverifiable-COGS activation (409 margin_unverifiable)', () => {
    for (const missing of [
      { hasCostData: false, margin: null },
      { hasCostData: true, margin: null },
    ]) {
      const block = evaluatePricePointActivation({ ...base, ...missing });
      expect(block?.error).toBe('margin_unverifiable');
    }
  });

  it('BLOCKS an edited, non-SSOT price row before it can be approved on borrowed economics', () => {
    const block = evaluatePricePointActivation({ ...base, hasCanonicalPrice: false });
    expect(block?.status).toBe(409);
    expect(block?.error).toBe('price_not_ssot');
  });

  it('BLOCKS a fallback that is below break-even or has unverified COGS', () => {
    const below = evaluatePricePointActivation({
      ...base,
      fallback: { gateway: 'openrouter', hasCostData: true, margin: -0.087 },
    });
    expect(below?.error).toBe('below_break_even');

    const unverified = evaluatePricePointActivation({
      ...base,
      fallback: { gateway: 'kie', hasCostData: false, margin: null },
    });
    expect(unverified?.error).toBe('margin_unverifiable');
  });

  it('BLOCKS an undeliverable config before the margin check (409 undeliverable_config)', () => {
    // veo 4K is positive-margin on kie but the adapter cannot deliver it (no
    // get-4k-video wiring, no 4K price row).
    const block = evaluatePricePointActivation({
      ...base,
      modelId: 'veo-3-1',
      resolution: '4K',
      routedFamily: 'direct',
      margin: 0.598,
    });
    expect(block?.error).toBe('undeliverable_config');
    // Deliverable veo resolutions (720p inline, 1080p via the two-step) are allowed.
    for (const resolution of ['720p', '1080p']) {
      expect(
        evaluatePricePointActivation({
          ...base,
          modelId: 'veo-3-1',
          resolution,
          routedFamily: 'direct',
          margin: 0.598,
        }),
      ).toBeNull();
    }
  });

  it('BLOCKS seedance 4K, which is deliverable but only on the vendor we do not route to', () => {
    // Unlike veo 4K, the adapter could render this. Finance signs 4K to kie at 25.0%;
    // the model row routes to OpenRouter, which is right for the 1080p it sells and a
    // 3.5% loss at 4K. The margin check cannot save us here — with no exact 4K cost it
    // reads the frozen 1080p reference and reports a healthy margin from another rung —
    // so a generous `margin` is passed deliberately to prove the block lands first.
    for (const modelId of ['seedance-2-0', 'seedance-2-0-reference-to-video']) {
      expect(
        evaluatePricePointActivation({ ...base, modelId, resolution: '4K', margin: 0.741 })?.error,
        `${modelId} 4K must not activate onto the OpenRouter route`,
      ).toBe('undeliverable_config');
    }
    // The rungs seedance actually sells stay activatable.
    for (const resolution of ['480p', '720p', '1080p']) {
      expect(
        evaluatePricePointActivation({
          ...base,
          modelId: 'seedance-2-0',
          resolution,
          margin: 0.25,
        }),
      ).toBeNull();
    }
  });

  it('force bypasses every block (audit-logged by the caller)', () => {
    expect(evaluatePricePointActivation({ ...base, force: true, margin: -0.087 })).toBeNull();
    expect(
      evaluatePricePointActivation({ ...base, force: true, hasCostData: false, margin: null }),
    ).toBeNull();
    expect(
      evaluatePricePointActivation({
        ...base,
        force: true,
        modelId: 'veo-3-1',
        resolution: '4K',
      }),
    ).toBeNull();
    expect(
      evaluatePricePointActivation({
        ...base,
        force: true,
        fallback: { gateway: 'openrouter', hasCostData: true, margin: -0.087 },
      }),
    ).toBeNull();
  });

  it('the undeliverable denylist covers exactly veo 4K (grok + veo 720p/1080p are fine)', () => {
    expect(UNDELIVERABLE_ON_ROUTE['veo-3-1']).toEqual(['4K']);
    expect(UNDELIVERABLE_ON_ROUTE['grok-imagine-video']).toBeUndefined();
    expect(
      evaluatePricePointActivation({
        ...base,
        modelId: 'grok-imagine-video',
        resolution: '720p',
        routedFamily: 'direct',
        margin: 0.453,
      }),
    ).toBeNull();
  });
});
