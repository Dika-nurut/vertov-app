import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { creditFloorRub, pricePointBreakEven } from '../src/price-breakeven';
import { parseCostLegs } from '../src/cost-legs';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';

/**
 * `capabilities.fallbackUsdPerUnit` is a legacy scalar per model. Finance signs the
 * reserve leg PER RUNG. The runtime now reads the signed workbook export directly;
 * this test remains as a regression guard that no scalar-vs-signed disagreement has
 * re-entered the money path.
 *
 * That matters because `apps/api/src/pricing-activation-gate.ts` blocks activation on
 * `fallback.margin < 0`. The scalar therefore sits directly on a money gate:
 *
 *  - **Flattering** (scalar reads healthier than signed) is the dangerous direction.
 *    `gemini-3-1-flash-image` 4K reads 56.6% where the signed Kie reserve earns 2.3%,
 *    because the scalar carries Kie's 1K rate ($0.04) against a rung Kie bills $0.09 for.
 *    Nothing is leaking today — 2.3% is still positive, so the gate's verdict is right by
 *    luck, not by construction. One reprice turns it into a bypass with no error anywhere.
 *  - **Pessimistic** (scalar reads worse than signed) costs availability, not money:
 *    `seedance-2-0` 480p reads −434.5% against a signed +0.4%, so the gate would refuse
 *    to activate a rung that actually earns.
 *
 * The legacy field is retained only for provider compatibility. It is not consulted by
 * `price-breakeven.ts`; missing signed rows are explicit `uncosted` results.
 *
 *  1. the bypass count is pinned at ZERO and must stay there;
 *  2. the disagreement set is pinned empty, so a future scalar fallback cannot silently
 *     become a second source of economics.
 */

const CSV = readFileSync(join(__dirname, '../seed/cost-legs.csv'), 'utf8');
const legs = parseCostLegs(CSV).legs;
const floor = creditFloorRub(seedSubscriptionTiers);

interface Disagreement {
  label: string;
  guardMargin: number;
  signedMargin: number;
}

/**
 * Every active rung scored by BOTH paths: the old scalar-derived fallback margin and the
 * worst signed reserve leg for the same rung. Rungs the export does not carry a reserve
 * for are skipped — an absent row is the cost-gap question G2 already owns, not this one.
 */
function compareBothPaths(): Disagreement[] {
  const found: Disagreement[] = [];
  for (const model of seedModels.filter((candidate) => candidate.isActive)) {
    const scalar = (model.capabilities as { fallbackUsdPerUnit?: unknown } | null | undefined)
      ?.fallbackUsdPerUnit;
    if (typeof scalar !== 'number') continue;

    for (const point of PRICE_POINT_SEED.filter(
      (candidate) => candidate.modelId === model.id && candidate.isActive,
    )) {
      let scored: ReturnType<typeof pricePointBreakEven>;
      try {
        scored = pricePointBreakEven(model as never, floor, point as never);
      } catch {
        // A model that cannot be scored at all is a different defect; not this guard's.
        continue;
      }
      if (!scored.fallback || scored.fallback.margin === null) continue;

      const rung = point.resolution;
      // Which signed leg is "the reserve"? Under the legacy chain aliases the answer was
      // always нога2. O-1 (2026-09-02) gave rows explicit fallbackGateway pins, and the
      // pin names a RELAY, not a leg number: gemini-3-1-flash-lite-image falls back to
      // kie, which the export prices as нога1 there (finance's own reserve row is
      // LaoZhang). Comparing a pinned kie fallback against a signed LaoZhang row compares
      // two different vendors and cries disagreement forever. So: when the model names an
      // explicit fallback relay, the like-for-like signed row is THAT RELAY's row; the
      // leg===2 rule remains only for chain-alias rows where the reserve is positional.
      const fallbackRelay = (
        model as { fallbackGateway?: string | null } | undefined
      )?.fallbackGateway?.toLowerCase();
      const reserves = legs.filter(
        (leg) =>
          leg.modelId === model.id &&
          (leg.quality ?? leg.rung) === rung &&
          // The REFERENCE BAND is part of the configuration, not a detail of it. Matching
          // on model and rung alone made flux 1K compare the guard against the worst of
          // TWO different products — the plain 0–1 reference row and the 2–8 band, which
          // are separately signed at different rates on different relays — and report a
          // number belonging to neither. A band-specific reserve change would have been
          // attributed to the wrong row.
          (leg.refsMin ?? 0) === (point.refsMin ?? 0) &&
          (fallbackRelay ? leg.relay.trim().toLowerCase() === fallbackRelay : leg.leg === 2) &&
          // rev. 13 emits a нога2 row even where there is NO second relay: the relay cell
          // reads '—' and the margin simply repeats нога1's. Comparing the guard against
          // one of those compares it against the PRIMARY under a reserve's name, which is
          // how gemini-3-pro-image 1K/2K appeared here as fresh "disagreements" that are
          // really the model having one leg. A rung with no reserve has nothing to price.
          leg.relay !== '—',
      );
      if (!reserves.length) continue;

      // The WORST signed reserve, because the gate's question is whether ANY leg the
      // chain can reach loses money — an average would hide exactly the leg that does.
      const signedMargin = Math.min(...reserves.map((leg) => leg.margin));
      if (Math.abs(signedMargin - scored.fallback.margin) <= 0.005) continue;

      found.push({
        label: `${model.id}|${rung}|${point.mode ?? '-'}|refs${point.refsMin ?? 0}`,
        guardMargin: scored.fallback.margin,
        signedMargin,
      });
    }
  }
  return found;
}

