import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED } from '../seed/price-points';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import ladder from '../seed/pricing-ladder-v3.json';
import {
  FALLBACK_MARGIN_FLOOR,
  PRIMARY_MARGIN_FLOOR,
  WORST_DURATION_MARGIN_FLOOR,
} from '../src/margin-floors';
import {
  creditFloorRub,
  modelBreakEven,
  type BreakEvenModel,
  videoDurationMargin,
} from '../src/price-breakeven';

/**
 * SC4 — margin guardrail, rebuilt 2026-07-28 (pricing-correct-catalogue-build.md
 * phase 1.5). A money-losing model must not be shippable.
 *
 * ## What changed, and why the old version could not see the leak
 *
 * The previous guard scored each model as
 * `1 − capabilities.priceUsdPerUnit × 80 / (flatRate × 0.331)`. Three
 * things were wrong with that, all of them load-bearing:
 *
 *  1. **It named no gateway.** `priceUsdPerUnit` was documented as "the worst SKU
 *     we expose", which for `gemini-3-1-flash-image` was the *laozhang* price
 *     ($0.055) while `forceGateway:'nanobanana'` routes laozhang → **kie**, whose
 *     4K rate is $0.09. The guard scored 33% where the kie leg was **−9.4%**
 *     (data audit §3-A1). The dearest leg was invisible by construction.
 *  2. **A raw FX of 80**, with no landed uplift — 26% below the real basis. v14
 *     («Сетка FX!B3/F3/F4») uses FX 85 → landed **106.182 ₽/$** for OpenRouter and
 *     **100.6315 ₽/$** direct. Those live in `pricing-ladder-v3.json` and are what
 *     `price-breakeven.ts` applies, per leg.
 *  3. **It measured the legacy catalog ceiling**, rather than the parametric
 *     rung actually sold by the resolver.
 *
 * So this file no longer does its own arithmetic: it delegates to
 * `packages/db/src/price-breakeven.ts`, the SAME module the runtime activation
 * gate uses, and asserts two separate things — the primary leg clears the
 * workbook's own margin floor, and **failing over does not push a model under
 * water**, which nothing checked before.
 */

/** Shared v14 policy floors («Сетка FX!B5/B6» and the R-1 fallback ruling). */

/**
 * EMPTY, and Kling is why it is worth saying so.
 *
 * It used to excuse Kling: finance priced 720p from a Kie primary at 25.14% while
 * the product actually ran OpenRouter at 0.47%, so the guard judged it at the
 * fallback floor rather than pretend the executable leg earned its target. That
 * exemption was doing real work — it was the only place the gap was visible — but
 * it also let the gap sit for a week.
 *
 * Rev. 11 removed the cause instead of the symptom: there is no Kie Kling route
 * and never was, so the price is now derived from OpenRouter, the leg that runs.
 * The exemption goes with it. If a model ever needs one again, the honest fix is
 * the same — reprice from the leg that exists — and the entry here should be a
 * short-lived record of a repricing in flight, not a standing arrangement.
 */
const DURATION_FLOOR_EXCEPTIONS: ReadonlyMap<
  string,
  { reference: number; worst: number; reason: string }
> = new Map();
/** Cheapest ₽-per-credit any subscriber can obtain = the revenue floor. */
const floorRub = creditFloorRub(seedSubscriptionTiers);

const activeModels = seedModels.filter((m) => m.isActive) as unknown as BreakEvenModel[];

/** Primary legs below the floor require an explicit owner exception. */
const BELOW_PRIMARY_FLOOR = new Set<string>();
// EMPTY again since 2026-09-02: the flash-lite exposure O-1 surfaced (LaoZhang
// first at 15.6% while finance signed Kie нога1 at 32.5%) was resolved by owner
// ruling the same day — migration 0108 pins the row to KIE, the cheaper leg that
// finance itself signs first. The set stays as the place a future below-floor
// leg must be registered visibly, never hidden.

/**
/**
 * The 5%-era `BELOW_FALLBACK_MARGIN_FLOOR` exemption list is deliberately GONE.
 * R-1 set the fallback floor to zero, and every leg that list excused (seedance→kie
 * 0.13%, wan→openrouter 4.2%, omni→atlascloud 0.25%) clears zero on its own. An
 * exemption list that no longer excuses anything is a place for the next one to hide.
 */

