import { describe, expect, it } from 'vitest';
import {
  computeUnits,
  priceTokens,
  resolveParametricPrice,
  selectPricePoint,
  type PricePoint,
} from '../src/pricing';

// A tiny seedance-shaped ladder: the vendor charges MORE for higher resolution,
// so 480p must resolve to strictly fewer tokens than 1080p at the same duration.
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

describe('computeUnits — billable units', () => {
  it('video bills ceil(output) seconds', () => {
    expect(computeUnits({ kind: 'video' }, { durationSeconds: 4 })).toEqual({ ok: true, units: 4 });
    expect(computeUnits({ kind: 'video' }, { durationSeconds: 4.2 })).toEqual({
      ok: true,
      units: 5,
    });
  });

  it('applies the vendor floor and ceiling', () => {
    expect(computeUnits({ kind: 'video', minDurationSeconds: 3 }, { durationSeconds: 1 })).toEqual({
      ok: true,
      units: 3,
    });
    expect(computeUnits({ kind: 'video', maxDurationSeconds: 8 }, { durationSeconds: 12 })).toEqual(
      {
        ok: true,
        units: 8,
      },
    );
  });

  it('does not read client-supplied input duration for with-video billing', () => {
    expect(
      computeUnits({ kind: 'video' }, { durationSeconds: 5, inputDurationSeconds: 3 } as {
        durationSeconds: number;
      }),
    ).toEqual({
      ok: true,
      units: 5,
    });
  });

  it('refuses a missing output duration', () => {
    expect(computeUnits({ kind: 'video' }, {}).ok).toBe(false);
  });

  it('images bill per generated image, floored at 1', () => {
    expect(computeUnits({ kind: 'image' }, { n: 3 })).toEqual({ ok: true, units: 3 });
    expect(computeUnits({ kind: 'image' }, {})).toEqual({ ok: true, units: 1 });
  });

  it('collapses a non-finite image n to 1 (a crafted Infinity can never inflate units)', () => {
    expect(computeUnits({ kind: 'image' }, { n: Number.POSITIVE_INFINITY })).toEqual({
      ok: true,
      units: 1,
    });
    expect(computeUnits({ kind: 'image' }, { n: Number.NaN })).toEqual({ ok: true, units: 1 });
  });
});

describe('selectPricePoint — exact config match, no silent substitution', () => {
  const points = [p480, p720, p1080];

  it('returns the row whose resolution/videoInput/audio all match', () => {
    expect(selectPricePoint(points, { resolution: '480p' })).toBe(p480);
    expect(selectPricePoint(points, { resolution: '1080p' })).toBe(p1080);
  });

  it('returns undefined for a config with no row (a hard cap, not a substitute)', () => {
    // grok-shaped: only 480p/720p exist — a 1080p ask has no row.
    expect(selectPricePoint([p480, p720], { resolution: '1080p' })).toBeUndefined();
    // a with-video ask never matches a no-video row.
    expect(selectPricePoint(points, { resolution: '720p', videoInput: true })).toBeUndefined();
  });
});

