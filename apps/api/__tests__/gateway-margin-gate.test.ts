import { describe, expect, it } from 'vitest';
import { PRICE_POINT_SEED } from '@seed/db/seed/price-points';
import { costCatalogue, creditFloorRub, type BreakEvenModel } from '@seed/db';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import {
  enumerateExecutableLegs,
  inspectGatewayChange,
  v2Routes,
  type GatewayMarginIssue,
} from '../src/gateway-margin-gate';

const floorRub = creditFloorRub(seedSubscriptionTiers);

const pointFor = (modelId: string, resolution: string, mode?: string) => {
  const point = PRICE_POINT_SEED.find(
    (candidate) =>
      candidate.modelId === modelId && candidate.resolution === resolution && candidate.isActive,
  );
  if (!point) throw new Error(`missing active price point ${modelId} @ ${resolution}`);
  return {
    modelId: point.modelId,
    resolution: point.resolution,
    videoInput: point.videoInput,
    audio: point.audio,
    unitKind: point.unitKind,
    baseCredits: point.baseCredits,
    baseUnits: point.baseUnits,
    // Carried through even though no rung used here is flat: the production route
    // passes the whole DB row, and a flat row costed per-second reads too profitable
    // (`packages/db/src/price-breakeven.ts`, `flatRate`). A helper that drops the
    // field would hide that on the day a Veo rung is added to one of these cases.
    flatRate: point.flatRate,
    sourceRef: point.sourceRef,
    ...(mode === undefined ? {} : { mode }),
  };
};

const model = (over: Partial<BreakEvenModel> & { id: string }): BreakEvenModel => ({
  gatewayOverride: null,
  fallbackGateway: null,
  providerModelId: over.id,
  capabilities: {},
  ...over,
});