/**
 * Fallback legs that EXIST but have no citable per-unit USD cost. Pinned so a new
 * uncosted leg cannot appear silently; an entry here means "unchecked", never
 * "free".
 *
 * EMPTY since 2026-08-04. `happyhorse-1-1` → kie was the last entry: kie published
 * that model only in kie-CREDITS, and the owner's pricing screen supplied the
 * conversion ($0.005/credit, so 1080p 29 cr/s = $0.145). Both legs are now scored.
 *
 * Keep the set and this test even while empty — its job is to fail the moment a
 * new fallback appears without a cost, which is how an unpriced leg would
 * otherwise reach production looking free.
 */
const UNCOSTED_FALLBACK_LEGS = new Set<string>();

describe('SC4: margin guardrail at real routing', () => {
  it('the credit floor is the cheapest subscriber rate (~0.331 ₽/cr)', () => {
    // Guards the assumption: if a cheaper plan is ever added, the floor moves
    // and every margin below must be re-checked.
    expect(floorRub).toBeCloseTo(0.331, 3);
  });

  it('every ACTIVE model resolves a cost leg — none is invisible to the guard', () => {
    // Data audit §3-B8: five active models declared no cost at all and were
    // simply skipped (`seedream-4-5`, `seedance-2-0`, `seedance-2-0-fast`, both
    // `-reference-to-video` rows). Silence is the failure mode this catches.
    const invisible = activeModels
      .filter((m) => {
        try {
          return !modelBreakEven(m, floorRub).hasCostData;
        } catch {
          return true; // a throwing cost leg is also "not checkable"
        }
      })
      .map((m) => m.id);
    expect(invisible, `active models with no resolvable cost leg: ${invisible.join(', ')}`).toEqual(
      [],
    );
  });

  it('no active model sells below the workbook margin floor on the leg it routes to', () => {
    const offenders = activeModels
      .map((m) => ({ id: m.id, r: modelBreakEven(m, floorRub) }))
      .filter(({ r }) => r.margin !== null && r.margin < PRIMARY_MARGIN_FLOOR)
      .map(({ id, r }) => ({ id, margin: r.margin!, family: r.routedFamily }));

    const unregistered = offenders.filter((o) => !BELOW_PRIMARY_FLOOR.has(o.id));
    expect(
      unregistered.map((o) => `${o.id} @ ${(o.margin * 100).toFixed(1)}% on ${o.family}`),
      `Below the ${PRIMARY_MARGIN_FLOOR * 100}% floor («Сетка FX!B5») at floor rate ` +
        `${floorRub.toFixed(3)} ₽/cr. RAISE THE PRICE — do not lower this threshold.`,
    ).toEqual([]);

    // The quarantine stays EXACT: a row that recovers must be removed from the
    // set, or it silently stops being checked.
    const stillOffending = new Set(offenders.map((o) => o.id));
    expect([...BELOW_PRIMARY_FLOOR].filter((id) => !stillOffending.has(id))).toEqual([]);
  });

  it('no fallback leg sells below cost', () => {
    // The check that did not exist. `circuit-breaker-adapter.ts` retries the whole
    // call on the fallback leg before a durable handle exists, so a submit-time
    // primary outage silently moves every job onto a leg nobody priced.
    //
    // The floor is ZERO (ruling R-1), not the 5% this asserted before. A thin reserve
    // is deliberate — finance prices several at break-even, because refusing to fail
    // over turns a vendor outage into ours. The 5% number had no ruling behind it and
    // produced an exemption list of seven honest legs; the list is gone with it, and
    // what remains is the line that actually means something.
    const belowCost = activeModels
      .map((m) => ({ id: m.id, fb: modelBreakEven(m, floorRub).fallback }))
      .filter(({ fb }) => fb?.margin != null && fb.margin < FALLBACK_MARGIN_FLOOR)
      .map(({ id, fb }) => `${id} → ${fb!.gateway} @ ${(fb!.margin! * 100).toFixed(4)}%`);

    expect(
      belowCost,
      'a fallback below 0% is a sale at a loss — R-11 governs that with a spend cap, ' +
        'not by quietly pricing it in',
    ).toEqual([]);
  });

  it('a fallback leg with no cost figure is a KNOWN gap, not a silent one', () => {
    const uncosted = activeModels
      .map((m) => ({ id: m.id, fb: modelBreakEven(m, floorRub).fallback }))
      .filter(({ fb }) => fb !== null && fb.costPerCredit === null)
      .map(({ id }) => id);
    expect(uncosted.sort()).toEqual([...UNCOSTED_FALLBACK_LEGS].sort());
  });
});

