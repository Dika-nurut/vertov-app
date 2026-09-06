import { describe, expect, it, vi } from 'vitest';
import type { PricePoint } from '@seed/credits';
import { PRICE_POINT_SEED } from '@seed/db/seed/price-points';
import { seedModels } from '@seed/db/seed/models';
import { expiredPriceObligations } from '@seed/db';
import {
  billableVideoUnitsForModel,
  byteplusRouteContracts,
  normalizeVideoParams,
} from '@seed/shared';
import {
  buildKieImageBody,
  buildKieVeoBody,
  buildKieVideoBody,
  buildLaozhangImageBody,
  buildOpenRouterImageBody,
  buildOpenRouterVideoBody,
  CircuitBreakerAdapter,
  KieAdapter,
  LaozhangAdapter,
  type KieClient,
  type LaozhangClient,
  type WorkflowSpec,
} from '../../../packages/providers/byteplus/src/index.ts';
import {
  filterExpiredPricePoints,
  minBillableDurationSeconds,
  priceModeForRequest,
  priceSelectorFromParams,
  resolveJobPriceFromPoints,
  type JobPriceModel,
} from '../src/pricing-resolver';

const videoModel: JobPriceModel = {
  id: 'seedance-2-0',
  kind: 'video',
  maxDurationSeconds: 12,
  minDurationSeconds: 4,
};

const point = (over: Partial<PricePoint>): PricePoint => ({
  modelId: 'seedance-2-0',
  resolution: '720p',
  videoInput: false,
  audio: false,
  unitKind: 'second',
  baseCredits: 100,
  baseUnits: 5,
  ...over,
});

const p480 = point({ resolution: '480p', baseCredits: 40 });
const p720 = point({ resolution: '720p', baseCredits: 100 });
const p1080 = point({ resolution: '1080p', baseCredits: 220 });

describe('expired finance price obligations', () => {
  const fluxBase = point({
    modelId: 'flux-2-pro',
    resolution: '1K',
    baseCredits: 11,
    mode: 'any',
    refsMin: 0,
    refsMax: null,
  });
  const expiredFluxBand = point({
    modelId: 'flux-2-pro',
    resolution: '1K',
    baseCredits: 14,
    mode: 'any',
    refsMin: 2,
    refsMax: 8,
  });

  it('retires the exact expired ruling once the owner instruction is applied', () => {
    expect(filterExpiredPricePoints([fluxBase], new Date('2026-08-25T00:00:00Z'))).toEqual([
      fluxBase,
    ]);
    // After the owner-approved deactivation there is no obligation left to filter.
    expect(expiredPriceObligations(new Date('2026-08-25T00:00:00Z'))).toEqual([]);
  });

  it('does not hide a different model or reference band', () => {
    const different = point({
      modelId: 'flux-2-pro',
      resolution: '2K',
      baseCredits: 15,
      mode: 'any',
      refsMin: 2,
      refsMax: 8,
    });
    expect(filterExpiredPricePoints([different], new Date('2026-08-25T00:00:00Z'))).toEqual([
      different,
    ]);
  });
});

describe('priceSelectorFromParams — request → price-point selector', () => {
  it('reads the price dimension from quality/resolution, never image aspect size', () => {
    expect(priceSelectorFromParams({ resolution: '480p' }).resolution).toBe('480p');
    expect(priceSelectorFromParams({ quality: '2K' }).resolution).toBe('2K');
    expect(priceSelectorFromParams({ size: '1:1' }).resolution).toBe('default');
    expect(priceSelectorFromParams({}).resolution).toBe('default');
  });

  it('uses the rendered resolution when a crafted request sends both aliases', () => {
    expect(priceSelectorFromParams({ quality: '480p', resolution: '1080p' }).resolution).toBe(
      '1080p',
    );
  });

  it('flags with-video when the request carries videoUrls', () => {
    expect(priceSelectorFromParams({ videoUrls: ['u'] }).videoInput).toBe(true);
    expect(priceSelectorFromParams({ videoUrls: [] }).videoInput).toBe(false);
    expect(priceSelectorFromParams({}).videoInput).toBe(false);
  });

  it('does not expose an audio selector for fixed-audio catalogue rows', () => {
    expect(
      priceSelectorFromParams(
        { generate_audio: false },
        { audio: true, audioControl: false },
        'video',
      ),
    ).toEqual({ resolution: 'default', videoInput: false });
  });
});

