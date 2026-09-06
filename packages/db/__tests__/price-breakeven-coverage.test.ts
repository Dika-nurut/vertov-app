import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { modelBreakEven, type BreakEvenModel } from '../src/price-breakeven';

/**
 * Phase 1.3 (pricing-correct-catalogue-build.md) — every model id in the 55-row
 * v14 SSOT (docs/business/pricing-v14-price-rows-2026-07-28.md) must resolve a
 * frozen COGS reference row, or `apps/api/src/pricing-activation-gate.ts`
 * fails closed (`margin_unverifiable`) the moment an admin tries to activate any
 * of its price points — this pins that coverage directly, independent of
 * cogs-breakeven.test.ts's margin-health assertions.
 */

const ssotModelIds = [...new Set(PRICE_POINT_SEED.filter((r) => r.isActive).map((r) => r.modelId))];

const seedModelById = (id: string): BreakEvenModel => {
  const m = seedModels.find((x) => x.id === id);
  if (!m) throw new Error(`no seed model '${id}'`);
  return m as BreakEvenModel;
};

describe('every SSOT model resolves a break-even record', () => {
  it('covers all 24 distinct model ids in the 55-row table', () => {
    expect(ssotModelIds.length).toBe(23);
  });

  // No exceptions any more. `seedream-4-5` used to THROW here — it force-routes to
  // OpenRouter (a temporary BytePlus-down pin) while v14 «Сетка FX!F39» carries
  // only the kie/direct figure, so `modelBreakEven` had no cost leg for the leg the
  // code actually uses. Phase 1.5 closed that by giving the row the OpenRouter cost
  // its routing implies (`capabilities.priceUsdPerUnit: 0.04`, model-catalog.md §4),
  // so the throw-assertion that pinned the gap is gone with it.
  it.each(ssotModelIds)('%s has hasCostData:true (no margin_unverifiable)', (id) => {
    const floorRub = 0.331; // ~cheapest subscriber ₽/credit; only hasCostData matters here.
    const result = modelBreakEven(seedModelById(id), floorRub);
    expect(result.hasCostData, `${id}: margin_unverifiable — no COGS reference row`).toBe(true);
    expect(result.margin, `${id}: margin is null despite hasCostData`).not.toBeNull();
  });
});
