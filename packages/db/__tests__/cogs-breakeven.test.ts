import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { creditFloorRub, modelBreakEven, type BreakEvenModel } from '../src/price-breakeven';

/**
 * COGS break-even guard at REAL routing — the money-path safety net no existing
 * guard provided.
 *
 * Why this exists: `pricing-ladder-v3.json` prices each model off a `channelPrimary`
 * vendor leg that finance ASSUMED (e.g. grok/veo = cheap "direct"/kie). The one
 * reconciliation that was written for this — `cogs-blend.test.ts` — never merged
 * to main (it lives only on the dead `feat/parametric-pricing-design` branch) and,
 * even there, only checks that the catalog AVERAGE blended cost matches a workbook
 * input (±0.002 on the mean): a single deeply-underwater row is invisible, averaged
 * away against profitable ones. The margin guardrail (SC4) checks only the FLAT
 * rate, not these parametric points. So nothing on main catches a below-cost row.
 *
 * The margin math lives in `packages/db/src/price-breakeven.ts` — the SAME module
 * the runtime activation gate imports, so a row cannot pass CI and fail activation
 * (or vice-versa). This test drives it over the seed catalog and pins the outcome.
 *
 * Founder floor semantics: break-even (margin >= 0) at the routed leg — NOT the
 * old 25%/30% margin target.
 *
 * Scope note: the ladder's `costModel` carries ONE reference config per model, so
 * this verifies the per-model reference config — exactly what catches grok/veo.
 */

const floorRub = creditFloorRub(seedSubscriptionTiers);

/** Only active models are required to have an executable workbook cost row.
 * Delisted/withdrawn rows remain in the seed for history but must not re-enter
 * the money path merely because an old ladder snapshot still mentions them. */
const costModelModelIds = [
  ...new Set(seedModels.filter((model) => model.isActive).map((model) => model.id)),
];

const seedModelById = (id: string): BreakEvenModel => {
  const m = seedModels.find((x) => x.id === id);
  if (!m) throw new Error(`cogs-breakeven: no seed model '${id}'`);
  return m as BreakEvenModel;
};

const marginFor = (id: string): number => {
  const result = modelBreakEven(seedModelById(id), floorRub);
  if (!result.hasCostData || result.margin === null) {
    throw new Error(`cogs-breakeven: no COGS data for '${id}'`);
  }
  return result.margin;
};

/**
 * QUARANTINE — models whose REAL-routed reference config sits BELOW break-even.
 * A model priced off the cheap kie leg but routed to dear OpenRouter (slash id,
 * no gatewayOverride) lands here until it is repriced OR pinned to the cheap
 * vendor the ladder assumed (`gatewayOverride='kie'`).
 *
 * EMPTY since 2026-07-19: grok + veo-3-1/-fast/-lite were the four occupants; they
 * are now `gatewayOverride='kie'` in models.ts (live-smoked through the kie adapter),
 * so they route to the kie leg their price was computed on and clear break-even
 * (grok +45%, veo +59–62% on the deliverable 720p rows). Every priced model is now
 * >= break-even at real routing.
 *
 * Self-policing: a NEW model that sinks makes the test go red until justified here.
 */
const KNOWN_BELOW_BREAKEVEN = new Set<string>([]);

describe('COGS break-even at real routing', () => {
  it('derives the revenue floor from the cheapest subscriber rate (~0.331 ₽/cr)', () => {
    // If a cheaper plan is ever seeded, the floor drops and margins must be
    // re-checked — this pins the assumption the whole guard rests on.
    expect(floorRub).toBeCloseTo(0.331, 3);
  });

  it('every price-point model maps to a routable seed model with a cost leg', () => {
    for (const id of costModelModelIds) {
      const result = modelBreakEven(seedModelById(id), floorRub);
      expect(result.hasCostData, `no cost row resolved for ${id}`).toBe(true);
      expect(Number.isFinite(result.margin), `${id} margin not finite`).toBe(true);
    }
  });

  it('no unregistered row loses money at real routing; quarantine stays exact', () => {
    const underwater = costModelModelIds.filter((id) => marginFor(id) < 0);

    const unregistered = underwater.filter((id) => !KNOWN_BELOW_BREAKEVEN.has(id));
    expect(
      unregistered,
      `New below-break-even rows at REAL routing (reprice off the routed vendor, or ` +
        `pin the cheap vendor via gatewayOverride, before activating): ${unregistered.join(', ')}`,
    ).toEqual([]);

    // Keep the list honest: a quarantined model that is now break-even must be removed.
    const nowFine = [...KNOWN_BELOW_BREAKEVEN].filter(
      (id) => costModelModelIds.includes(id) && marginFor(id) >= 0,
    );
    expect(
      nowFine,
      `These now clear break-even — delete them from KNOWN_BELOW_BREAKEVEN: ${nowFine.join(', ')}`,
    ).toEqual([]);
  });

  it('quarantine is empty — every priced model clears break-even at real routing', () => {
    // The four ex-occupants (grok + veo family) now route to kie via
    // gatewayOverride, so nothing needs quarantining. If a model is ever added
    // here, this asserts it has seed rows (so the quarantine names something real).
    for (const id of KNOWN_BELOW_BREAKEVEN) {
      const rows = PRICE_POINT_SEED.filter((r) => r.modelId === id);
      expect(rows.length, `no seed price points for quarantined model ${id}`).toBeGreaterThan(0);
    }
    expect(KNOWN_BELOW_BREAKEVEN.size, 'expected no quarantined models').toBe(0);
    // This CI guard makes it impossible to SEED a money-loser active or ship a new
    // below-cost row unnoticed. The RUNTIME counterpart — refusing a manual
    // activation of a below-break-even row — is the activation gate in
    // apps/api/src/admin-panel.ts, which imports the SAME modelBreakEven() math.
  });

  it('healthy models clear break-even at their real routing', () => {
    const expectedHealthy = [
      'happyhorse-1-1',
      // 'happyhorse-1-0' withdrawn 2026-08-04 (finance ruling Q8).
      'seedance-2-0',
      'seedance-2-0-fast',
      'gemini-omni-flash',
      'seedream-5-0-pro',
      'seedream-5-0-lite',
      'gemini-3-pro-image',
      'gpt-image-2',
      // Now kie-routed (gatewayOverride) → clear break-even on their priced-for leg.
      'grok-imagine-video',
      'veo-3-1',
      'veo-3-1-fast',
      'veo-3-1-lite',
    ];
    for (const id of expectedHealthy) {
      expect(costModelModelIds, `no cost row for ${id}`).toContain(id);
      const margin = marginFor(id);
      expect(
        margin,
        `${id} margin ${(margin * 100).toFixed(1)}% < break-even`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
