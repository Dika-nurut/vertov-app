import { describe, expect, it } from 'vitest';
import { costLegFile } from '../src/cost-legs-data';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { seedModels } from '../seed/models';

/**
 * Seedance 2.0 Mini on Pixazo (rev. 23). The cost model prices `rate × landed FX ×
 * base seconds`, but Pixazo bills actual output seconds ROUNDED UP and clips run
 * ~0.1 s long, so a d-second request bills d + 1 seconds. The flat model cannot see
 * that, so this test holds the business rule directly: at every duration the product
 * sells (4–15 s), the credits charged clear the standard 25 % floor on the cheapest
 * credit, with the extra second included.
 */
const CREDIT_FLOOR_RUB = 0.331111;
const MARGIN_FLOOR = 0.25;

describe('Seedance 2.0 Mini pricing survives Pixazo’s rounded-up seconds', () => {
  const model = seedModels.find((row) => row.id === 'seedance-2-0-mini');
  const durations = (model?.capabilities as { durations?: number[] } | undefined)?.durations ?? [];

  it('sells 4–15 s on the free tier through the single Pixazo leg', () => {
    expect(model).toBeDefined();
    expect(model!.tierMin).toBe('free');
    expect((model!.capabilities as Record<string, unknown>)['forceGateway']).toBe('pixazo');
    expect(model!.fallbackGateway ?? null).toBeNull();
    expect(Math.min(...durations)).toBe(4);
    expect(Math.max(...durations)).toBe(15);
  });

  for (const rung of ['480p', '720p'] as const) {
    it(`${rung}: every duration clears ${MARGIN_FLOOR * 100}% with the extra billed second`, () => {
      const point = PRICE_POINT_SEED.find(
        (row) => row.modelId === 'seedance-2-0-mini' && row.resolution === rung,
      )!;
      const legs = costLegFile.legs.filter(
        (leg) => leg.modelId === 'seedance-2-0-mini' && leg.rung === rung,
      );
      expect(legs.map((leg) => leg.mode).sort()).toEqual(['i2v', 't2v']);
      for (const leg of legs) {
        expect(leg.relay).toBe('Pixazo');
        expect(leg.credits).toBe(point.baseCredits);
        for (const seconds of durations) {
          const charged = Math.ceil((point.baseCredits * seconds) / point.baseUnits);
          const cost = leg.usdPerUnit * leg.landedRubPerUnit * (seconds + 1);
          const margin = 1 - cost / (charged * CREDIT_FLOOR_RUB);
          expect(margin, `${rung} ${leg.mode} ${seconds}s`).toBeGreaterThanOrEqual(MARGIN_FLOOR);
        }
      }
    });
  }

  it('keeps Mini well under Seedance Fast, so it is a real economy tier', () => {
    const price = (modelId: string, rung: string) =>
      PRICE_POINT_SEED.find((row) => row.modelId === modelId && row.resolution === rung)!
        .baseCredits;
    expect(price('seedance-2-0-mini', '480p')).toBeLessThan(price('seedance-2-0-fast', '480p') / 3);
    expect(price('seedance-2-0-mini', '720p')).toBeLessThan(price('seedance-2-0-fast', '720p') / 3);
  });
});