describe('priceTokens — ceil(baseCredits × units / baseUnits), never undercharges', () => {
  it('scales linearly by billed units at the base duration', () => {
    // 100 credits per 5s → 20 credits/s → 4s = 80.
    expect(priceTokens(p720, 4)).toBe(80);
  });

  it('rounds UP a fractional per-second rate so we never undercharge', () => {
    // 220 credits per 5s = 44/s; but 3s = 132 exact; use a non-divisible case:
    expect(priceTokens(point({ baseCredits: 100, baseUnits: 3 }), 4)).toBe(134); // 133.33 → 134
  });

  it('is 0 for non-positive units', () => {
    expect(priceTokens(p720, 0)).toBe(0);
  });

  it('charges a flat-rate price exactly once for every positive duration', () => {
    const clip = point({ unitKind: 'second', flatRate: true, baseCredits: 597, baseUnits: 1 });
    expect(priceTokens(clip, 4)).toBe(597);
    expect(priceTokens(clip, 6)).toBe(597);
    expect(priceTokens(clip, 8)).toBe(597);
  });

  it('validates units before applying the flat charge', () => {
    const clip = point({ unitKind: 'second', flatRate: true, baseCredits: 597, baseUnits: 1 });
    expect(priceTokens(clip, 0)).toBe(0);
    expect(priceTokens(clip, -1)).toBe(0);
    expect(priceTokens(clip, Number.NaN)).toBe(0);
    expect(priceTokens(clip, Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveParametricPrice([clip], { resolution: clip.resolution }, 0)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });
});

describe('perItem reference-image pricing — additive to the selected rung', () => {
  const seedreamPro1K: PricePoint = {
    modelId: 'seedream-5-0-pro',
    resolution: '1K',
    videoInput: false,
    audio: false,
    unitKind: 'image',
    baseCredits: 16,
    baseUnits: 1,
    perItem: { included: 1, creditsPerExtra: 1 },
  };
  const seedreamPro2K: PricePoint = {
    modelId: 'seedream-5-0-pro',
    resolution: '2K',
    videoInput: false,
    audio: false,
    unitKind: 'image',
    baseCredits: 29,
    baseUnits: 1,
    perItem: { included: 1, creditsPerExtra: 1 },
  };

  const quote = (point: PricePoint, units: number, referenceCount: number) =>
    resolveParametricPrice([point], { resolution: point.resolution }, units, referenceCount);

  it.each([
    { point: seedreamPro1K, refs: 1, expected: 16 },
    { point: seedreamPro1K, refs: 4, expected: 19 },
    { point: seedreamPro1K, refs: 10, expected: 25 },
    { point: seedreamPro2K, refs: 1, expected: 29 },
    { point: seedreamPro2K, refs: 4, expected: 32 },
    { point: seedreamPro2K, refs: 10, expected: 38 },
  ])(
    'charges the approved $expected-credit $point.resolution rung at $refs references',
    ({ point, refs, expected }) => {
      expect(quote(point, 1, refs)).toEqual({
        ok: true,
        price: {
          cost: expected,
          imageUnitCredits: expected,
          source: 'parametric',
        },
      });
    },
  );

  it('applies the reference add-on once for every generated image because kie creates one task per image', () => {
    expect(quote(seedreamPro1K, 3, 4)).toEqual({
      ok: true,
      price: {
        cost: 57,
        imageUnitCredits: 19,
        source: 'parametric',
      },
    });
  });

  it('refuses fractional image units instead of violating charge/settlement parity', () => {
    expect(resolveParametricPrice([seedreamPro1K], { resolution: '1K' }, 0.5, 4)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });
});

describe('resolveParametricPrice — the money path', () => {
  it('bills a cheaper resolution at strictly fewer tokens (the whole point)', () => {
    const at480 = resolveParametricPrice([p480, p720, p1080], { resolution: '480p' }, 4);
    const at1080 = resolveParametricPrice([p480, p720, p1080], { resolution: '1080p' }, 4);
    expect(at480.ok && at1080.ok).toBe(true);
    if (!at480.ok || !at1080.ok) return;
    expect(at480.price.source).toBe('parametric');
    expect(at1080.price.source).toBe('parametric');
    expect(at480.price.cost).toBeLessThan(at1080.price.cost);
    // 40/5=8/s → 32 ; 220/5=44/s → 176.
    expect(at480.price.cost).toBe(32);
    expect(at1080.price.cost).toBe(176);
  });

  it('REFUSES when the model has NO active points at all — a missing price is a data failure', () => {
    // This is the mechanism that charged 1600 credits for a 128-credit SKU: an
    // empty ladder once silently fell to a resolution-blind flat rate. A price
    // we do not have must be VISIBLE.
    const r = resolveParametricPrice([], { resolution: '1080p' }, 4);
    expect(r).toEqual({ ok: false, error: 'price_unavailable' });
  });

  it('REFUSES when usable points exist but none matches the requested config (hard cap)', () => {
    // 1080p requested, only 480p/720p seeded — refuse, never flat-charge a config
    // the ladder deliberately does not price (the adapter would silently downgrade).
    const r = resolveParametricPrice([p480, p720], { resolution: '1080p' }, 4);
    expect(r).toEqual({ ok: false, error: 'config_not_available' });
  });

  it('distinguishes "we sell it but have no price" from "we do not sell it"', () => {
    // Two different causes, two different fixes: `price_unavailable` is ours to
    // repair in the price table; `config_not_available` is the client asking for
    // a rung the ladder deliberately does not carry.
    expect(resolveParametricPrice([], { resolution: '720p' }, 4)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
    expect(resolveParametricPrice([p480], { resolution: '720p' }, 4)).toEqual({
      ok: false,
      error: 'config_not_available',
    });
  });

  it('REFUSES a malformed active row (base_credits ≤ 0) instead of flat-charging it', () => {
    // The DB CHECKs (base_credits > 0, base_units > 0) mean a malformed row can
    // only arrive through corruption or a bad migration. That is a data failure
    // and must fail loud, not quietly bill the resolution-blind flat rate.
    const bad = point({ resolution: '720p', baseCredits: 0 });
    expect(resolveParametricPrice([bad], { resolution: '720p' }, 4)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
    // A non-finite base_units row is equally unusable.
    const bad2 = point({ resolution: '720p', baseUnits: Number.NaN });
    expect(resolveParametricPrice([bad2], { resolution: '720p' }, 4)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });

  it('REFUSES when the requested row is malformed even though another row is valid', () => {
    const bad720 = point({ resolution: '720p', baseCredits: 0 });
    expect(resolveParametricPrice([bad720, p1080], { resolution: '720p' }, 4)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });

  it('REFUSES when parametric arithmetic exceeds the sane ceiling', () => {
    // A crafted unit count whose product overflows is not a price we can trust;
    // the old behaviour billed the flat rate for it, which is the same silent
    // substitution this module now refuses everywhere else.
    expect(resolveParametricPrice([p720], { resolution: '720p' }, 1e308)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });

  it('persists the per-image rate for settlement parity on image points only', () => {
    const imagePoint = point({
      unitKind: 'image',
      resolution: 'default',
      baseCredits: 12,
      baseUnits: 1,
    });
    const img = resolveParametricPrice([imagePoint], { resolution: 'default' }, 3);
    expect(img).toEqual({
      ok: true,
      price: { cost: 36, imageUnitCredits: 12, source: 'parametric' },
    });
    // video parametric carries no per-image rate.
    const vid = resolveParametricPrice([p720], { resolution: '720p' }, 4);
    expect(vid.ok && vid.price.imageUnitCredits).toBeNull();
  });
});

describe('flat pricing is unrepresentable', () => {
  it('inverts the former deferred-flat tests: every successful kernel result is parametric', () => {
    // The old tests deliberately exercised deferredFlatPrice. Brief D removes
    // that escape hatch, so a successful price must come from an exact row.
    const result = resolveParametricPrice([p720], { resolution: '720p' }, 4);
    expect(result).toEqual({
      ok: true,
      price: { cost: 80, imageUnitCredits: null, source: 'parametric' },
    });
  });
});

/**
 * Mode and reference band — the two dimensions finance rev. 10 priced and the
 * four-column key could not express. Every existing row means «any mode, any
 * reference count», so adding the axes had to leave those rows selecting exactly
 * as before; these tests pin both halves of that.
 */
describe('mode and reference band selection', () => {
  const image = (over: Partial<PricePoint>): PricePoint => ({
    modelId: 'flux-2-pro',
    resolution: 'default',
    videoInput: false,
    audio: false,
    unitKind: 'image',
    baseCredits: 11,
    baseUnits: 1,
    ...over,
  });

  it('a legacy row with no mode or band still prices every request', () => {
    const legacy = [image({})];
    expect(resolveParametricPrice(legacy, { resolution: 'default' }, 1, 0).ok).toBe(true);
    expect(resolveParametricPrice(legacy, { resolution: 'default', mode: 'i2i' }, 1, 5)).toEqual({
      ok: true,
      price: { cost: 11, imageUnitCredits: 11, source: 'parametric' },
    });
  });

  it('a band prices only its own reference range, and flat inside it', () => {
    const points = [image({}), image({ baseCredits: 13, refsMin: 2, refsMax: 8 })];
    const at = (refs: number) => {
      const result = resolveParametricPrice(points, { resolution: 'default' }, 1, refs);
      return result.ok ? result.price.cost : result.error;
    };
    // 0–1 references are the plain row; 2–8 are the band, at one price throughout.
    expect(at(0)).toBe(11);
    expect(at(1)).toBe(11);
    expect(at(2)).toBe(13);
    expect(at(8)).toBe(13);
    // ABOVE the band the plain row is still unbounded, so it wins by fallback and
    // a 9-reference job would be charged 11. That is not a bug in the kernel — it
    // is what an unbounded row MEANS — but it is a real hole if a band ever stops
    // short of what the model accepts, so the invariant lives with the data: a
    // band must reach the model's `maxRefs`. Flux's does (8 = maxRefs 8), which is
    // why the case below is unreachable in production rather than merely unlikely.
    expect(at(9)).toBe(11);
  });

  it('an exact mode outranks the row that matches any mode', () => {
    const points = [
      image({
        modelId: 'wan-2-7',
        resolution: '720p',
        unitKind: 'second',
        baseCredits: 163,
        baseUnits: 5,
      }),
      image({
        modelId: 'wan-2-7',
        resolution: '720p',
        unitKind: 'second',
        baseCredits: 214,
        baseUnits: 5,
        mode: 'i2v',
      }),
    ];
    const price = (mode: string | undefined) => {
      const result = resolveParametricPrice(
        points,
        { resolution: '720p', ...(mode ? { mode } : {}) },
        5,
        0,
      );
      return result.ok ? result.price.cost : result.error;
    };
    expect(price('t2v')).toBe(163);
    expect(price('i2v')).toBe(214);
    // No derived mode at all falls to the row that prices every mode.
    expect(price(undefined)).toBe(163);
  });

  it('mode beats a band — a row about THIS request outranks one about its inputs', () => {
    const points = [
      image({ baseCredits: 24, refsMin: 2, refsMax: 10 }),
      image({ baseCredits: 30, mode: 'i2i' }),
    ];
    expect(resolveParametricPrice(points, { resolution: 'default', mode: 'i2i' }, 1, 5)).toEqual({
      ok: true,
      price: { cost: 30, imageUnitCredits: 30, source: 'parametric' },
    });
  });

  it('two rows of equal specificity are refused, never resolved by array order', () => {
    // The DB unique key forbids this, so it means corrupt or bypassed data. Picking
    // either would make the charge a function of row order.
    const points = [image({ baseCredits: 11 }), image({ baseCredits: 99 })];
    expect(resolveParametricPrice(points, { resolution: 'default' }, 1, 0)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });

  it('a banded row carrying a per-item term is malformed, not merely odd', () => {
    // The band already covers those references; charging per extra on top would
    // bill them twice, and no reading of such a row is obviously right.
    const points = [
      image({
        baseCredits: 24,
        refsMin: 2,
        refsMax: 10,
        perItem: { included: 1, creditsPerExtra: 1 },
      }),
    ];
    expect(resolveParametricPrice(points, { resolution: 'default' }, 1, 5)).toEqual({
      ok: false,
      error: 'price_unavailable',
    });
  });
});