// Characterization guard: each case derives its price from the seeded rows, so a
// change to either band — or a return of the per-item term the band replaced — goes red.
describe('Seedream 5.0 Pro reference-image pricing ruling', () => {
  // kie's published rates: $0.035 (1K) / $0.07 (2K) for the render, plus $0.0025 for
  // every input image past the first. The band is priced at its WORST count, which is
  // what makes one flat number safe for the whole band.
  const rungs = [
    {
      resolution: '1K',
      baseCostUsd: 0.035,
      plainPrice: 16,
      bandPrice: 24,
      signedBandMargin: 0.271857,
    },
    {
      resolution: '2K',
      baseCostUsd: 0.07,
      plainPrice: 31,
      bandPrice: 38,
      signedBandMargin: 0.260193,
    },
  ] as const;

  const marginAt = (priceCredits: number, references: number, baseCostUsd: number): number => {
    const costRub = (baseCostUsd + Math.max(0, references - 1) * 0.0025) * ladder.fx.direct;
    return 1 - costRub / (priceCredits * floorRub);
  };

  it('carries no per-item term anywhere — the band replaced it', () => {
    // The term metered $0.0025 per extra image on top of the plain rung, because the
    // four-column key could not say «this is the 2–10 configuration». It can now, and
    // the two must never coexist: the band already covers the worst count, so adding
    // the term on top charges the same surcharge twice. The kernel refuses a row
    // carrying both — this asserts the seed never builds one.
    expect(PRICE_POINT_SEED.filter((row) => row.perItem !== null)).toEqual([]);
    expect(PRICE_POINT_SEED.filter((row) => row.refsMin > 0 && row.perItem !== null)).toEqual([]);
  });

  it.each(rungs)(
    '$resolution prices the two reference configurations separately',
    ({ resolution, plainPrice, bandPrice }) => {
      const rows = PRICE_POINT_SEED.filter(
        (row) =>
          row.modelId === 'seedream-5-0-pro' &&
          row.resolution === resolution &&
          row.isActive &&
          !row.videoInput &&
          !row.audio,
      );
      expect(rows.map((row) => [row.refsMin, row.refsMax, row.baseCredits])).toEqual([
        [0, null, plainPrice],
        [2, 10, bandPrice],
      ]);
    },
  );

  it.each(rungs)(
    '$resolution earns at least the signed margin ANYWHERE in the 2–10 band',
    ({ resolution, baseCostUsd, bandPrice, signedBandMargin }) => {
      // A flat band price is only safe if its thinnest point clears the floor, and its
      // thinnest point is the dearest request: ten images, nine of them metered. That
      // is the number finance signed, so the band bottom IS the signed margin.
      const worst = marginAt(bandPrice, 10, baseCostUsd);
      expect(worst).toBeCloseTo(signedBandMargin, 5);
      for (let references = 2; references <= 10; references += 1) {
        expect(
          marginAt(bandPrice, references, baseCostUsd),
          `${resolution} at ${references} references falls below the band's worst point`,
        ).toBeGreaterThanOrEqual(worst);
      }
    },
  );

  it.each(rungs)(
    '$resolution prices a 0–1-reference job on the plain rung',
    ({ baseCostUsd, plainPrice, bandPrice }) => {
      // The band starts at two for a reason: one reference is what kie includes, so the
      // plain rung already covers it — and it is CHEAPER for the customer than the band.
      // A band that started at one would charge the multi-reference price for the most
      // ordinary edit there is.
      expect(marginAt(plainPrice, 1, baseCostUsd)).toBeGreaterThan(0.25);
      expect(plainPrice).toBeLessThan(bandPrice);
    },
  );
});