describe('inspectGatewayChange', () => {
  it('reports every failing active rung and the selected primary leg', () => {
    const before = model({
      id: 'grok-imagine-video',
      providerModelId: 'x-ai/grok-imagine-video',
      gatewayOverride: 'kie',
      capabilities: { priceUsdPerUnit: 0.015 },
    });
    const after = { ...before, gatewayOverride: 'openrouter' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '480p'), pointFor(before.id, '720p')],
    });

    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.rung.resolution)).toEqual(['480p', '720p']);
    // The signed workbook export has Kie rows for both rungs but no OpenRouter
    // leg for this model. A routing change must therefore fail closed as
    // `uncosted`, rather than reusing the old ladder's scalar or a capability
    // price at the wrong FX family.
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining<Partial<GatewayMarginIssue>>({
          rung: expect.objectContaining({ resolution: '720p' }),
          leg: 'primary',
          gateway: 'openrouter',
          reason: 'uncosted',
          floorPct: 25,
          marginPct: null,
          shortfallPct: null,
        }),
        expect.objectContaining<Partial<GatewayMarginIssue>>({
          rung: expect.objectContaining({ resolution: '480p' }),
          leg: 'primary',
          gateway: 'openrouter',
          reason: 'uncosted',
          floorPct: 25,
          marginPct: null,
          shortfallPct: null,
        }),
      ]),
    );
  });

  it('refuses an executable fallback with no recorded cost instead of treating it as free', () => {
    const before = model({
      id: 'gemini-3-1-flash-image',
      providerModelId: 'gemini-3.1-flash-image',
      capabilities: { forceGateway: 'nanobanana', priceUsdPerUnit: 0.055 },
    });
    const after = { ...before, fallbackGateway: 'atlascloud' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '1K')],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rung: expect.objectContaining({ resolution: '1K' }),
          leg: 'fallback',
          gateway: 'atlascloud',
          reason: 'uncosted',
          marginPct: null,
          shortfallPct: null,
        }),
      ]),
    );
  });

  it('scores a selected fallback against the signed v2 catalogue, not model capabilities', () => {
    const before = model({
      id: 'gemini-3-1-flash-image',
      providerModelId: 'gemini-3.1-flash-image',
      gatewayOverride: 'kie',
      capabilities: { priceUsdPerUnit: 0.055 },
    });
    const after = { ...before, fallbackGateway: 'atlascloud' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '1K')],
      v2Catalogue: costCatalogue(),
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rung: expect.objectContaining({ resolution: '1K' }),
          leg: 'fallback',
          gateway: 'atlascloud',
          reason: 'uncosted',
        }),
      ]),
    );
  });

  it('refuses a gateway change when the model has no active price points', () => {
    const before = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'nanobanana',
      capabilities: { priceUsdPerUnit: 0.09 },
    });
    const after = { ...before, gatewayOverride: 'kie' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [],
    });

    expect(issues).toEqual([
      expect.objectContaining({
        rung: null,
        leg: 'primary',
        gateway: 'kie',
        reason: 'no_active_price_points',
        marginPct: null,
        shortfallPct: null,
      }),
    ]);
  });

  it('reproduces the Nano Banana fallback-chain route after 1K/2K are inactive', () => {
    const before = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'nanobanana',
      capabilities: {
        resolutions: ['1K', '2K', '4K'],
        priceUsdPerUnit: 0.09,
        fallbackUsdPerUnit: 0.12,
        openrouterFallbackSlug: 'google/gemini-3-pro-image',
        officialUsdPerUnit: { '4K': 0.241344 },
      },
    });
    const after = { ...before, gatewayOverride: 'kie', fallbackGateway: 'nanobanana' };

    // The 1K and 2K rows are deactivated; 4K is the remaining active rung.
    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '4K')],
    });

    expect(issues).toEqual([]);
    expect(enumerateExecutableLegs(after)).toEqual([
      { gateway: 'kie', leg: 'primary', governance: 'margin_floor' },
      { gateway: 'nanobanana', leg: 'fallback', governance: 'margin_floor' },
      { gateway: 'kie', leg: 'fallback', governance: 'margin_floor' },
      { gateway: 'openrouter-official', leg: 'last-resort', governance: 'spend_cap' },
    ]);
  });

  it('inspects the hidden tail when a complete chain is selected as fallback', () => {
    const before = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'kie',
      capabilities: {
        resolutions: ['1K', '2K', '4K'],
        priceUsdPerUnit: 0.09,
        fallbackUsdPerUnit: 0.12,
        openrouterFallbackSlug: 'google/gemini-3-pro-image',
        officialUsdPerUnit: { '4K': 0.241344 },
      },
    });
    const after = { ...before, fallbackGateway: 'nanobanana' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '2K')],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leg: 'last-resort',
          gateway: 'openrouter-official',
          reason: 'uncosted',
          marginPct: null,
        }),
      ]),
    );
  });

  it('does not apply the fallback floor to a costed official insurance leg', () => {
    const before = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'kie',
      capabilities: {
        resolutions: ['1K', '2K', '4K'],
        priceUsdPerUnit: 0.09,
        fallbackUsdPerUnit: 0.12,
        openrouterFallbackSlug: 'google/gemini-3-pro-image',
        officialUsdPerUnit: { '4K': 0.241344 },
      },
    });
    const after = { ...before, gatewayOverride: 'nanobanana' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '4K')],
    });

    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leg: 'last-resort',
          gateway: 'openrouter-official',
        }),
      ]),
    );
  });

  it('does not bless a costed VIDEO rung on the official leg, which refuses every video', () => {
    // The gate exempted any opted-in official rung it could price, on the
    // grounds that the spend cap governs it. The adapter refuses `kind: 'video'`
    // BEFORE it consults a cost — the leg is billed per output second while the
    // rung map is per unit, so nothing there could turn the spend into ₽. A
    // costed video rung is therefore a leg that can never execute, and the panel
    // must not sign off on a margin nothing will ever earn.
    const before = model({
      id: 'grok-imagine-video',
      providerModelId: 'x-ai/grok-imagine-video',
      gatewayOverride: 'kie',
      capabilities: { priceUsdPerUnit: 0.015 },
    });
    const after = {
      ...before,
      gatewayOverride: 'geminiomni',
      capabilities: {
        priceUsdPerUnit: 0.015,
        openrouterFallbackSlug: 'google/gemini-omni',
        officialUsdPerUnit: { '480p': 0.08 },
      },
    };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '480p')],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leg: 'last-resort',
          gateway: 'openrouter-official',
        }),
      ]),
    );
  });

  it('refuses an uncosted last-resort leg hidden inside a gateway chain', () => {
    const before = model({
      id: 'seedream-4-5',
      providerModelId: 'doubao-seedream-4.5',
      gatewayOverride: 'kie',
      capabilities: { forceGateway: 'kie', priceUsdPerUnit: 0.0325 },
    });
    const after = { ...before, gatewayOverride: 'nanobanana' };

    const issues = inspectGatewayChange({
      before,
      after,
      floorRub,
      pricePoints: [pointFor(before.id, '2K')],
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leg: 'last-resort',
          gateway: 'openrouter-official',
          reason: 'uncosted',
          marginPct: null,
        }),
      ]),
    );
  });
});

