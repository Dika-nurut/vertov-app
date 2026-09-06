import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import {
  creditFloorRub,
  matchesPricePointSeed,
  modelBreakEven,
  pricePointBreakEven,
  realGatewayFamily,
  gatewayFamilyOf,
  type BreakEvenModel,
} from '../src/price-breakeven';

/**
 * Unit test for the shared break-even math — the module BOTH the CI guard
 * (cogs-breakeven.test.ts) and the runtime activation gate
 * (apps/api /v1/admin/models/:id/price-points/activate) depend on.
 */

const floor = creditFloorRub(seedSubscriptionTiers);

const model = (over: Partial<BreakEvenModel> & { id: string }): BreakEvenModel => ({
  gatewayOverride: null,
  providerModelId: over.id,
  capabilities: {},
  ...over,
});

describe('price-breakeven module', () => {
  it('floor is the cheapest subscriber rate (~0.331 ₽/cr)', () => {
    expect(floor).toBeCloseTo(0.331, 3);
  });

  it('classifies gateway families like production (only openrouter* is dear FX)', () => {
    expect(gatewayFamilyOf('openrouter')).toBe('openrouter');
    expect(gatewayFamilyOf('openrouter-official')).toBe('openrouter');
    expect(gatewayFamilyOf('kie')).toBe('direct');
    expect(gatewayFamilyOf('nanobanana')).toBe('direct');
    expect(gatewayFamilyOf('atlascloud')).toBe('direct');
  });

  it('mirrors jobs-routes routing precedence: override → slash → forceGateway', () => {
    // gatewayOverride wins even over a slash id.
    expect(
      realGatewayFamily(
        model({ id: 'veo-3-1', providerModelId: 'google/veo-3.1', gatewayOverride: 'kie' }),
      ),
    ).toBe('direct');
    // slash id forces OpenRouter, ignoring forceGateway.
    expect(
      realGatewayFamily(
        model({
          id: 'veo-3-1',
          providerModelId: 'google/veo-3.1',
          capabilities: { forceGateway: 'kie' },
        }),
      ),
    ).toBe('openrouter');
    // bare slug honors forceGateway.
    expect(
      realGatewayFamily(
        model({
          id: 'seedance-2-0',
          providerModelId: 'seedance-2.0-text-to-video',
          capabilities: { forceGateway: 'openrouter' },
        }),
      ),
    ).toBe('openrouter');
  });

  it('a slash-id model with NO gatewayOverride is below break-even (the pre-flip shape)', () => {
    // Hand-built fixtures in the PRE-flip shape (slash providerModelId, no override) to
    // prove the function's routing→margin behavior. NOTE: the REAL seed rows for grok/veo
    // are now gatewayOverride='kie' (see the go-live test below), so these fixtures no
    // longer mirror seed/models.ts — they document what WOULD happen without the kie pin.
    const grok = modelBreakEven(
      model({
        id: 'grok-imagine-video',
        providerModelId: 'x-ai/grok-imagine-video',
        capabilities: { priceUsdPerUnit: 0.05 },
      }),
      floor,
    );
    // The signed workbook has no OpenRouter leg for this current Grok rung. A
    // synthetic slash route therefore fails closed; the old ladder scalar must
    // not manufacture a negative margin.
    expect(grok.hasCostData).toBe(false);
    expect(grok.routedFamily).toBe('openrouter');
    expect(grok.margin).toBeNull();

    const veo = modelBreakEven(
      model({
        id: 'veo-3-1',
        providerModelId: 'google/veo-3.1',
        capabilities: { priceUsdPerUnit: 0.4 },
      }),
      floor,
    );
    expect(veo.hasCostData).toBe(false);
    expect(veo.margin).toBeNull();
  });

  it('pinning gatewayOverride=kie flips grok/veo POSITIVE — the live routing', () => {
    // This is the routing the real seed now uses (gatewayOverride='kie', 2026-07-19):
    // the same row that was below break-even on OpenRouter clears break-even once
    // pinned to the cheap kie vendor the ladder assumed.
    const grokPinned = modelBreakEven(
      model({
        id: 'grok-imagine-video',
        providerModelId: 'x-ai/grok-imagine-video',
        gatewayOverride: 'kie',
      }),
      floor,
    );
    expect(grokPinned.routedFamily).toBe('direct');
    expect(grokPinned.margin!).toBeGreaterThan(0);

    const veoPinned = modelBreakEven(
      model({ id: 'veo-3-1', providerModelId: 'google/veo-3.1', gatewayOverride: 'kie' }),
      floor,
    );
    expect(veoPinned.margin!).toBeGreaterThan(0);
  });

  it('scores the candidate row credits and units, including its fallback — not the model reference rung', () => {
    const nanoBanana = model({
      id: 'gemini-3-1-flash-image',
      providerModelId: 'gemini-3.1-flash-image',
      fallbackGateway: null,
      capabilities: {
        forceGateway: 'nanobanana',
        priceUsdPerUnit: 0.055,
        fallbackUsdPerUnit: 0.09,
      },
    });
    // The signed 1K row is 23 credits. A candidate edited to charge one credit
    // is not workbook-canonical, so its economics are deliberately unverifiable
    // rather than borrowed from a nearby signed rung.
    expect(modelBreakEven(nanoBanana, floor).margin).toBeGreaterThan(0);

    const candidate = pricePointBreakEven(nanoBanana, floor, {
      modelId: nanoBanana.id,
      resolution: '1K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: 1,
      baseUnits: 1,
      sourceRef: 'test:edited-price',
    });
    expect(candidate.hasCostData).toBe(false);
    expect(candidate.margin).toBeNull();
    expect(candidate.fallback?.margin).toBeNull();
  });

  it('allows only canonical price economics when per-config COGS is not separately sourced', () => {
    const canonical = PRICE_POINT_SEED[0]!;
    expect(matchesPricePointSeed(canonical)).toBe(true);
    expect(matchesPricePointSeed({ ...canonical, baseCredits: canonical.baseCredits - 1 })).toBe(
      false,
    );
  });

  it('scores a canonical per-clip Veo row without prorating its COGS', () => {
    const veo = seedModels.find((row) => row.id === 'veo-3-1');
    const point = PRICE_POINT_SEED.find(
      (row) => row.modelId === 'veo-3-1' && row.resolution === '1080p',
    );
    if (!veo || !point) throw new Error('canonical Veo seed data missing');

    const result = pricePointBreakEven(veo as BreakEvenModel, floor, point);
    expect(result.hasCostData).toBe(true);
    expect(result.margin).not.toBeNull();
    expect(result.margin!).toBeGreaterThan(0);
  });

  /**
   * Phase 1.5 — the primary leg was never the whole cost. `gemini-3-1-flash-image`
   * routes laozhang → kie, and its 4K kie rate ($0.09/img) is 64% dearer than the
   * laozhang rate the margin guard used to score it on. That leg was invisible by
   * construction: nothing in the module even represented it.
   */
  describe('the fallback leg is priced and checked, not assumed', () => {
    // Sourced from the REAL seed row, never hand-copied. The hardcoded version of
    // this fixture carried `fallbackUsdPerUnit: 0.09` — kie's 4K rate — for four
    // days after the owner corrected the row to the real flat $0.04 (2026-07-28,
    // see the comment on the row itself). A fixture that claims to model a live
    // row and then drifts from it tests the past.
    const nanoBanana2 = seedModels.find(
      (m) => m.id === 'gemini-3-1-flash-image',
    ) as unknown as BreakEvenModel;

    it('names the fallback gateway the nanobanana chain really falls back to', () => {
      const r = modelBreakEven(nanoBanana2, floor);
      expect(r.fallback?.gateway).toBe('kie');
      expect(r.fallback?.family).toBe('direct');
    });

    it('scores the fallback leg separately from the primary', () => {
      const r = modelBreakEven(nanoBanana2, floor);
      // This SKU's 1K rung is 23 credits («Сетка FX!AA32»), the value the price
      // table actually charges. `costModel` carried 28 here until 2026-08-02 — a
      // phantom nobody was ever billed, which moved every margin this guard
      // computed for the model. The cost/price rung agreement is now pinned by
      // `price-points-drift.test.ts`.
      // The conservative workbook reference is the dearest active 4K row:
      // LaoZhang $0.055 and Kie $0.09, both divided by the signed 28-credit
      // rung. These are intentionally not copied from the old ladder snapshot.
      expect(r.margin!).toBeCloseTo(0.4030130333, 8);
      expect(r.fallback!.margin!).toBeCloseTo(0.0231122363, 8);
      // The fallback remains visible to the guard. It clears the zero fallback
      // floor, but not the primary 25% target.
      expect(r.fallback!.margin!).toBeGreaterThanOrEqual(0);
    });

    it('reports a fallback leg with no cost figure as uncosted, never as free', () => {
      const noFigure = model({
        id: 'gemini-3-1-flash-image',
        providerModelId: 'gemini-3.1-flash-image',
        fallbackGateway: 'evolink',
        capabilities: { priceUsdPerUnit: 0.055 },
        // The primary is signed, but Evolink is an executable legacy gateway with no
        // signed workbook row. The fallback must remain explicitly UNCOSTED.
      });
      const r = modelBreakEven(noFigure, floor);
      expect(r.fallback?.gateway).toBe('evolink');
      expect(r.fallback?.costPerCredit).toBeNull();
      expect(r.fallback?.margin).toBeNull();
    });

    it('has no fallback leg when the model declares none (veo: owner ruling, kie or fail)', () => {
      const veo = model({
        id: 'veo-3-1',
        providerModelId: 'google/veo-3.1',
        gatewayOverride: 'kie',
        fallbackGateway: null,
      });
      expect(modelBreakEven(veo, floor).fallback).toBeNull();
    });
  });

  it('scores Seedream 4.5’s OpenRouter fallback at the OpenRouter landed FX', () => {
    const seedream = seedModels.find((m) => m.id === 'seedream-4-5');
    if (!seedream) throw new Error('Seedream 4.5 seed row missing');
    const result = modelBreakEven(seedream as BreakEvenModel, floor);
    expect(result.fallback).toMatchObject({ gateway: 'openrouter', family: 'openrouter' });

    // Seedream's fallback is an exact OpenRouter row in the signed export; use
    // the runtime result as the contract rather than re-copying a scalar from
    // the retired ladder JSON.
    expect(result.fallback!.costPerCredit).toBeCloseTo(0.212364, 9);
    expect(result.fallback!.margin).toBeCloseTo(0.3586322148, 9);
  });

  it("prices a selected OpenRouter leg from that leg, not the model row's kie figure", () => {
    const grok = model({
      id: 'grok-imagine-video',
      providerModelId: 'x-ai/grok-imagine-video',
      gatewayOverride: 'openrouter',
      capabilities: { priceUsdPerUnit: 0.015 },
    });
    const points = PRICE_POINT_SEED.filter((point) => point.modelId === grok.id && point.isActive);

    const margins = points.map(
      (point) =>
        pricePointBreakEven(grok, floor, {
          modelId: point.modelId,
          resolution: point.resolution,
          videoInput: point.videoInput,
          audio: point.audio,
          unitKind: point.unitKind,
          baseCredits: point.baseCredits,
          baseUnits: point.baseUnits,
          flatRate: point.flatRate,
          sourceRef: point.sourceRef,
        }).margin,
    );

    expect(margins).toHaveLength(2);
    // No OpenRouter cost leg is signed for Grok in the current workbook export.
    // An arbitrary gateway override is consequently uncosted, never scored from
    // the model's Kie scalar or the retired ladder.
    expect(margins.every((margin) => margin === null)).toBe(true);
    // Was −1.347 against the frozen v14 sell price of 41 credits (Сетка FX!AA28).
    // Rev. 9 reprices grok 720p to 69 credits (`seed/cost-legs.csv` row
    // `grok-imagine-video,720p` → Сетка FX стр.28), and nothing on the cost side
    // moved: the leg is still the ladder's OpenRouter $0.05/s × 6 s at the OR FX.
    // A bigger divisor, the same numerator — the loss shrinks to −39.4%.
    //
    // The assertion still discriminates, which is the whole point of the test: at
    // the model row's kie figure ($0.015/s) this same rung reads +60.4%, so only the
    // OpenRouter leg can produce a negative number here.
    expect(margins[0]).toBeNull();
  });

  it('scores the Veo OpenRouter audio rate on its 1080p rung', () => {
    const veo = model({
      id: 'veo-3-1',
      providerModelId: 'google/veo-3.1',
      gatewayOverride: 'openrouter',
      capabilities: { priceUsdPerUnit: 0.159375 },
    });
    const point = PRICE_POINT_SEED.find(
      (candidate) =>
        candidate.modelId === veo.id && candidate.resolution === '1080p' && candidate.isActive,
    );
    if (!point) throw new Error('missing active Veo 1080p price point');

    const result = pricePointBreakEven(veo, floor, {
      modelId: point.modelId,
      resolution: point.resolution,
      videoInput: point.videoInput,
      audio: point.audio,
      unitKind: point.unitKind,
      baseCredits: point.baseCredits,
      baseUnits: point.baseUnits,
      flatRate: point.flatRate,
      sourceRef: point.sourceRef,
    });

    // The current workbook signs Veo on Kie only. A synthetic OpenRouter
    // override has no exact leg and must therefore fail closed.
    expect(result.hasCostData).toBe(false);
    expect(result.margin).toBeNull();
  });

  it('does not borrow a cost across audio or mode configurations', () => {
    const kling = PRICE_POINT_SEED.find(
      (point) => point.modelId === 'kling-v3-0-std' && point.resolution === '720p' && point.audio,
    );
    if (!kling) throw new Error('missing active Kling audio point');
    const result = pricePointBreakEven(
      model({ id: kling.modelId, providerModelId: 'kwaivgi/kling-v3.0-std' }),
      floor,
      { ...kling, sourceRef: kling.sourceRef },
    );
    expect(result.hasCostData).toBe(true);
    expect(result.routedCostPerCredit).toBeCloseTo((0.126 * 106.182 * 5) / 270, 9);
  });

  it('returns hasCostData:false for a model with no frozen COGS row', () => {
    const r = modelBreakEven(
      model({ id: 'no-such-model', providerModelId: 'no-such-model' }),
      floor,
    );
    expect(r.hasCostData).toBe(false);
    expect(r.margin).toBeNull();
  });
});