describe('SC4: video duration margins at real routing', () => {
  const videoCostModels = (
    ladder.costModel as Array<{
      kind: string;
      refClipSeconds?: number;
      creditsBaseConfig: number;
      matrix?: { modelId: string; resolution: string };
    }>
  ).filter(
    (
      entry,
    ): entry is {
      kind: 'video';
      refClipSeconds: number;
      creditsBaseConfig: number;
      matrix: { modelId: string; resolution: string };
    } =>
      entry.kind === 'video' &&
      typeof entry.refClipSeconds === 'number' &&
      entry.refClipSeconds > 0 &&
      entry.matrix != null,
  );

  it('checks every sellable duration: 25% at reference and 15% at the true worst rung', () => {
    for (const entry of videoCostModels) {
      const model = activeModels.find((m) => m.id === entry.matrix.modelId);
      // A withdrawn model keeps its COGS entry — the cost of the route it used to run
      // on does not stop being true — but it is no longer sellable, so there is no
      // duration for a customer to pick and nothing here to check. Skipping is right;
      // asserting the model is active would make the guard fight the withdrawal.
      if (!model) continue;

      const declaredDurations = (model!.capabilities as { durations?: unknown } | null | undefined)
        ?.durations;
      const durations = (Array.isArray(declaredDurations) ? declaredDurations : []).filter(
        (duration): duration is number =>
          typeof duration === 'number' &&
          Number.isFinite(duration) &&
          duration > 0 &&
          (model!.maxDurationSeconds == null || duration <= model!.maxDurationSeconds),
      );
      expect(durations, `${model!.id} has no sellable durations under its max clamp`).not.toEqual(
        [],
      );

      // Audio is a user lever on some models, so a rung can carry TWO active rows
      // at two vendor rates. The margin reference is the audio-ON row where one
      // exists: it is the dearer configuration AND the one the adapter runs by
      // default, so clearing the floor there clears it for the quiet variant too.
      // `mode: 'any'` only. A mode-specific row is priced against a DIFFERENT leg —
      // Wan's i2v row exists because the kie primary will not serve a framed shot, so
      // it runs on OpenRouter — and this block scores every rung against the model's
      // primary COGS. Judging the i2v price with the t2v cost would report a margin
      // neither leg earns. Those rows are reconciled leg-by-leg against the export in
      // `cost-legs.test.ts` instead, which is the check that knows which leg serves.
      const rungPoints = PRICE_POINT_SEED.filter(
        (row) =>
          row.isActive &&
          row.modelId === model!.id &&
          row.resolution === entry.matrix.resolution &&
          row.mode === 'any' &&
          !row.videoInput,
      );
      const referencePoints = rungPoints.some((row) => row.audio)
        ? rungPoints.filter((row) => row.audio)
        : rungPoints;
      expect(
        referencePoints,
        `${model!.id} must have exactly one active reference price point`,
      ).toHaveLength(1);
      const point = referencePoints[0];
      expect(point, `${model!.id} has no active reference price point`).toBeTruthy();

      const margins = durations.map((duration) => ({
        duration,
        // Same semantics as resolveParametricPrice: a flat-rate row charges once after
        // validating duration; every other row uses the rational per-unit formula.
        margin: videoDurationMargin(
          model!,
          floorRub,
          duration,
          point!.flatRate
            ? point!.baseCredits
            : Math.ceil((point!.baseCredits * duration) / point!.baseUnits),
        ),
      }));
      expect(
        margins.every(({ margin }) => margin !== null),
        `${model!.id} has an unpriced COGS rung`,
      ).toBe(true);

      const referenceMargin = videoDurationMargin(
        model!,
        floorRub,
        entry.refClipSeconds,
        point!.baseCredits,
      );
      const floorException = DURATION_FLOOR_EXCEPTIONS.get(model!.id);
      const referenceFloor = floorException?.reference ?? PRIMARY_MARGIN_FLOOR;
      if (floorException) {
        expect(
          referenceMargin!,
          `${model!.id} recovered to the primary floor; remove its stale exception`,
        ).toBeLessThan(PRIMARY_MARGIN_FLOOR);
      }
      expect(
        referenceMargin!,
        `${model!.id} @ ${entry.refClipSeconds}s reference margin ${(referenceMargin! * 100).toFixed(3)}% ` +
          `< ${referenceFloor * 100}% (${floorException?.reason ?? '«Сетка FX!B5»'})`,
      ).toBeGreaterThanOrEqual(referenceFloor);

      const worst = margins.reduce((lowest, current) =>
        current.margin! < lowest.margin! ? current : lowest,
      );
      expect(
        worst.margin!,
        `${model!.id} @ ${worst.duration}s worst-duration margin ${(worst.margin! * 100).toFixed(3)}% ` +
          `< ${(floorException?.worst ?? WORST_DURATION_MARGIN_FLOOR) * 100}% ` +
          `(${floorException?.reason ?? '«Сетка FX!B6»'})`,
      ).toBeGreaterThanOrEqual(floorException?.worst ?? WORST_DURATION_MARGIN_FLOOR);
    }
  });
});

/**
 * Every priced model stays priced: the workbook is the only price source
 * (P-11b purged the legacy `creditCostPerUnit` ceiling column), so a model the
 * price table names must exist in the seed and stay catalog-visible.
 */
describe('every model the price table prices exists in the catalog', () => {
  const pricedModelIds = new Set<string>();
  for (const row of PRICE_POINT_SEED) {
    // INACTIVE rows count because route wiring, not finance, is why they are parked.
    pricedModelIds.add(row.modelId);
  }

  it.each([...pricedModelIds].sort())('%s', (modelId) => {
    const model = seedModels.find((m) => m.id === modelId);
    expect(model, `price rows reference an unknown model '${modelId}'`).toBeTruthy();
  });

  it('covers every model the price table prices', () => {
    expect(pricedModelIds.size).toBeGreaterThanOrEqual(24);
  });
});