/**
 * The gate must check the leg the chain actually runs first on THIS rung.
 *
 * `SIGNED_CHAIN_LEG_ORDER` inverts gemini-3-1-flash-image between rungs — kie leads at
 * 1K (28,49% against laozhang's 1,67%), laozhang leads at 2K and 4K. The pricing side
 * reads that table; the arming side and the explicit fallback leg assumed laozhang
 * always leads, so the two halves of one decision could name different legs.
 */
describe('nanobanana chain legs follow the signed order per rung', () => {
  const flash = model({
    id: 'gemini-3-1-flash-image',
    providerModelId: 'gemini-3-1-flash-image',
    gatewayOverride: 'nanobanana',
    capabilities: { resolutions: ['1K', '2K', '4K'], priceUsdPerUnit: 0.03 },
  });
  const keys = (rung: string, arming?: Record<string, boolean>) =>
    v2Routes(flash, arming as never, rung).map((route) => `${route.gateway}|${route.leg}`);

  const armed = { kie: true, laozhang: true, openrouter: true, atlascloud: true };

  it('names the OTHER relay as the fallback, so neither relay goes unchecked', () => {
    // At 1K the alias is priced as kie, so the explicit fallback must be laozhang;
    // naming kie there would check kie twice and laozhang never.
    expect(keys('1K')).toContain('laozhang|fallback');
    expect(keys('1K')).not.toContain('kie|fallback');
    // At 2K and 4K laozhang leads again and the fallback is kie, as it always was.
    expect(keys('2K')).toContain('kie|fallback');
    expect(keys('4K')).toContain('kie|fallback');
  });

  it('leaves a model with no signed order exactly as it was', () => {
    const pro = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'nanobanana',
      capabilities: { resolutions: ['1K', '2K', '4K'] },
    });
    // laozhang leads by construction here and is «основная» in the export, so the
    // fallback stays kie on every rung — a leg POSITION, which is what carries the cost
    // row. Asking for laozhang as a fallback where it leads reports a costed leg as
    // uncosted.
    expect(v2Routes(pro, undefined, '4K').map((r) => `${r.gateway}|${r.leg}`)).toContain(
      'kie|fallback',
    );
  });

  it('does not enumerate a second relay for the signed single-leg 1K configuration', () => {
    const pro = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'nanobanana',
      capabilities: { resolutions: ['1K', '2K', '4K'] },
    });

    expect(v2Routes(pro, undefined, '1K').map((route) => `${route.gateway}|${route.leg}`)).toEqual([
      'nanobanana|primary',
    ]);
    expect(
      v2Routes(pro, undefined, '4K').map((route) => `${route.gateway}|${route.leg}`),
    ).toContain('kie|fallback');
  });

  it('does not report a costed single-leg 1K configuration as an uncosted relay', () => {
    const before = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'kie',
      capabilities: { resolutions: ['1K', '2K', '4K'] },
    });
    const issues = inspectGatewayChange({
      before,
      after: { ...before, gatewayOverride: 'nanobanana' },
      floorRub,
      pricePoints: [pointFor('gemini-3-pro-image', '1K')],
      v2Catalogue: costCatalogue(),
    });

    expect(issues).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rung: expect.objectContaining({ resolution: '1K' }),
          reason: 'uncosted',
        }),
      ]),
    );
  });

  it('treats production mode any as the single-leg wildcard', () => {
    const pro = model({
      id: 'gemini-3-pro-image',
      providerModelId: 'gemini-3-pro-image',
      gatewayOverride: 'nanobanana',
      capabilities: { resolutions: ['1K', '2K', '4K'] },
    });
    const point = pointFor(pro.id, '1K', 'any');

    expect(point.mode).toBe('any');
    expect(v2Routes(pro, undefined, point.resolution, point.mode)).toEqual([
      { gateway: 'nanobanana', leg: 'primary', governance: 'margin_floor' },
    ]);
  });

  it('arms the alias off its signed leaf, not off laozhang on every rung', () => {
    // Before the fix an unarmed laozhang deleted the alias row at 1K — silently
    // un-governing a chain that still runs, on kie.
    expect(keys('1K', { ...armed, laozhang: false })).toContain('nanobanana|primary');
    expect(keys('1K', { ...armed, kie: false })).not.toContain('nanobanana|primary');
    // At 2K the signed leaf IS laozhang, so the old behaviour is the correct one.
    expect(keys('2K', { ...armed, laozhang: false })).not.toContain('nanobanana|primary');
  });
});