describe('the scalar fallback rate vs the signed per-rung reserve', () => {
  const disagreements = compareBothPaths();

  it('NO rung passes the activation gate on a scalar while its signed reserve loses money', () => {
    // The money assertion. `pricing-activation-gate.ts` blocks on `fallback.margin < 0`,
    // so a rung whose scalar reads >= 0 while the signed reserve is < 0 is activatable on
    // a leg finance priced below cost. Zero today — and it must stay zero, because the
    // gate reads the scalar and would never see the signed number.
    const bypasses = disagreements
      .filter((row) => row.guardMargin >= 0 && row.signedMargin < 0)
      .map(
        (row) =>
          `${row.label}: gate sees ${pct(row.guardMargin)}, signed is ${pct(row.signedMargin)}`,
      );
    expect(bypasses).toEqual([]);
  });

  it('has no scalar-vs-signed disagreement in the runtime money path', () => {
    expect(
      disagreements.map(
        (row) => `${row.label}: guard ${pct(row.guardMargin)} vs signed ${pct(row.signedMargin)}`,
      ),
    ).toEqual([]);
  });

  it('keeps the signed chain order for the flash-image ladder', () => {
    // And the routing fact the ladder exposed: finance signs Kie as нога1 at 1K and
    // LaoZhang as нога1 at 2K/4K, so no FLAT chain order can be right for all three
    // rungs. `forceGateway: 'nanobanana'` was flat (laozhang first, always) and 1K
    // therefore sold on the leg finance signed as the RESERVE, at 1,67% instead of
    // 28,49%. Fixed 2026-08-10 by `SIGNED_CHAIN_LEG_ORDER` (@seed/shared), which picks
    // the order per (model, rung); the adapter-side guard is
    // `packages/providers/byteplus/__tests__/signed-chain-leg-order.test.ts`. This
    // assertion stays because it pins the SIGNED order that fix must keep tracking.
    const primaryAt = (rung: string) =>
      legs.find(
        (leg) =>
          leg.modelId === 'gemini-3-1-flash-image' &&
          (leg.quality ?? leg.rung) === rung &&
          leg.leg === 1,
      )?.relay;
    expect(primaryAt('1K')).toBe('Kie');
    expect(primaryAt('2K')).toBe('LaoZhang');
    expect(primaryAt('4K')).toBe('LaoZhang');
  });
});

const pct = (margin: number): string => `${(margin * 100).toFixed(1)}%`;
