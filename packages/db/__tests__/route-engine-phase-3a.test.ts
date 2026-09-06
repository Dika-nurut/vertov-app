import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED, type PricePointSeedRow } from '../seed/price-points';
import {
  DURATION_FLOOR_EXCEPTIONS,
  activeMarginExceptions,
  assertNoExpiredMarginExceptions,
  costFreshness,
  executableIdentity,
  marginFloorForRole,
  routeLegHealthIsHealthy,
  staleCostLegs,
  type CostLeg,
  type CostLegFile,
} from '../src';
import { parseCostLegs } from '../src/cost-legs';
import { buildCatalogue, servingModelId, type CatalogueEntry } from '../src/price-catalogue';

const here = fileURLToPath(new URL('.', import.meta.url));
const file: CostLegFile = parseCostLegs(readFileSync(join(here, '../seed/cost-legs.csv'), 'utf8'));
const catalogue = buildCatalogue(file);
const knownModelIds = new Set(seedModels.map((model) => model.id));

function seedKey(row: PricePointSeedRow): string {
  return [row.modelId, row.resolution, row.videoInput, row.audio, row.mode, row.refsMin].join('|');
}

function candidatesFor(row: PricePointSeedRow): CatalogueEntry[] {
  // The signed catalogue prices output units only. A video-reference input is a
  // separate billing axis and has no trusted input-duration field, so it has no
  // executable cost candidate until that evidence exists. Keeping this branch
  // explicit prevents a t2v/output row from silently satisfying a video-input
  // price row.
  if (row.videoInput) return [];
  return catalogue.filter(
    (entry) =>
      (row.mode === 'any' ? servingModelId(entry, knownModelIds) : entry.modelId) === row.modelId &&
      (entry.quality ?? entry.rung) === row.resolution &&
      (entry.audio ?? false) === row.audio &&
      entry.legs[0]!.refsMin === row.refsMin &&
      (row.mode === 'any' || entry.mode === row.mode),
  );
}

function g1Gaps(rows: readonly PricePointSeedRow[]): string[] {
  return rows
    .filter((row) => row.isActive && seedModels.find((model) => model.id === row.modelId)?.isActive)
    .filter((row) => {
      const candidates = candidatesFor(row);
      return (
        candidates.length === 0 ||
        candidates.every((entry) =>
          entry.legs.every(
            (leg) =>
              !leg.costKnown ||
              !Number.isFinite(leg.usdPerUnit) ||
              leg.usdPerUnit <= 0 ||
              !['kie', 'openrouter', 'laozhang'].includes(leg.relay.toLowerCase()),
          ),
        )
      );
    })
    .map(seedKey);
}