describe('resolveJobPriceFromPoints — the charge integration', () => {
  const points = [p480, p720, p1080];

  it('charges a 480p job strictly fewer credits than a 1080p job', () => {
    const at480 = resolveJobPriceFromPoints(
      videoModel,
      { duration_seconds: 4, resolution: '480p' },
      points,
    );
    const at1080 = resolveJobPriceFromPoints(
      videoModel,
      { duration_seconds: 4, resolution: '1080p' },
      points,
    );
    expect(at480.ok && at1080.ok).toBe(true);
    if (at480.ok && at1080.ok) {
      expect(at480.price.source).toBe('parametric');
      expect(at480.price.cost).toBe(32); // 40/5 × 4
      expect(at1080.price.cost).toBe(176); // 220/5 × 4
      expect(at480.price.cost).toBeLessThan(at1080.price.cost);
    }
  });

  it('bills the resolution the provider renders, never the cheaper quality alias', () => {
    const r = resolveJobPriceFromPoints(
      videoModel,
      { duration_seconds: 4, quality: '480p', resolution: '1080p' },
      points,
    );
    expect(r).toMatchObject({ ok: true, price: { source: 'parametric', cost: 176 } });
  });

  it('refuses a video quality alias with no resolution instead of guessing a priced row', () => {
    // Crafted {quality:'480p'} with no resolution: the provider ignores video
    // quality and renders its own default, so we must NOT bill the 480p row (32cr).
    const r = resolveJobPriceFromPoints(
      videoModel,
      { duration_seconds: 4, quality: '480p' },
      points,
    );
    expect(r).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('refuses video input when its only row is inactive from the active ladder', () => {
    const r = resolveJobPriceFromPoints(
      videoModel,
      {
        duration_seconds: 4,
        inputDurationSeconds: 1,
        resolution: '720p',
        videoUrls: ['ref.mp4'],
      },
      [p720],
    );
    expect(r).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('does not invent a with-video price without a trusted input duration', () => {
    expect(
      resolveJobPriceFromPoints(
        videoModel,
        { duration_seconds: 4, resolution: '720p', videoUrls: ['ref.mp4'] },
        [],
      ),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('prices an image-only reference-to-video payload from its mirror row', () => {
    expect(
      resolveJobPriceFromPoints(
        { ...videoModel, id: 'seedance-2-0-reference-to-video' },
        { duration_seconds: 4, resolution: '720p', imageUrls: ['reference.png'] },
        [point({ modelId: 'seedance-2-0-reference-to-video', baseCredits: 100 })],
      ),
    ).toEqual({
      ok: true,
      price: { cost: 80, units: 4, imageUnitCredits: null, source: 'parametric' },
    });
  });

  it('prices the mirror only from output seconds and marks image-only input as videoInput=false', () => {
    const mirror = point({
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '720p',
      baseCredits: 564,
      baseUnits: 5,
    });
    const model = { ...videoModel, id: 'seedance-2-0-reference-to-video' };
    expect(priceSelectorFromParams({ imageUrls: ['reference.png'] }).videoInput).toBe(false);
    expect(
      resolveJobPriceFromPoints(
        model,
        { duration_seconds: 4, resolution: '720p', imageUrls: ['reference.png'] },
        [mirror],
      ),
    ).toMatchObject({ ok: true, price: { cost: 452, source: 'parametric' } });
    expect(
      resolveJobPriceFromPoints(
        model,
        { duration_seconds: 5, resolution: '720p', imageUrls: ['reference.png'] },
        [mirror],
      ),
    ).toMatchObject({ ok: true, price: { cost: 564, source: 'parametric' } });
  });

  it('floors a crafted 1s request to the model 4s minimum on the live charge path', () => {
    // Was asserted against the flat fallback (points: []); that input now REFUSES
    // (`price_unavailable`), so the duration floor — the actual subject here — is
    // asserted against a real priced row instead. 100/5 = 20/s × the 4s floor.
    const r = resolveJobPriceFromPoints(videoModel, { duration_seconds: 1, resolution: '720p' }, [
      p720,
    ]);
    expect(r).toEqual({
      ok: true,
      price: { cost: 80, units: 4, imageUnitCredits: null, source: 'parametric' },
    });
  });

  it('refuses an unsupported config when valid active points exist', () => {
    expect(
      resolveJobPriceFromPoints(videoModel, { duration_seconds: 4, resolution: '4K' }, [
        p480,
        p720,
      ]),
    ).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('REFUSES a malformed active point instead of flat-pricing the job', () => {
    // Previously flat-charged. A row that violates the DB CHECKs (base_credits > 0)
    // is corruption, and the flat rate it fell to is resolution-blind — exactly the
    // substitution that billed 480p at the 1080p-blind rate. Fail loud instead.
    expect(
      resolveJobPriceFromPoints(videoModel, { duration_seconds: 4, resolution: '720p' }, [
        point({ baseCredits: 0 }),
      ]),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('REFUSES a requested malformed row even when another config is valid', () => {
    expect(
      resolveJobPriceFromPoints(videoModel, { duration_seconds: 4, resolution: '720p' }, [
        point({ resolution: '720p', baseCredits: 0 }),
        p1080,
      ]),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('REFUSES two active audio states for one request shape instead of guessing a price', () => {
    expect(
      resolveJobPriceFromPoints(videoModel, { duration_seconds: 5, resolution: '720p' }, [
        p720,
        point({ audio: true, baseCredits: 130 }),
      ]),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('matches exact Generate and Boards image params plus resolution-less Omni', () => {
    const imageModel = (id: string, capabilities?: Record<string, unknown>): JobPriceModel => ({
      id,
      kind: 'image',
      maxDurationSeconds: null,
      capabilities,
    });
    const imagePoint = (modelId: string, resolution: string, baseCredits: number) =>
      point({ modelId, resolution, unitKind: 'image', baseCredits, baseUnits: 1 });

    const generate = resolveJobPriceFromPoints(
      imageModel('gemini-3-pro-image', { resolutions: ['1K', '2K', '4K'] }),
      { size: '1:1', quality: '2K', n: 1 },
      [imagePoint('gemini-3-pro-image', '2K', 31)],
    );
    const boards = resolveJobPriceFromPoints(
      imageModel('seedream-5-0-pro', { resolutions: ['1K', '2K'] }),
      { aspect_ratio: '16:9', resolution: '2K', n: 3 },
      [imagePoint('seedream-5-0-pro', '2K', 30)],
    );
    const omni = resolveJobPriceFromPoints(
      { ...videoModel, id: 'gemini-omni-flash', capabilities: { resolutions: [] } },
      { duration_seconds: 8, aspect_ratio: '16:9', return_last_frame: true },
      [point({ modelId: 'gemini-omni-flash', resolution: 'default', baseCredits: 282 })],
    );

    expect(generate).toMatchObject({ ok: true, price: { source: 'parametric', cost: 31 } });
    expect(boards).toMatchObject({ ok: true, price: { source: 'parametric', cost: 90 } });
    expect(omni).toMatchObject({ ok: true, price: { source: 'parametric', cost: 452 } });
  });

  it('prices no more reference images than the model maxRefs cap can deliver', () => {
    const model = {
      id: 'seedream-5-0-pro',
      kind: 'image',
      maxDurationSeconds: null,
      capabilities: { resolutions: ['1K'], maxRefs: 10 },
    } satisfies JobPriceModel;
    const pricePoint: PricePoint = {
      modelId: 'seedream-5-0-pro',
      resolution: '1K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: 16,
      baseUnits: 1,
      perItem: { included: 1, creditsPerExtra: 1 },
    };
    const references = (count: number) =>
      Array.from({ length: count }, (_, index) => `https://example.com/ref-${index}.png`);

    const ten = resolveJobPriceFromPoints(
      model,
      { resolution: '1K', n: 1, imageUrls: references(10) },
      [pricePoint],
    );
    const twenty = resolveJobPriceFromPoints(
      model,
      { resolution: '1K', n: 1, imageUrls: references(20) },
      [pricePoint],
    );

    expect(ten).toEqual({
      ok: true,
      price: { cost: 25, units: 1, imageUnitCredits: 25, source: 'parametric' },
    });
    expect(twenty).toEqual(ten);
  });

  it('an explicit reference count prices a reference whose URL does not exist yet', () => {
    // The Run All case. Shot B takes shot A's output, so when B is quoted the URL
    // is unknowable — but the reference WILL be sent, and it is priced. Quoting it
    // away is what the bound submit turns into a 409 the retry reproduces, because
    // the retry re-takes the same pre-run snapshot.
    //
    // The count is passed EXPLICITLY rather than as a placeholder URL: a URL we
    // quote and never send is the same divergence pointing the other way. It is
    // accepted on the estimate only — at submit the references are real, and
    // trusting a caller's number there would be a way to buy a cheaper band.
    const model = {
      id: 'seedream-5-0-pro',
      kind: 'image',
      maxDurationSeconds: null,
      capabilities: { resolutions: ['1K'], maxRefs: 10 },
    } satisfies JobPriceModel;
    const pricePoint: PricePoint = {
      modelId: 'seedream-5-0-pro',
      resolution: '1K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: 16,
      baseUnits: 1,
      perItem: { included: 1, creditsPerExtra: 1 },
    };
    const params = { resolution: '1K', n: 1, imageUrls: ['https://example.com/settled.png'] };

    // One settled reference, one still to come: the same price as two settled ones.
    const quoted = resolveJobPriceFromPoints(model, params, [pricePoint], 2);
    const submitted = resolveJobPriceFromPoints(
      model,
      { ...params, imageUrls: [...params.imageUrls, 'https://example.com/rendered.png'] },
      [pricePoint],
    );
    expect(quoted).toEqual(submitted);
    // …and one short is exactly the 409 this exists to prevent.
    expect(resolveJobPriceFromPoints(model, params, [pricePoint])).not.toEqual(submitted);
  });

  it('prices the exact GPT Image Generate payload on its declared quality axis', () => {
    // Rewritten for the SHIPPED model shape: phase 1.1 gave gpt-image-2
    // `resolutions: ['low','medium','high']`, and /generate now sends the middle
    // tier explicitly (resolveImageQuality in GenerateClient.tsx). The old
    // assertion — `resolutions: []` collapsing to `default` and flat-charging 25
    // through the activation softener — described a model that no longer exists
    // and a softener that has been removed.
    const gptImage = {
      id: 'gpt-image-2',
      kind: 'image',
      maxDurationSeconds: null,
      capabilities: { resolutions: ['low', 'medium', 'high'] },
    } satisfies JobPriceModel;
    const quality = (resolution: string, baseCredits: number) =>
      point({ modelId: 'gpt-image-2', resolution, unitKind: 'image', baseCredits, baseUnits: 1 });
    const rows = [quality('low', 13), quality('medium', 21), quality('high', 33)];

    // /generate sends the selected quality under `resolution`. Changing the
    // picker selection must therefore change this exact server quote, which is
    // also the price chip's source of truth.
    expect(
      resolveJobPriceFromPoints(gptImage, { size: '1:1', resolution: 'low', n: 1 }, rows),
    ).toEqual({
      ok: true,
      price: { cost: 13, units: 1, imageUnitCredits: 13, source: 'parametric' },
    });
    expect(
      resolveJobPriceFromPoints(gptImage, { size: '1:1', resolution: 'medium', n: 1 }, rows),
    ).toEqual({
      ok: true,
      price: { cost: 21, units: 1, imageUnitCredits: 21, source: 'parametric' },
    });
    expect(
      resolveJobPriceFromPoints(gptImage, { size: '1:1', resolution: 'high', n: 1 }, rows),
    ).toEqual({
      ok: true,
      price: { cost: 33, units: 1, imageUnitCredits: 33, source: 'parametric' },
    });
    // …and a request that names no quality at all is REFUSED, not flat-charged:
    // the model has a quality axis, so `default` is a config we do not price.
    expect(resolveJobPriceFromPoints(gptImage, { size: '1:1', n: 1 }, rows)).toEqual({
      ok: false,
      error: 'config_not_available',
    });
  });

  it('collapses a crafted quality tier to the real default for a no-resolution model', () => {
    const gptImage = {
      id: 'gpt-image-2',
      kind: 'image',
      maxDurationSeconds: null,
      capabilities: { resolutions: [] },
    } satisfies JobPriceModel;

    expect(
      resolveJobPriceFromPoints(gptImage, { size: '1:1', quality: 'low', n: 1 }, [
        point({
          modelId: 'gpt-image-2',
          resolution: 'default',
          unitKind: 'image',
          baseCredits: 27,
          baseUnits: 1,
        }),
        point({
          modelId: 'gpt-image-2',
          resolution: 'low',
          unitKind: 'image',
          baseCredits: 10,
          baseUnits: 1,
        }),
      ]),
    ).toMatchObject({ ok: true, price: { cost: 27, source: 'parametric' } });
  });

  it('REFUSES a declared-but-unactivated resolution instead of softening it back to flat', () => {
    // This test previously pinned `activationSafeResolved` — the softener that
    // turned a hard-cap refusal back into a flat charge whenever the selector was
    // inside the model's declared capabilities. It existed because activation was
    // partial. With the v14 rows every reachable combination is covered, so the
    // softener now converts a genuine data hole into a silent overcharge (1080p
    // priced at the 480p-blind flat rate). Removed; the hole must be visible.
    const seedance = {
      ...videoModel,
      capabilities: { resolutions: ['480p', '720p', '1080p'] },
    } satisfies JobPriceModel;

    expect(
      resolveJobPriceFromPoints(seedance, { duration_seconds: 4, resolution: '1080p' }, [p480]),
    ).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('refuses an active price row outside the model capability menu', () => {
    const declared720 = {
      ...videoModel,
      capabilities: { resolutions: ['720p'] },
    } satisfies JobPriceModel;
    expect(
      resolveJobPriceFromPoints(declared720, { duration_seconds: 4, resolution: '3K' }, [
        point({ resolution: '3K', baseCredits: 1 }),
      ]),
    ).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('uses a safe duration floor when capabilities omit durations', () => {
    expect(minBillableDurationSeconds({ resolutions: ['720p'] })).toBeGreaterThanOrEqual(4);
    const r = resolveJobPriceFromPoints(
      { ...videoModel, minDurationSeconds: minBillableDurationSeconds({}) },
      { duration_seconds: 1, resolution: '720p' },
      [p720], // was `[]`; an empty ladder is now a refusal, not a flat charge.
    );
    expect(r.ok && r.price.units).toBeGreaterThanOrEqual(4);
  });

  it('REFUSES when the model has no active points at all (the silent-flat killer)', () => {
    // THE headline change. An empty active-points list used to mean "bill flat",
    // which is how a 128-credit 480p Seedance clip was charged 1600. A price we
    // do not hold is a DATA FAILURE and must be visible, not guessed at.
    expect(
      resolveJobPriceFromPoints(videoModel, { duration_seconds: 4, resolution: '720p' }, []),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('persists the per-image rate for parametric image models (settlement parity)', () => {
    const imageModel: JobPriceModel = {
      id: 'seedream-5-0-pro',
      kind: 'image',
      maxDurationSeconds: null,
    };
    const imagePoint = point({
      modelId: 'seedream-5-0-pro',
      unitKind: 'image',
      resolution: 'default',
      baseCredits: 15,
      baseUnits: 1,
    });
    const r = resolveJobPriceFromPoints(imageModel, { n: 2, quality: 'default' }, [imagePoint]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.price.source).toBe('parametric');
      expect(r.price.cost).toBe(30); // 15 × 2
      expect(r.price.imageUnitCredits).toBe(15);
    }
  });

  it('REFUSES an image model with no active price rows', () => {
    // Inverts the old flat-image settlement assertion: missing rows now refuse.
    const imageModel: JobPriceModel = {
      id: 'flat-image',
      kind: 'image',
      maxDurationSeconds: null,
    };
    expect(resolveJobPriceFromPoints(imageModel, { n: 2 }, [])).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });

  it('surfaces the units error for an invalid request', () => {
    const r = resolveJobPriceFromPoints(videoModel, { resolution: '480p' }, points); // no duration
    expect(r.ok).toBe(false);
  });

  it('derives billable units from the registry contract for a covered model', () => {
    // seedance-2-0 has an OpenRouter route contract (max 15s). The billable seconds
    // now come from that contract via billableVideoUnitsForModel — the SAME normalizer
    // the adapter serializes with — so billed == served. This 14s request bills 14
    // (the contract's authority), which also proves the registry path is engaged.
    const r = resolveJobPriceFromPoints(videoModel, { duration_seconds: 14, resolution: '720p' }, [
      p720, // was `[]`; an empty ladder is now a refusal, so price it from a real row.
    ]);
    expect(r).toEqual({
      ok: true,
      price: { cost: 280, units: 14, imageUnitCredits: null, source: 'parametric' }, // 100/5 × 14
    });
  });
});

/**
 * DoD 6 (partial) — off-contract requests are REJECTED on the shared price path.
 * Both the estimate (jobs-routes) and submit endpoints call resolveJobPrice, which
 * for a covered model derives units from the registry contract, so an off-contract
 * request is rejected IDENTICALLY on both — unified estimate+submit validation for
 * the value surface. (The request-schema key tightening is a separate step.)
 */
describe('off-contract requests are rejected via the shared price path', () => {
  const veoModel: JobPriceModel = {
    id: 'veo-3-1',
    kind: 'video',
    maxDurationSeconds: 8,
    minDurationSeconds: 4,
    capabilities: { resolutions: ['720p', '1080p'] },
  };
  const wanModel: JobPriceModel = {
    id: 'wan-2-7',
    kind: 'video',
    maxDurationSeconds: 10,
    minDurationSeconds: 4,
    capabilities: { resolutions: ['720p', '1080p'] },
  };

  it('veo 4K is refused (priced but inactive; contract reject-list is unwired)', () => {
    expect(
      resolveJobPriceFromPoints(veoModel, { resolution: '4K', duration_seconds: 8 }, []).ok,
    ).toBe(false);
  });

  it('a duration above the route maximum is refused, not clamp-charged', () => {
    // Wan's kie primary rejects >10s; the flat biller would have capped-and-charged 10.
    expect(
      resolveJobPriceFromPoints(wanModel, { duration_seconds: 12, resolution: '720p' }, []).ok,
    ).toBe(false);
  });

  it('an in-contract veo request still prices normally', () => {
    // v14 `Сетка FX!AA10/AB10`: 913 credits per 8s clip at 1080p. Was asserted
    // against the flat 8 × 280 fallback with `[]` points, which now refuses.
    const r = resolveJobPriceFromPoints(veoModel, { duration_seconds: 8, resolution: '1080p' }, [
      point({ modelId: 'veo-3-1', resolution: '1080p', baseCredits: 913, baseUnits: 8 }),
    ]);
    expect(r).toEqual({
      ok: true,
      price: { cost: 913, units: 8, imageUnitCredits: null, source: 'parametric' },
    });
  });
});

/**
 * Brief D supersedes the former carve-out. These cases invert its old flat
 * assertions: matching rows price parametrically and missing rows refuse.
 */
describe('flat carve-out removed', () => {
  const withCaps: JobPriceModel = {
    ...videoModel,
    capabilities: { resolutions: ['480p', '720p', '1080p'] },
  };

  it('inverts the former flat carve-out: video input is refused without an active priced row', () => {
    // «Параметрика A38» bills ×(input+output) seconds, but no media duration
    // exists anywhere in packages/db/schema/* — the input leg is unbillable.
    const r = resolveJobPriceFromPoints(
      withCaps,
      { duration_seconds: 4, resolution: '720p', videoUrls: ['ref.mp4'] },
      [p480, p720, p1080],
    );
    expect(r).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('inverts the former flat carve-out: r2v image-only input uses its active mirror row', () => {
    // Matches the WHOLE r2v model id, not just its with-video mode — so the
    // image-only mirror rows (owner ruling 5) are caught by it too, even active.
    const r2vModel: JobPriceModel = { ...withCaps, id: 'seedance-2-0-reference-to-video' };
    const matchingMirrorRow = point({
      modelId: 'seedance-2-0-reference-to-video',
      resolution: '720p',
      videoInput: false,
      baseCredits: 999,
    });
    const r = resolveJobPriceFromPoints(
      r2vModel,
      { duration_seconds: 4, resolution: '720p', imageUrls: ['reference.png'] },
      [matchingMirrorRow],
    );
    expect(r).toEqual({
      ok: true,
      price: { cost: 800, units: 4, imageUnitCredits: null, source: 'parametric' },
    });
  });

  it('inverts the former flat carve-out: a resolution-free video request is refused', () => {
    // No resolution renders at the provider default, which maps to no priced
    // row — bill flat rather than let a crafted request pick a row.
    const r = resolveJobPriceFromPoints(withCaps, { duration_seconds: 4 }, [p480, p720, p1080]);
    expect(r).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('resolutionlessVideo EXEMPTS a model with an explicitly empty resolutions list (Gemini Omni)', () => {
    // The one documented exception: `resolutions: []` means no resolution
    // dimension exists at all, so a resolution-less request is correct — the
    // model's own `default` row prices it normally, not flat.
    const omniModel: JobPriceModel = {
      ...videoModel,
      id: 'gemini-omni-flash',
      capabilities: { resolutions: [] },
    };
    const defaultPoint = point({
      modelId: 'gemini-omni-flash',
      resolution: 'default',
      baseCredits: 273,
      baseUnits: 8,
    });
    const r = resolveJobPriceFromPoints(omniModel, { duration_seconds: 8 }, [defaultPoint]);
    expect(r).toEqual({
      ok: true,
      price: { cost: 273, units: 8, imageUnitCredits: null, source: 'parametric' },
    });
  });
});

describe('adapter-level image price/serve conformance', () => {
  const gptImageSpec = (params: Record<string, unknown>): WorkflowSpec => ({
    modelId: 'gpt-image-2',
    providerModelId: 'gpt-image-2',
    providerEndpoint: '/v1/images/generations',
    kind: 'image',
    prompt: 'a priced test image',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  });

  it('fans out n=2 into two real provider calls, yielding two assets', async () => {
    const imagesGenerations = vi.fn().mockResolvedValue({ data: [{ b64_json: 'AA==' }] });
    const adapter = new LaozhangAdapter({ imagesGenerations } as unknown as LaozhangClient);
    const spec = gptImageSpec({ n: 2, resolution: 'medium' });

    const result = await adapter.awaitResult(await adapter.generate(spec), spec);

    expect(imagesGenerations).toHaveBeenCalledTimes(2);
    expect(imagesGenerations).toHaveBeenNthCalledWith(1, {
      model: 'gpt-image-2-vip',
      prompt: 'a priced test image',
      quality: 'medium',
    });
    expect(result.assets).toHaveLength(2);
  });

  it('uses the fallback adapter after primary failure and serializes that leg’s priced tier', async () => {
    const primary = new LaozhangAdapter({
      imagesGenerations: vi.fn(() => Promise.reject(new Error('laozhang submit failed'))),
    } as unknown as LaozhangClient);
    const createTask = vi.fn().mockResolvedValue({ code: 200, data: { taskId: 'kie-high' } });
    const fallback = new KieAdapter(
      {
        createTask,
        recordInfo: vi.fn().mockResolvedValue({
          data: { state: 'success', resultJson: JSON.stringify({ resultUrls: ['mock://high'] }) },
        }),
        fetchAsset: vi.fn().mockResolvedValue({
          bytes: Buffer.from([137, 80, 78, 71]),
          contentType: 'image/png',
        }),
      } as unknown as KieClient,
      { pollBackoffMs: [0] },
    );
    const adapter = new CircuitBreakerAdapter(primary, fallback, 'laozhang', 'kie');
    const spec = gptImageSpec({ n: 1, resolution: 'high' });

    const result = await adapter.awaitResult(await adapter.generate(spec), spec);

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith({
      model: 'gpt-image-2-text-to-image',
      input: { prompt: 'a priced test image', quality: 'high' },
    });
    expect(result.meta).toMatchObject({
      servedBy: 'kie',
      fallbackDepth: 1,
      fellBackFrom: 'laozhang',
    });
    expect(result.assets).toHaveLength(1);
  });

  it('passes gpt-image-2 edit quality to the multipart client call', async () => {
    const imagesEdits = vi.fn().mockResolvedValue({ data: [{ b64_json: 'AA==' }] });
    const adapter = new LaozhangAdapter({
      fetchAsBase64: vi.fn().mockResolvedValue({ data: 'AA==', mimeType: 'image/png' }),
      imagesEdits,
    } as unknown as LaozhangClient);
    const spec = gptImageSpec({
      n: 1,
      resolution: 'high',
      imageUrls: ['https://example.test/reference.png'],
    });

    await adapter.generate(spec);

    // LaozhangClient.imagesEdits is the multipart boundary; this mock proves the
    // adapter reaches that path and carries the quality field into it without egress.
    expect(imagesEdits).toHaveBeenCalledWith({
      model: 'gpt-image-2-vip',
      prompt: 'a priced test image',
      quality: 'high',
      images: [
        {
          bytes: Buffer.from([0]),
          contentType: 'image/png',
          filename: 'ref-0.png',
        },
      ],
    });
  });
});

/**
 * Catalogue regression: reachability is derived from the product-facing seed
 * capabilities, while the expected price comes from the active SSOT ladder.
 * Do not derive the matrix from price points: an activated model without a
 * matching row must make this test fail.
 */
describe('active catalogue price matrix', () => {
  const activeModels = seedModels.filter((model) => model.isActive);
  const activePoints = PRICE_POINT_SEED.filter((point) => point.isActive);

  const asJobPriceModel = (model: (typeof seedModels)[number]) =>
    ({
      id: model.id,
      kind: model.kind,
      maxDurationSeconds: model.maxDurationSeconds,
      capabilities: model.capabilities,
    }) satisfies JobPriceModel;

  const declaredResolutions = (model: (typeof seedModels)[number]) => {
    const resolutions = model.capabilities?.resolutions;
    return Array.isArray(resolutions) && resolutions.length > 0 ? resolutions : ['default'];
  };

  const declaredDurations = (model: (typeof seedModels)[number]) => {
    const durations = model.capabilities?.durations;
    return Array.isArray(durations)
      ? durations.filter(
          (duration): duration is number =>
            typeof duration === 'number' &&
            (model.maxDurationSeconds == null || duration <= model.maxDurationSeconds),
        )
      : [];
  };

  const primaryGatewayFor = (model: (typeof seedModels)[number]) => {
    const contract = byteplusRouteContracts[model.id]?.find((route) => route.role === 'primary');
    if (contract) return contract.gateway;

    const forceGateway = (model.capabilities as Record<string, unknown> | null)?.['forceGateway'];
    if (forceGateway === 'kie') return 'kie';
    if (forceGateway === 'nanobanana') return 'laozhang';
    if (forceGateway === 'openrouter') return 'openrouter';
    if (model.providerModelId?.includes('/')) return 'openrouter';
    throw new Error(`${model.id}: no primary adapter route`);
  };

  const specFor = (
    model: (typeof seedModels)[number],
    params: Record<string, unknown>,
    referenceAssets: string[] = [],
  ): WorkflowSpec => ({
    modelId: model.id,
    providerModelId: model.providerModelId ?? '',
    providerEndpoint: model.providerEndpoint ?? '',
    kind: model.kind,
    prompt: 'catalogue price/serve conformance',
    params,
    referenceAssets,
    maxDurationSeconds: model.maxDurationSeconds,
    capabilities: model.capabilities,
  });

  const adapterBodyForGateway = (
    model: (typeof seedModels)[number],
    gateway: string,
    params: Record<string, unknown>,
    referenceAssets: string[] = [],
  ) => {
    const spec = specFor(model, params, referenceAssets);
    switch (gateway) {
      case 'kie':
        return model.id.startsWith('veo-') ? buildKieVeoBody(spec) : buildKieVideoOrImageBody(spec);
      case 'laozhang':
        return buildLaozhangImageBody(spec);
      case 'openrouter':
        return model.kind === 'video'
          ? buildOpenRouterVideoBody(spec)
          : buildOpenRouterImageBody(spec);
      default:
        throw new Error(`${model.id}: primary route has no local body builder`);
    }
  };

  const adapterBodyFor = (model: (typeof seedModels)[number], params: Record<string, unknown>) =>
    adapterBodyForGateway(model, primaryGatewayFor(model), params);

  const buildKieVideoOrImageBody = (spec: WorkflowSpec) =>
    spec.kind === 'video' ? buildKieVideoBody(spec) : buildKieImageBody(spec);

  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

  const imageWireDimension = (
    model: (typeof seedModels)[number],
    gateway: string,
    resolution: string,
  ) => {
    // Kie maps Seedream 4.5's sellable 2K/4K tiers to `basic`/`high`.
    if (gateway === 'kie' && model.id === 'seedream-4-5')
      return resolution === '4K' ? 'high' : 'basic';
    // These provider quality enums are the on-wire names for the catalog tiers.
    if (gateway === 'kie' && model.id === 'seedream-5-0-pro')
      return resolution === '1K' ? 'basic' : 'high';
    if (gateway === 'kie' && model.id === 'seedream-5-0-lite') {
      return resolution === '4K' ? 'ultra' : resolution === '3K' ? 'high' : 'basic';
    }
    // FLUX on kie sold no size control until rev. 14 — one sizeless `default` rung, and
    // `buildKieImageBody` pinned '1K' because kie's `resolution` field is REQUIRED. rev.
    // 13 signed a 2K rung at a MEASURED $0,035 and rev. 14 re-banded the cheap one
    // `default` → `1K`, so both are declared, both are priced, and the adapter reads the
    // ask. The tier we serve is the tier we bill either way; what changed is that there
    // are now two of them.
    //
    // A route that declares NO size menu cannot carry a rung on the wire, and this
    // reads that from the contract rather than exempting a model by name. It is not a
    // softening of billed==served: a sizeless route is a FALLBACK on every model that
    // has one, so the tier is still served by the charged primary. What it does record
    // is that a failed-over job returns the vendor's default size — the open exposure
    // documented on `buildOpenRouterImageBody`, which the paid OpenRouter 2K call closes.
    const routeMenu = (byteplusRouteContracts[model.id] ?? []).find(
      (route) => route.gateway === gateway && route.inputMode === 'image',
    )?.resolution;
    if (routeMenu && routeMenu.values.length === 0) return undefined;
    return resolution === 'default' ? undefined : resolution;
  };

  const imageDimensionFromBody = (
    model: (typeof seedModels)[number],
    gateway: string,
    body: Record<string, unknown>,
  ) => {
    switch (gateway) {
      case 'kie': {
        const input = asRecord(body['input']);
        return input['resolution'] ?? input['quality'];
      }
      case 'laozhang': {
        if (model.id === 'gpt-image-2') return body['quality'];
        return asRecord(asRecord(body['generationConfig'])['imageConfig'])['imageSize'];
      }
      case 'openrouter':
        return body['resolution'];
      default:
        return undefined;
    }
  };

  const videoDimensionFromBody = (
    model: (typeof seedModels)[number],
    body: Record<string, unknown>,
  ) => {
    if (primaryGatewayFor(model) === 'kie' && model.id.startsWith('veo-')) {
      return { resolution: body['resolution'], duration: body['duration'] };
    }
    const input = primaryGatewayFor(model) === 'kie' ? asRecord(body['input']) : body;
    return { resolution: input['resolution'], duration: input['duration'] };
  };

  it('prices every active model and reachable resolution/duration combination parametrically', () => {
    expect(activeModels).not.toHaveLength(0);

    for (const model of activeModels) {
      const points = activePoints.filter((point) => point.modelId === model.id);
      expect(points, `${model.id} needs an active price row`).not.toHaveLength(0);

      for (const resolution of declaredResolutions(model)) {
        const rungPoints = points.filter(
          (point) => point.resolution === resolution && point.videoInput === false,
        );
        // A rung may carry several rows: audio is a priced user lever on Kling
        // ($0.126 per second with sound, $0.084 without), Wan prices i2v above t2v,
        // and the image models price a multi-reference band above the plain render.
        // What must stay true is that no two rows describe the SAME request — that
        // would be two prices for one job, which the kernel refuses rather than
        // resolves. The identity is the whole widened key.
        const identities = new Set(
          rungPoints.map((point) => `${point.audio}|${point.mode}|${point.refsMin}`),
        );
        expect(
          identities.size,
          `${model.id} ${resolution} has ${rungPoints.length} active rows but only ${identities.size} distinct request shapes`,
        ).toBe(rungPoints.length);

        // The walk below sends a PLAIN request — no frames, no references — so only
        // the rows that can serve one are candidates. A mode row or a reference band
        // is a different request, priced in its own test.
        const matchingPoints = rungPoints.filter(
          (point) => point.mode === 'any' && point.refsMin === 0,
        );
        const audioStates = new Set(matchingPoints.map((point) => point.audio));
        expect(
          audioStates.size,
          `${model.id} ${resolution} has ${matchingPoints.length} plain rows in ${audioStates.size} audio states`,
        ).toBe(matchingPoints.length);
        expect(
          matchingPoints.length,
          `${model.id} ${resolution} needs an active price row`,
        ).toBeGreaterThan(0);
        // The rest of this case walks the dearer configuration: it is the one the
        // adapter runs by default, so a rung that prices correctly there prices
        // correctly for the quiet variant too.
        const matchingPoint = [...matchingPoints].sort((a, b) => b.baseCredits - a.baseCredits)[0];
        expect(matchingPoint, `${model.id} ${resolution} needs an active price row`).toBeDefined();
        if (!matchingPoint) continue;

        const units = model.kind === 'video' ? declaredDurations(model) : [2];
        expect(units, `${model.id} needs reachable billable units`).not.toHaveLength(0);

        for (const unitCount of units) {
          const params =
            model.kind === 'video'
              ? {
                  duration_seconds: unitCount,
                  ...(resolution === 'default' ? {} : { resolution }),
                }
              : {
                  n: unitCount,
                  ...(resolution === 'default' ? {} : { quality: resolution }),
                };
          const expected = matchingPoint.flatRate
            ? matchingPoint.baseCredits
            : Math.ceil((matchingPoint.baseCredits * unitCount) / matchingPoint.baseUnits);

          const estimate = resolveJobPriceFromPoints(asJobPriceModel(model), params, points);
          const charge = resolveJobPriceFromPoints(asJobPriceModel(model), params, points);

          expect(estimate, `${model.id} ${resolution} × ${unitCount}`).toEqual({
            ok: true,
            price: {
              cost: expected,
              units: unitCount,
              imageUnitCredits:
                matchingPoint.unitKind === 'image' ? matchingPoint.baseCredits : null,
              source: 'parametric',
            },
          });
          expect(charge).toEqual(estimate); // estimate == charge on the shared resolver

          const body = adapterBodyFor(model, params);
          if (model.kind === 'video') {
            const contracts = byteplusRouteContracts[model.id];
            expect(contracts, `${model.id} needs a primary video contract`).toBeDefined();
            if (!contracts) continue;
            const primary = contracts.find((route) => route.role === 'primary');
            expect(primary, `${model.id} needs a primary video contract`).toBeDefined();
            if (!primary) continue;

            const served = normalizeVideoParams(primary, params);
            const billed = billableVideoUnitsForModel(contracts, params);
            expect(served, `${model.id} ${resolution} × ${unitCount}: normalizes`).toMatchObject({
              ok: true,
            });
            expect(
              billed,
              `${model.id} ${resolution} × ${unitCount}: bills served duration`,
            ).toEqual({
              ok: true,
              units: unitCount,
            });
            if (!served.ok) continue;

            const wire = videoDimensionFromBody(model, body);
            expect(
              Number(wire.duration),
              `${model.id} ${resolution} × ${unitCount}: served duration`,
            ).toBe(served.value.duration);
            if (primary.resolution && primary.resolution.values.length > 0) {
              expect(
                wire.resolution,
                `${model.id} ${resolution} × ${unitCount}: served resolution`,
              ).toBe(served.value.resolution);
            } else {
              // Gemini Omni declares resolutions:[] and is priced on the default row;
              // Kie still requires its own fixed output-resolution field.
              expect(matchingPoint.resolution, `${model.id}: default-only price dimension`).toBe(
                'default',
              );
              expect(wire.resolution, `${model.id}: Kie fixed default resolution`).toBe('1080p');
            }
          } else {
            expect(
              imageDimensionFromBody(model, primaryGatewayFor(model), body),
              `${model.id} ${resolution}: served resolution/quality`,
            ).toBe(imageWireDimension(model, primaryGatewayFor(model), resolution));
          }
        }
      }
    }
  });

  it('keeps billed image tiers, reference mode, and output count aligned on every configured route', () => {
    const reference = ['https://assets.example.test/reference.png'];

    for (const model of activeModels.filter((candidate) => candidate.kind === 'image')) {
      const routes = byteplusRouteContracts[model.id]?.filter(
        (route) => route.inputMode === 'image',
      ) ?? [{ gateway: primaryGatewayFor(model), reference: { maxImages: 0 } }];
      const points = activePoints.filter((point) => point.modelId === model.id);

      for (const route of routes) {
        for (const resolution of declaredResolutions(model)) {
          const matchingPoint = points.find(
            (point) =>
              point.resolution === resolution &&
              point.videoInput === false &&
              point.audio === false,
          );
          expect(
            matchingPoint,
            `${model.id} ${resolution} needs an active price row`,
          ).toBeDefined();
          if (!matchingPoint) continue;

          for (const withReference of route.reference.maxImages > 0 ? [false, true] : [false]) {
            const params = {
              n: 2,
              ...(resolution === 'default' ? {} : { resolution }),
              ...(withReference ? { imageUrls: reference } : {}),
            };
            const priced = resolveJobPriceFromPoints(asJobPriceModel(model), params, points);
            expect(priced, `${model.id} ${route.gateway} ${resolution}: price`).toMatchObject({
              ok: true,
              price: {
                cost: Math.ceil((matchingPoint.baseCredits * params.n) / matchingPoint.baseUnits),
                units: params.n,
              },
            });

            const body = adapterBodyForGateway(
              model,
              route.gateway,
              params,
              withReference ? reference : [],
            );
            expect(
              imageDimensionFromBody(model, route.gateway, body),
              `${model.id} ${route.gateway} ${resolution}: served resolution/quality`,
            ).toBe(imageWireDimension(model, route.gateway, resolution));

            if (withReference && route.gateway === 'kie') {
              const input = asRecord(body['input']);
              // Three field names, one meaning: kie's nano-banana-2 / -pro slugs take
              // `image_input`, the lite and seedream slugs take `image_urls`, flux
              // takes `input_urls`.
              const served = input['input_urls'] ?? input['image_urls'] ?? input['image_input'];
              expect(served, `${model.id} kie reference/edit body`).toEqual(reference);
            }
            if (withReference && route.gateway === 'openrouter') {
              expect(
                body['input_references'],
                `${model.id} openrouter reference/edit body`,
              ).toHaveLength(reference.length);
            }
          }
        }
      }
    }
  });

  it('offers only Kie Seedream 5.0 Lite tiers that the routed leg can serve', () => {
    const model = activeModels.find((candidate) => candidate.id === 'seedream-5-0-lite');
    if (!model) throw new Error('seedream-5-0-lite must remain active');
    expect(model.capabilities?.resolutions).toEqual(['2K', '3K', '4K']);
    expect(
      activePoints.some((point) => point.modelId === model.id && point.resolution === '1K'),
    ).toBe(false);
  });

  it('serializes Kie Seedream 5.0 Lite 2K, 3K, and 4K at their served qualities', () => {
    const model = activeModels.find((candidate) => candidate.id === 'seedream-5-0-lite');
    if (!model) throw new Error('seedream-5-0-lite must remain active');

    const at2K = adapterBodyFor(model, { n: 1, resolution: '2K' });
    const at3K = adapterBodyFor(model, { n: 1, resolution: '3K' });
    const at4K = adapterBodyFor(model, { n: 1, resolution: '4K' });
    expect(asRecord(at2K['input'])['quality']).toBe('basic');
    expect(asRecord(at3K['input'])['quality']).toBe('high');
    expect(asRecord(at4K['input'])['quality']).toBe('ultra');
  });

  it('records the repo’s Seedance kie-branch 4K gap as unreachable and inactive', () => {
    const model = activeModels.find((candidate) => candidate.id === 'seedance-2-0');
    if (!model) throw new Error('seedance-2-0 must remain active');
    const params = { duration_seconds: 4, resolution: '4K' };
    const contracts = byteplusRouteContracts[model.id]!;
    const body = buildKieVideoBody({
      ...specFor(model, params),
      providerModelId: 'seedance-2.0-text-to-video',
    });

    expect(asRecord(body['input'])['resolution']).toBe('720p');
    expect(
      normalizeVideoParams(contracts.find((route) => route.role === 'primary')!, params),
    ).toMatchObject({
      ok: true,
      value: { resolution: '720p' },
    });
    expect(
      activePoints.some((point) => point.modelId === model.id && point.resolution === '4K'),
    ).toBe(false);
    expect(
      PRICE_POINT_SEED.find((point) => point.modelId === model.id && point.resolution === '4K'),
    ).toMatchObject({ isActive: false });
    expect(
      resolveJobPriceFromPoints(
        asJobPriceModel(model),
        params,
        activePoints.filter((point) => point.modelId === model.id),
      ),
    ).toEqual({
      ok: false,
      error: 'config_not_available',
    });
    // This is our Seedance kie-branch allow-list gap: the repo has not established
    // its Seedance 4K enum, so it clamps a crafted 4K request to 720p. The 4K row is
    // deliberately unreachable and inactive until that branch can serve it exactly.
  });

  it('the request chooses audio only where the table prices both states', () => {
    // The invariant used to be «audio is never a client lever», and it was right
    // while every rung carried exactly one audio state. Rev. 11 broke that for
    // Kling: the vendor charges $0.126 per second with sound and $0.084 without,
    // both are seeded, and audio is a real toggle in the UI. So the rule is now
    // narrower rather than gone — the request decides where the table offers a
    // choice, and nowhere else. Deriving it everywhere would refuse a price on
    // every model that declares a lever but is priced on one row (seedance).
    for (const model of activeModels) {
      const points = activePoints.filter((point) => point.modelId === model.id);
      const resolution = declaredResolutions(model)[0];
      const unitCount = model.kind === 'video' ? declaredDurations(model)[0] : 2;
      const params =
        model.kind === 'video'
          ? { duration_seconds: unitCount, ...(resolution === 'default' ? {} : { resolution }) }
          : { n: unitCount, ...(resolution === 'default' ? {} : { quality: resolution }) };

      // Plain rows only: `params` here carries neither frames nor references, so a
      // mode row or a band row is not a candidate and must not count as a second
      // audio state.
      const matching = points.filter(
        (point) =>
          point.resolution === resolution &&
          point.videoInput === false &&
          point.mode === 'any' &&
          point.refsMin === 0,
      );
      const audioStates = new Set(matching.map((point) => point.audio));
      expect(matching.length, `${model.id} ${resolution} has no active row`).toBeGreaterThan(0);
      expect(
        audioStates.size,
        `${model.id} ${resolution} has ${matching.length} rows in ${audioStates.size} audio states`,
      ).toBe(matching.length);

      if (audioStates.size === 1) {
        // One state: the request must not be able to move the price at all.
        expect(
          resolveJobPriceFromPoints(
            asJobPriceModel(model),
            { ...params, generate_audio: false },
            points,
          ),
        ).toEqual(resolveJobPriceFromPoints(asJobPriceModel(model), params, points));
        continue;
      }

      // Both states priced: the flag selects, and the quiet one is cheaper because
      // the vendor rate is. Absent flag bills the audible rate — the adapter's own
      // default, so an omitted field cannot buy the quiet price for an audible job.
      const loud = resolveJobPriceFromPoints(asJobPriceModel(model), params, points);
      const quiet = resolveJobPriceFromPoints(
        asJobPriceModel(model),
        { ...params, generate_audio: false },
        points,
      );
      expect(loud.ok && quiet.ok && quiet.price.cost < loud.price.cost).toBe(true);
      expect(
        resolveJobPriceFromPoints(
          asJobPriceModel(model),
          { ...params, generate_audio: true },
          points,
        ),
      ).toEqual(loud);
    }
  });

  it('refuses an ambiguous fixed-audio ladder instead of honoring a hidden toggle', () => {
    const fixedAudioModel = {
      ...videoModel,
      capabilities: { audio: true, audioControl: false },
    };
    const fixedAudioPoints = [
      point({ audio: true, mode: 'any', refsMin: 0, refsMax: null }),
      point({ audio: false, baseCredits: 10, mode: 'any', refsMin: 0, refsMax: null }),
    ];
    expect(
      resolveJobPriceFromPoints(
        fixedAudioModel,
        {
          duration_seconds: 4,
          resolution: '720p',
          generate_audio: false,
        },
        fixedAudioPoints,
      ),
    ).toEqual({ ok: false, error: 'price_unavailable' });
    expect(
      resolveJobPriceFromPoints(
        fixedAudioModel,
        { duration_seconds: 4, resolution: '720p' },
        fixedAudioPoints,
      ),
    ).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('refuses every inactive configuration with the stable unavailable-config code', () => {
    const inactiveSsotPoints = PRICE_POINT_SEED.filter(
      (candidate) => !candidate.isActive && !candidate.sourceRef.startsWith('derived:'),
    );
    // 10 from v14 (including the two delisted HappyHorse 1.0 rungs) and the 3
    // priced-but-unwired Veo 4K rows. The 2 Kling rungs that
    // used to be here are GONE, not inactive: rev. 11 withdrew 1080p and 4K, which
    // priced rungs `resolutions: ['720p']` never offered.
    // This is the assertion that proves an inactive rung is REFUSED rather than
    // merely absent from the picker.
    expect(inactiveSsotPoints).toHaveLength(14);

    const refusals: string[] = [];
    for (const point of inactiveSsotPoints) {
      const model = seedModels.find((candidate) => candidate.id === point.modelId);
      expect(model, `${point.modelId} must remain in the seed roster`).toBeDefined();
      if (!model) continue;

      const params =
        model.kind === 'video'
          ? {
              duration_seconds: declaredDurations(model)[0] ?? 4,
              resolution: point.resolution,
              ...(point.videoInput ? { videoUrls: ['unbillable-input.mp4'] } : {}),
            }
          : { n: 1, quality: point.resolution };
      const points = activePoints.filter((candidate) => candidate.modelId === model.id);
      if (point.modelId === 'flux-2-pro') {
        // The retired band is inactive but the plain 1K row still serves this rung.
        const result = resolveJobPriceFromPoints(
          asJobPriceModel(model),
          { ...params, imageUrls: ['https://example.test/a.png', 'https://example.test/b.png'] },
          points,
        );
        expect(result.ok).toBe(true);
        expect(result.ok ? result.price.cost : null).toBe(11);
        continue;
      }

      const result = resolveJobPriceFromPoints(asJobPriceModel(model), params, points);
      expect(result.ok, `${point.modelId} @ ${point.resolution} must be refused`).toBe(false);
      refusals.push(
        `${point.modelId}|${point.resolution} -> ${(result as { error: string }).error}`,
      );
    }

    // Every inactive rung is refused — that is the invariant. WHICH layer refuses
    // is a second, weaker fact worth pinning separately: `normalizeVideoParams`
    // rejects a rung the route contract's resolution enum excludes, and everything
    // else falls through to the price matrix. A rung that switches layer means a
    // route contract changed underneath us, which should be seen, not absorbed.
    expect(refusals.sort()).toEqual([
      'happyhorse-1-0|1080p -> price_unavailable',
      'happyhorse-1-0|720p -> price_unavailable',
      'seedance-2-0-fast-reference-to-video|480p -> config_not_available',
      'seedance-2-0-fast-reference-to-video|720p -> config_not_available',
      'seedance-2-0-reference-to-video|1080p -> config_not_available',
      'seedance-2-0-reference-to-video|480p -> config_not_available',
      'seedance-2-0-reference-to-video|4K -> config_not_available',
      'seedance-2-0-reference-to-video|720p -> config_not_available',
      'seedance-2-0|4K -> config_not_available',
      'seedream-4-5|1K -> config_not_available',
      "veo-3-1-fast|4K -> resolution '4K' not accepted",
      "veo-3-1-lite|4K -> resolution '4K' not accepted",
      "veo-3-1|4K -> resolution '4K' not accepted",
    ]);
  });

  it('refuses video input and prices image-only references on both r2v models', () => {
    for (const id of ['seedance-2-0-reference-to-video', 'seedance-2-0-fast-reference-to-video']) {
      const model = seedModels.find((candidate) => candidate.id === id);
      expect(model).toBeDefined();
      if (!model) continue;
      const resolution = declaredResolutions(model)[0] as string;
      const duration = declaredDurations(model)[0] as number;
      const points = activePoints.filter((point) => point.modelId === id);

      expect(
        resolveJobPriceFromPoints(
          asJobPriceModel(model),
          { duration_seconds: duration, resolution, videoUrls: ['unbillable-input.mp4'] },
          points,
        ),
      ).toEqual({ ok: false, error: 'config_not_available' });
      expect(
        resolveJobPriceFromPoints(
          asJobPriceModel(model),
          { duration_seconds: duration, resolution, imageUrls: ['reference.png'] },
          points,
        ),
      ).toMatchObject({ ok: true, price: { source: 'parametric' } });
    }
  });
});

/**
 * The five configurations the widened price key exists for. Each one is a request
 * shape the four-column key could not tell from a cheaper one, so each assertion here
 * is money: without the mode/band selection every case below quotes the plain row.
 */
describe('mode and reference band select the signed row', () => {
  const points = (modelId: string) =>
    PRICE_POINT_SEED.filter((point) => point.isActive && point.modelId === modelId);
  const modelFor = (modelId: string) => {
    const model = seedModels.find((candidate) => candidate.id === modelId);
    if (!model) throw new Error(`${modelId} left the seed roster`);
    return {
      id: model.id,
      kind: model.kind,
      maxDurationSeconds: model.maxDurationSeconds,
      minDurationSeconds: null,
      capabilities: model.capabilities,
    } satisfies JobPriceModel;
  };
  const cost = (
    modelId: string,
    params: Record<string, unknown>,
    referenceCount?: number,
  ): number | string => {
    const result = resolveJobPriceFromPoints(
      modelFor(modelId),
      params,
      points(modelId),
      referenceCount,
    );
    return result.ok ? result.price.cost : result.error;
  };

  it('Wan charges a framed shot the same as an unframed one — rev. 21', () => {
    // Rev. 10 charged i2v 31% more (214/321) because the kie leg was text-to-video only
    // and a framed shot fell to OpenRouter's dearer meter. `wan/2-7-image-to-video` was
    // wired on 2026-08-11 and a paid call confirmed $0.08/s; rev. 21 sets i2v equal to
    // its t2v twin. 163 and 244 are five-second prices; a four-second clip prorates.
    expect(cost('wan-2-7', { duration_seconds: 5, resolution: '720p' })).toBe(163);
    expect(
      cost('wan-2-7', {
        duration_seconds: 5,
        resolution: '720p',
        frameImages: [{ url: 'https://example.test/first.png', role: 'first' }],
      }),
    ).toBe(163);
    expect(
      cost('wan-2-7', {
        duration_seconds: 5,
        resolution: '1080p',
        frameImages: [{ url: 'https://example.test/first.png', role: 'first' }],
      }),
    ).toBe(244);
    // The legacy /generate channel sends frames as `imageUrls` on a frame-role model.
    // It is the same request and must not be a cheaper one.
    expect(
      cost('wan-2-7', {
        duration_seconds: 5,
        resolution: '720p',
        imageUrls: ['https://example.test/first.png'],
      }),
    ).toBe(163);
  });

  it('a framed shot still SELECTS the i2v row, which equal prices would otherwise hide', () => {
    // With i2v and t2v at the same price, every assertion above passes whether the
    // resolver picks the i2v row or falls through to 'any' — so none of them proves the
    // six-column key still separates the two modes. Perturb the i2v row to a sentinel
    // and the selection becomes visible again. If this ever fails while the prices agree,
    // the i2v row has been shadowed, and it will surface as a silent mispricing the day
    // finance moves one of them.
    const model = modelFor('wan-2-7');
    const perturbed = points('wan-2-7').map((point) =>
      point.mode === 'i2v' && point.resolution === '720p' ? { ...point, baseCredits: 999 } : point,
    );
    const framed = resolveJobPriceFromPoints(
      model,
      {
        duration_seconds: 5,
        resolution: '720p',
        frameImages: [{ url: 'https://example.test/first.png', role: 'first' }],
      },
      perturbed,
    );
    const unframed = resolveJobPriceFromPoints(
      model,
      { duration_seconds: 5, resolution: '720p' },
      perturbed,
    );
    expect(framed.ok && framed.price.cost).toBe(999);
    expect(unframed.ok && unframed.price.cost).toBe(163);
  });

  it('a Run All quote prices an upstream still that has not rendered yet', () => {
    // The board knows a frame WILL be attached before it knows its URL. Pricing that as
    // a plain t2v job is the quote the submit then refuses as stale. Since rev. 21 the
    // two modes cost the same, so this no longer changes the number — it stays because
    // the day they diverge again is the day it matters, and it is the cheaper of the two
    // to get wrong on purpose.
    expect(cost('wan-2-7', { duration_seconds: 5, resolution: '720p' }, 1)).toBe(163);
  });

  it('charges retired Flux references on the plain signed 1K row', () => {
    // The rung is named on every call since rev. 14 made flux a LADDERED model (1K/2K).
    // A request that names no rung keys on the literal default, finds no row, and is
    // refused, which is true of every laddered model here. The UI always sends one.
    expect(cost('flux-2-pro', { n: 1, resolution: '1K' })).toBe(11);
    expect(
      cost('flux-2-pro', { n: 1, resolution: '1K', imageUrls: ['https://example.test/a.png'] }),
    ).toBe(11);
    // The retired premium no longer changes the charge: two references remain flat.
    expect(cost('flux-2-pro', { n: 1, resolution: '1K', imageRefs: 2 })).toBe(11);
    // The new rung, signed at 15 against a measured $0,035.
    expect(cost('flux-2-pro', { n: 1, resolution: '2K' })).toBe(15);
  });

  it('Seedream Pro charges one flat band price anywhere from two to ten references', () => {
    const refs = (count: number) =>
      Array.from({ length: count }, (_, index) => `https://example.test/${index}.png`);
    expect(cost('seedream-5-0-pro', { n: 1, quality: '1K' })).toBe(16);
    expect(cost('seedream-5-0-pro', { n: 1, quality: '1K', imageUrls: refs(1) })).toBe(16);
    for (let count = 2; count <= 10; count += 1) {
      expect(
        cost('seedream-5-0-pro', { n: 1, quality: '1K', imageUrls: refs(count) }),
        `1K at ${count} references`,
      ).toBe(24);
    }
    expect(cost('seedream-5-0-pro', { n: 1, quality: '2K', imageUrls: refs(2) })).toBe(38);
    // Over the model's advertised maximum the count CLAMPS to what we can forward,
    // which keeps the request inside the band it was priced for rather than falling
    // off the end of it into no price at all.
    expect(cost('seedream-5-0-pro', { n: 1, quality: '2K', imageUrls: refs(14) })).toBe(38);
  });

  it('leaves every model finance priced identically across modes on one row', () => {
    // Rev. 11's rule: a mode difference is only real when the modes ROUTE differently.
    // Kling, Grok and Seedance run both modes on the same leg, so one row serves both
    // — and this asserts attaching a frame does not change what we charge there.
    const framed = { frameImages: [{ url: 'https://example.test/f.png', role: 'first' }] };
    expect(cost('kling-v3-0-std', { duration_seconds: 5, resolution: '720p', ...framed })).toBe(
      cost('kling-v3-0-std', { duration_seconds: 5, resolution: '720p' }),
    );
    expect(cost('grok-imagine-video', { duration_seconds: 6, resolution: '720p', ...framed })).toBe(
      cost('grok-imagine-video', { duration_seconds: 6, resolution: '720p' }),
    );
    expect(cost('seedance-2-0', { duration_seconds: 5, resolution: '720p', ...framed })).toBe(
      cost('seedance-2-0', { duration_seconds: 5, resolution: '720p' }),
    );
  });
});

describe('a model that takes no image input is never in an image mode', () => {
  it('prices a crafted reference on Grok as the text-to-video job it can serve', () => {
    // Grok declares `frames: []` — its kie route is text-to-video only. A crafted
    // `imageUrls` on it is a request the adapter refuses, so calling it i2v would
    // send the resolver looking for an i2v price for a configuration that does not
    // exist. The mode follows the CONTRACT, not the payload.
    const grok = seedModels.find((candidate) => candidate.id === 'grok-imagine-video');
    if (!grok) throw new Error('grok left the seed roster');
    const model = {
      id: grok.id,
      kind: grok.kind,
      maxDurationSeconds: grok.maxDurationSeconds,
      capabilities: grok.capabilities,
    } satisfies JobPriceModel;
    expect(priceModeForRequest(model, { imageUrls: ['https://example.test/a.png'] }, 1)).toBe(
      't2v',
    );
    expect(
      priceModeForRequest(
        model,
        { frameImages: [{ role: 'first', url: 'https://example.test/a.png' }] },
        0,
      ),
    ).toBe('t2v');
  });

  it('still derives i2v where the contract says the model takes a frame', () => {
    const wan = seedModels.find((candidate) => candidate.id === 'wan-2-7');
    if (!wan) throw new Error('wan left the seed roster');
    expect(
      priceModeForRequest(
        {
          id: wan.id,
          kind: wan.kind,
          maxDurationSeconds: wan.maxDurationSeconds,
          capabilities: wan.capabilities,
        },
        { frameImages: [{ role: 'first', url: 'https://example.test/a.png' }] },
        0,
      ),
    ).toBe('i2v');
  });
});