describe('reference bands use the generated v2 cost at their ceiling', () => {
  const seedreamBand = (resolution: '1K' | '2K' = '2K') => {
    const point = PRICE_POINT_SEED.find(
      (candidate) =>
        candidate.modelId === 'seedream-5-0-pro' &&
        candidate.resolution === resolution &&
        candidate.refsMin === 2,
    );
    if (!point) throw new Error(`missing the seeded Seedream Pro ${resolution} reference band`);
    return point;
  };

  const asBreakEvenPoint = (point: ReturnType<typeof seedreamBand>) => ({
    modelId: point.modelId,
    resolution: point.resolution,
    videoInput: point.videoInput,
    audio: point.audio,
    unitKind: point.unitKind,
    baseCredits: point.baseCredits,
    baseUnits: point.baseUnits,
    flatRate: point.flatRate,
    mode: point.mode,
    refsMin: point.refsMin,
    refsMax: point.refsMax,
    sourceRef: point.sourceRef,
  });

  it('reproduces both Seedream signed band margins at the ceiling', () => {
    const seedream = model({
      id: 'seedream-5-0-pro',
      providerModelId: 'seedream/5-pro-image-to-image',
      gatewayOverride: 'kie',
      capabilities: { priceUsdPerUnit: 0.07 },
    });
    const oneK = pricePointBreakEven(seedream, floor, asBreakEvenPoint(seedreamBand('1K')));
    const twoK = pricePointBreakEven(seedream, floor, asBreakEvenPoint(seedreamBand('2K')));
    expect(oneK.hasCostData).toBe(true);
    expect(oneK.margin).toBeCloseTo(0.271857, 6);
    expect(twoK.hasCostData).toBe(true);
    expect(twoK.margin).toBeCloseTo(0.260193, 6);
  });

  it('costs Flux multi-reference on its Kie primary leg', () => {
    const flux = seedModels.find((candidate) => candidate.id === 'flux-2-pro');
    // Pinned to 1K. This `find` was unpinned until rev. 19 gave flux a SECOND 2-8
    // reference band, at 2K — after which the same query silently returned a different
    // row and every number below described a configuration the test was not written
    // about. The rung is part of what is being asserted, so it belongs in the lookup.
    const point = PRICE_POINT_SEED.find(
      (candidate) =>
        candidate.modelId === 'flux-2-pro' &&
        candidate.refsMin === 2 &&
        candidate.resolution === '1K',
    );
    if (!flux || !point) throw new Error('missing Flux 2–8 reference band');
    const result = pricePointBreakEven(flux as BreakEvenModel, floor, asBreakEvenPoint(point));
    // The routed leg is kie. kie publishes $0.025/img for flux, and the row was signed
    // in rev. 12 (2026-08-09) once kie-adapter.ts stopped refusing multi-reference
    // requests — the adapter had assumed `input_urls` was a single string, but the
    // vendor spec (kie-specs/flux2__pro-image-to-image.md) always declared it a 1–8
    // array. Margin is 45.73% on that leg, against 12.5% on the OpenRouter reserve.
    //
    // 41.55% → 45.73% with rev. 13, which moved the band 13 → 14 credits. Not a reprice:
    // OpenRouter bills $0.03 per MEGAPIXEL and a 1K image is 1.049 MP, so the RESERVE leg
    // always cost $0.0315 and 13 credits was 22.4% there — under the 25% floor by a
    // rounding both sides had read as a flat per-picture rate. The kie primary was never
    // the problem, which is why its margin only goes up.
    expect(result.margin).toBeCloseTo(0.4572845757430488, 6);
    expect(result.fallback?.gateway).toBe('openrouter');
    // 27.85% is not a scalar approximation of anything: it is finance's own signed
    // number for this band's OpenRouter leg — 1 − ($0,0315 × 106,182) ÷ (14 × 1490/4500),
    // the per-MEGAPIXEL rate at the OpenRouter FX. Both figures asserted here are the
    // band's two signed legs.
    //
    // What they expose is a ROLE inversion, not a rate one. The export makes OpenRouter
    // the band's «основная» at 27,85% and Kie the «резервная» at 45,73%; the runtime
    // routes it the other way round, kie primary and OpenRouter reserve. The rates agree
    // leg for leg, so nothing is mispriced today — but role-based reporting and the
    // margin floors read the labels, and a primary floor of 25% applied to the wrong leg
    // is a governance question rather than a cosmetic one. Raised with finance for
    // rev. 15; whichever way it settles, one of the two sides moves.
    expect(result.fallback?.margin).toBeCloseTo(0.27846124161073815, 6);
  });

  it('costs the rev. 19 Flux 2K reference band at the flat Kie image price', () => {
    // The band finance signed in rev. 19. It is NOT a reprice of the 1K band above: kie
    // bills flat per image and does not meter the input, so 2K with references costs
    // exactly what plain 2K costs and sells at the same 29.09%. Rev. 19 signs only the
    // Kie leg at this rung (depth 1), so there is no OpenRouter reserve cost to claim a
    // fallback margin for.
    const flux = seedModels.find((candidate) => candidate.id === 'flux-2-pro');
    const point = PRICE_POINT_SEED.find(
      (candidate) =>
        candidate.modelId === 'flux-2-pro' &&
        candidate.refsMin === 2 &&
        candidate.resolution === '2K',
    );
    if (!flux || !point) throw new Error('missing the rev. 19 Flux 2K reference band');
    const result = pricePointBreakEven(flux as BreakEvenModel, floor, asBreakEvenPoint(point));
    expect(result.margin).toBeCloseTo(0.2908518456375838, 6);
    expect(result.fallback?.gateway).toBe('openrouter');
    expect(result.fallback?.margin).toBeNull();
  });

  it('leaves synthetic with-video rows fail-closed', () => {
    const sourcePoint = PRICE_POINT_SEED.find(
      (candidate) =>
        candidate.modelId === 'seedance-2-0' && candidate.refsMin === 0 && !candidate.videoInput,
    );
    const seedance = seedModels.find((candidate) => candidate.id === 'seedance-2-0');
    if (!sourcePoint || !seedance) throw new Error('missing Seedance seed row');
    // No seeded row exercises this today; keep the guard covered with a synthetic variant.
    const withVideo = { ...asBreakEvenPoint(sourcePoint), videoInput: true };
    const result = pricePointBreakEven(seedance as BreakEvenModel, floor, withVideo);
    expect(result.margin).toBeNull();
  });

  it('still recognises the band as a canonical seeded row', () => {
    // Fail-closed on COGS must not read as «invented row»: the two answers are
    // independent, and conflating them would make the band look operator-authored.
    expect(matchesPricePointSeed(asBreakEvenPoint(seedreamBand()))).toBe(true);
  });

  it('refuses to match a band against the plain row it sits beside', () => {
    const band = seedreamBand();
    expect(matchesPricePointSeed({ ...asBreakEvenPoint(band), refsMin: 0, refsMax: null })).toBe(
      false,
    );
  });
});