describe('Phase 3a data guards against the signed export', () => {
  it('G1: every active real model price row has an executable cost leg', () => {
    const gaps = g1Gaps(PRICE_POINT_SEED);
    expect(gaps, `active price rows without an executable leg: ${gaps.join(', ')}`).toEqual([]);

    // Mutation is against a real active row, not a synthetic fixture. A deleted
    // resolution must become a named gap rather than silently borrowing a rung.
    const target = PRICE_POINT_SEED.find(
      (row) => row.modelId === 'wan-2-7' && row.resolution === '720p' && row.isActive,
    );
    expect(target).toBeDefined();
    const mutated = PRICE_POINT_SEED.map((row) =>
      row === target ? { ...row, resolution: 'missing-real-rung' } : row,
    );
    expect(g1Gaps(mutated)).toContain(seedKey({ ...target!, resolution: 'missing-real-rung' }));

    const parkedVideoInput = PRICE_POINT_SEED.find((row) => row.videoInput);
    expect(parkedVideoInput).toBeDefined();
    const activatedVideoInput = PRICE_POINT_SEED.map((row) =>
      row === parkedVideoInput ? { ...row, isActive: true } : row,
    );
    expect(g1Gaps(activatedVideoInput)).toContain(seedKey(parkedVideoInput!));
  });

  it('G3: role floors and exceptions are typed, expiring, and derived from real CSV data', () => {
    expect(file.legs.every((leg) => leg.role === (leg.leg === 1 ? 'primary' : 'fallback'))).toBe(
      true,
    );
    expect(new Set(file.legs.map((leg) => marginFloorForRole(leg.role)))).toEqual(
      new Set([0, 0.25]),
    );

    const primary = file.legs.find((leg) => leg.role === 'primary')!;
    const mutatedRole = { ...primary, role: 'fallback' as const };
    expect(marginFloorForRole(mutatedRole.role)).toBeLessThan(marginFloorForRole(primary.role));

    const now = new Date('2026-08-08T12:00:00Z');
    expect(activeMarginExceptions(now)).toEqual([]);
    expect(() => assertNoExpiredMarginExceptions(now)).not.toThrow();

    const belowFloor = file.legs.filter(
      (leg) =>
        leg.margin < marginFloorForRole(leg.role) &&
        !activeMarginExceptions(now).some((exception) => exception.key === executableIdentity(leg)),
    );
    expect(belowFloor, 'real CSV legs below their role floor').toEqual([]);

    // Mutate the real production exception collection, not a detached fixture.
    // An expired ruling must fail the guard instead of disappearing from the
    // active subset and silently excusing a bad leg.
    DURATION_FLOOR_EXCEPTIONS.push({
      key: 'real-collection-expired-ruling',
      expiresOn: '2026-08-07',
      reason: 'mutation proof',
    });
    try {
      expect(() => assertNoExpiredMarginExceptions(now)).toThrow('real-collection-expired-ruling');
    } finally {
      DURATION_FLOOR_EXCEPTIONS.pop();
    }
  });

  it('G4: real cost freshness has the 60-day boundary and a governed 14-day repricing branch', () => {
    // Cohorts are DERIVED, not pinned to a date. Finance restamps `Дата ISO` on every
    // revision — rev. 14 moved the export cohort from 2026-08-04 to 2026-08-10 — so a
    // hardcoded date turns a boundary test into a test that expires. Rev. 22 legitimately
    // has two cohorts: the eight newly signed Gemini/GPT fallback rows were captured on
    // the owner-approval date, while existing rows retain their original evidence date.
    const cohorts = [...new Set(file.legs.map((row) => row.capturedOn))].sort();
    expect(cohorts, 'the export carries only governed capture cohorts').toHaveLength(2);
    const legacyCohort = cohorts[0]!;
    const exportCohort = cohorts[cohorts.length - 1]!;
    const legacyLegs = file.legs.filter((row) => row.capturedOn === legacyCohort);
    const exportLegs = file.legs.filter((row) => row.capturedOn === exportCohort);
    const dayAfter = (iso: string, days: number): Date =>
      new Date(Date.parse(`${iso}T00:00:00Z`) + days * 24 * 60 * 60 * 1000);

    const leg = exportLegs.find((candidate) => candidate.confidence !== 'HYPOTHESIS')!;
    expect(leg).toBeDefined();

    // The short clock is not reachable only through a vendor record: a РИСК row draws it
    // too. Pinning the exact row-key set is the point — a new short-clock row or a
    // PROMOTED confidence level must be re-read, not absorbed by a length check, and both
    // directions have now happened. rev. 12 put three РИСК gpt-image-2 rows here; rev. 13
    // measured that rate ($0,03 flat on LaoZhang) and they left the short clock. What
    // replaced them is the pair of gemini-omni-flash t2v legs, and their РИСК is of a
    // different kind: the RATE is HIGH and the ROUTE is the risk — $0,112 holds only on
    // AtlasCloud's `-developer` tier, and losing that suffix produces no external signal.
    // The adapter-side guard is
    // `packages/providers/byteplus/__tests__/atlascloud-omni-priced-route.test.ts`.
    const hypotheses = file.legs.filter((candidate) => candidate.confidence === 'HYPOTHESIS');
    expect(hypotheses.map((row) => `${row.modelId}|${row.rung}|${row.mode}|${row.relay}`)).toEqual([
      'grok-imagine-video|720p|i2v|Kie',
      'grok-imagine-video|480p|i2v|Kie',
    ]);
    const shortClockRowKeys = [
      'grok-imagine-video|720p|i2v|нет|-|any|нога1',
      'grok-imagine-video|480p|i2v|нет|-|any|нога1',
    ] as const;
    const shortClock = new Set<string>(shortClockRowKeys);
    expect(file.legs.filter((row) => shortClock.has(row.rowKey)).map((row) => row.rowKey)).toEqual([
      ...shortClockRowKeys,
    ]);
    // 11 days: inside even the 14-day short clock, so nothing in the legacy cohort is stale.
    expect(staleCostLegs(legacyLegs, dayAfter(legacyCohort, 11))).toEqual([]);
    // 59 days after the legacy cohort: the short-clock rows are long gone and everything
    // else is still inside 60. This proves the two clocks are separate rather than one
    // clock with a lenient bound.
    expect(staleCostLegs(legacyLegs, dayAfter(legacyCohort, 59)).map((row) => row.rowKey)).toEqual([
      ...shortClockRowKeys,
    ]);
    // 61 days past the legacy cohort expires that cohort entirely; the newly signed rows
    // remain fresh at their own capture date.
    expect(staleCostLegs(legacyLegs, dayAfter(legacyCohort, 61)).length).toBe(legacyLegs.length);
    expect(staleCostLegs(exportLegs, dayAfter(exportCohort, 11))).toEqual([]);
    expect(costFreshness(leg, dayAfter(exportCohort, 59)).fresh).toBe(true);
    expect(costFreshness(leg, dayAfter(exportCohort, 61)).fresh).toBe(false);

    const agedRealLeg: CostLeg = { ...leg, capturedOn: '2026-06-01' };
    expect(staleCostLegs([agedRealLeg], new Date('2026-08-08T00:00:00Z'))).toEqual([agedRealLeg]);

    // Without a repricing record a HIGH-confidence leg keeps the 60-day branch, while a
    // hypothesis leg is on 14 days from its own signed confidence.
    expect(costFreshness(leg, dayAfter(exportCohort, 16))).toMatchObject({
      maxAgeDays: 60,
      hypothesis: false,
      repriced: false,
    });
    expect(costFreshness(hypotheses[0]!, dayAfter(hypotheses[0]!.capturedOn, 16))).toMatchObject({
      maxAgeDays: 14,
      hypothesis: true,
      repriced: false,
      fresh: false,
    });
    expect(
      costFreshness(leg, dayAfter(exportCohort, 16), [
        { vendor: leg.relay, vendorRepricedOn: '2026-08-01', source: 'governed-test-record' },
      ]),
    ).toMatchObject({ repriced: true, maxAgeDays: 14, fresh: false });
  });

  it('health: three submit failures reject until the persisted feed is stale at 15 minutes', () => {
    const failureAt = new Date('2026-08-08T12:00:00Z');
    const snapshot = {
      consecutiveSubmitFailures: 3,
      lastSubmitFailureAt: failureAt,
    };
    expect(routeLegHealthIsHealthy(snapshot, new Date('2026-08-08T12:14:59Z'))).toBe(false);
    expect(routeLegHealthIsHealthy(snapshot, new Date('2026-08-08T12:15:00Z'))).toBe(true);
    expect(
      routeLegHealthIsHealthy(
        { consecutiveSubmitFailures: 0, lastSubmitFailureAt: null },
        failureAt,
      ),
    ).toBe(true);
  });
});

// Keep the type import in this real-data guard explicit: a future mutation must
// remain a CostLeg-shaped mutation, not an untyped object that evades the parser.
void (null as CostLeg | null);
