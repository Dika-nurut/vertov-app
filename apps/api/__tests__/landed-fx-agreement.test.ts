import { describe, expect, it } from 'vitest';
import { GATEWAY_FX_RUB } from '@seed/db';
import { ASSIST_PRICING } from '@seed/shared';

/**
 * One landed FX, everywhere it is used to turn a vendor dollar into rubles.
 *
 * The pair moved when finance re-based v14 (95.5567/90.5751 off the retired 76.5
 * basis → 106.182/100.6315). Two copies did not move with it: the admin panel's
 * margin display, and — worse, because it sets a real charge — the assist
 * calculator, which is pure cost-plus at the margin floor and was therefore
 * under-pricing every «Сценарий» call by ~11%.
 *
 * Neither copy was wrong when it was written. That is the point of this test: a
 * constant copied out of a source is correct until the day the source moves, and
 * nothing was watching that day. This is the watch. It lives here rather than
 * beside either constant because `@seed/shared` cannot import `@seed/db` without
 * a cycle, and only the API depends on both.
 *
 * The constant is `GATEWAY_FX_RUB`. It was `LANDED_FX` when this test was written
 * (`315c4eda`); the model-catalogue branch renamed it, the merge kept the new name
 * and this file's old import, and the guard has been throwing on `undefined` ever
 * since. `apps/api/tsconfig.json` covers the src tree only, so a dead import in a
 * test is invisible to `tsc --noEmit` — the suite is the only thing that sees it.
 */
describe('landed FX agrees across every package that spends a dollar', () => {
  it('assist prices off the same OpenRouter landed rate the ladder froze', () => {
    // Assist models all run on OpenRouter, so the OR leg is the right one — a
    // direct-leg number here would under-price by the channel spread.
    expect(ASSIST_PRICING.landedRubPerUsd).toBe(GATEWAY_FX_RUB.openrouter);
  });

  it('the two legs are distinct and OpenRouter is the dearer one', () => {
    // Guards against a well-meaning "simplification" collapsing them: the whole
    // reason for two numbers is that the OR top-up is real money.
    expect(GATEWAY_FX_RUB.openrouter).toBeGreaterThan(GATEWAY_FX_RUB.direct);
  });
});
