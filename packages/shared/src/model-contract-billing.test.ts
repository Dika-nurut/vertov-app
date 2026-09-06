import { describe, expect, it } from 'vitest';
import { normalizeVideoParams } from './model-contract';
import { byteplusRouteContracts } from './model-contract-byteplus';
import { billableVideoUnits, billableVideoUnitsForModel } from './model-contract-billing';
import { unitsForGenerationModel } from './generation-request';

/**
 * BILLED == SERVED invariant at the SELECTOR level (execution plan DoD 3). For every
 * covered route contract, the units we BILL equal the selector's normalized duration
 * (what the wire side will send once adapters derive from the same normalizer), and a
 * request the route would reject is never billed. This pins
 * the pricing side to the same normalizer the wire side will use; it does not yet
 * prove the ADAPTER body agrees (that needs the Phase-4 adapter wiring + a body
 * assertion) nor cover cross-route failover (Phase 3/5). The concrete expected-value
 * cases below make the guarantee non-tautological.
 */
// Valid (finite, positive) durations only — an absent/≤0 duration is not a billable
// video request (asserted separately below), so it is excluded from the equality set.
const DURATIONS = [1, 3, 4, 4.2, 5, 6, 7, 7.6, 8, 9, 10, 11, 15, 16, 100];

describe('billed == served invariant', () => {
  for (const [modelId, routes] of Object.entries(byteplusRouteContracts)) {
    for (const route of routes) {
      describe(`${modelId} @ ${route.gateway}`, () => {
        for (const d of DURATIONS) {
          it(`duration_seconds=${d}: billed matches served (or both reject)`, () => {
            const params = { duration_seconds: d };
            const served = normalizeVideoParams(route, params);
            const billed = billableVideoUnits(route, params);
            if (served.ok && served.value.duration !== undefined) {
              expect(billed.ok).toBe(true);
              if (!billed.ok) return;
              // The core guarantee: charge exactly the delivered seconds.
              expect(billed.units).toBe(served.value.duration);
              // And the served/billed seconds always respect the vendor floor+ceiling.
              expect(billed.units).toBeGreaterThanOrEqual(route.duration!.min);
              expect(billed.units).toBeLessThanOrEqual(route.duration!.max);
            } else {
              // A rejected serialization must not be billable.
              expect(billed.ok).toBe(false);
            }
          });
        }
      });
    }
  }
});

describe('a video charge requires an explicit, positive duration', () => {
  for (const [modelId, routes] of Object.entries(byteplusRouteContracts)) {
    const route = routes.find((r) => r.role === 'primary')!;
    for (const params of [{}, { duration_seconds: 0 }, { duration_seconds: -1 }]) {
      it(`${modelId}: ${JSON.stringify(params)} is not billable`, () => {
        // Unlike the serializer (which may fall back to the contract default), billing
        // must never invent a duration — it rejects, matching unitsForGenerationModel.
        expect(billableVideoUnits(route, params).ok).toBe(false);
      });
    }
  }
});

/**
 * Concrete expected billable units, hand-computed from the contracts (NOT via
 * normalizeVideoParams), so the invariant is not merely "x === x". Each pins the
 * exact charge for a specific route + duration.
 */
describe('billableVideoUnits — concrete expected charges', () => {
  const r = (modelId: string, gateway: string) =>
    byteplusRouteContracts[modelId]!.find((x) => x.gateway === gateway)!;

  const cases: Array<[string, string, number, number | 'reject']> = [
    ['seedance-2-0', 'openrouter', 4.2, 5], // ceil 4.2 → 5, in [4,15]
    ['seedance-2-0', 'kie', 1, 4], // floor to min 4
    ['seedance-2-0', 'openrouter', 100, 15], // clamp to max 15
    ['seedance-2-0', 'kie', 9, 9], // intermediate honored
    ['wan-2-7', 'kie', 7, 7], // kie honors 7
    ['wan-2-7', 'kie', 12, 'reject'], // >max 10 → reject (no charge)
    ['wan-2-7', 'openrouter', 7, 6], // OR snaps 7 → 6 (charge the served 6)
    ['veo-3-1', 'kie', 5.5, 6], // ceil 5.5 → 6, in [4,8]
    ['veo-3-1', 'kie', 100, 'reject'], // >max 8 → reject
    ['grok-imagine-video', 'kie', 3, 6], // floor to the single 6s length
  ];

  for (const [modelId, gateway, d, expected] of cases) {
    it(`${modelId}@${gateway} duration=${d} → ${expected}`, () => {
      const result = billableVideoUnits(r(modelId, gateway), { duration_seconds: d });
      if (expected === 'reject') {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, units: expected });
      }
    });
  }
});

/**
 * The new selector CLOSES the snap-then-bill overcharge the legacy flat biller
 * (unitsForGenerationModel = ceil, no snap, no route-awareness) still has. On a
 * snapping OpenRouter route, a crafted off-menu duration serves fewer seconds than
 * the legacy rule bills; the registry selector bills the served amount instead.
 */
describe('closes the snap-then-bill overcharge', () => {
  it('Wan OpenRouter fallback: legacy bills 7, served+billed is 6', () => {
    const wanOr = byteplusRouteContracts['wan-2-7']!.find((r) => r.gateway === 'openrouter')!;
    const params = { duration_seconds: 7 };
    const served = normalizeVideoParams(wanOr, params);
    expect(served.ok && served.value.duration).toBe(6); // snaps down to the [4,6,8,10] menu
    expect(billableVideoUnits(wanOr, params)).toEqual({ ok: true, units: 6 });
    // Legacy flat biller over-charges by 1s (bills the requested ceil, not the served).
    const legacy = unitsForGenerationModel({
      kind: 'video',
      params,
      maxDurationSeconds: wanOr.duration!.max,
      minDurationSeconds: wanOr.duration!.min,
    });
    expect(legacy).toEqual({ ok: true, units: 7 });
  });

  it('menu-aligned durations agree with the legacy biller (no regression for normal traffic)', () => {
    const seedanceKie = byteplusRouteContracts['seedance-2-0']!.find((r) => r.gateway === 'kie')!;
    for (const d of [4, 6, 8, 10, 15]) {
      const params = { duration_seconds: d };
      const billed = billableVideoUnits(seedanceKie, params);
      const legacy = unitsForGenerationModel({
        kind: 'video',
        params,
        maxDurationSeconds: seedanceKie.duration!.max,
        minDurationSeconds: seedanceKie.duration!.min,
      });
      expect(billed).toEqual(legacy);
    }
  });
});

/**
 * A model is billed from the route that actually serves it — the PRIMARY. Wan's
 * primary (kie) honors intermediate durations, so a 7s ask serves and bills 7s;
 * only the OpenRouter fallback would snap. Billing the primary is correct.
 */
describe('billableVideoUnitsForModel bills the primary route', () => {
  it('Wan is billed from its kie primary (7s → 7s, no snap)', () => {
    const params = { duration_seconds: 7 };
    expect(billableVideoUnitsForModel(byteplusRouteContracts['wan-2-7']!, params)).toEqual({
      ok: true,
      units: 7,
    });
  });

  it('an over-maximum duration on a reject-route is not billable', () => {
    // Wan primary rejects >10s → no charge.
    expect(
      billableVideoUnitsForModel(byteplusRouteContracts['wan-2-7']!, { duration_seconds: 12 }).ok,
    ).toBe(false);
  });
});
