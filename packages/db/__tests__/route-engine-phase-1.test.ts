import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ladder from '../seed/pricing-ladder-v3.json';
import { seedModels } from '../seed/models';
import { PRICE_POINT_SEED, type PricePointSeedRow } from '../seed/price-points';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import {
  buildCatalogue,
  entryKey,
  splitModelId,
  type CatalogueEntry,
} from '../src/price-catalogue';
import {
  GATEWAY_FX_RUB,
  creditFloorRub,
  gatewayFamilyOf,
  realGateway,
  type BreakEvenModel,
} from '../src/price-breakeven';
import { configKey, parseCostLegs, type CostLeg } from '../src/cost-legs';
import { landedCostRub } from '../src/leg-cost';
import {
  LEGACY_COST_DISPOSITIONS,
  type LegacyCostDispositionEntry,
} from './fixtures/legacy-cost-dispositions';
import {
  INACTIVE_FLATTERING_WATCH,
  PER_RUNG_RECONCILIATION,
  type PerRungFindingKind,
  type PerRungReconciliationEntry,
} from './fixtures/per-rung-reconciliation';
import { ourPointFor } from './fixtures/price-row-mapping';

type LegacyGatewayCost = {
  gateway: string;
  resolution: string;
  videoInput?: boolean;
  cogsUsdPerUnit: number;
  vendorBilling?: 'per_clip';
  refClipSeconds?: number;
};

type LegacyCostModel = {
  workbookId: string;
  kind: 'video' | 'image';
  channelPrimary: string;
  cogsUsdPerUnit: number;
  vendorBilling?: 'per_clip';
  creditsBaseConfig: number;
  refClipSeconds: number | undefined;
  matrix?: { modelId: string; resolution: string };
  gatewayCosts?: LegacyGatewayCost[];
};

type LegacyLadder = { costModel: LegacyCostModel[] };

interface LegacyCostRow {
  legacyKey: string;
  parent: LegacyCostModel;
  modelId: string;
  resolution: string;
  cogsUsdPerUnit: number;
  channel: string;
  refClipSeconds: number | undefined;
}

interface CostComparison {
  legacyKey: string;
  disposition: LegacyCostDispositionEntry['disposition'];
  rung: string;
  oldMargin: number;
  newMargin: number;
  deltaPp: number;
  landedCostDeltaRub: number;
}

const CSV = readFileSync(join(__dirname, '../seed/cost-legs.csv'), 'utf8');
const file = parseCostLegs(CSV);
const catalogue = buildCatalogue(file);
const byEntryKey = new Map(catalogue.map((entry) => [entryKey(entry), entry]));
const byV2Leg = new Map(file.legs.map((leg) => [`${configKey(leg)}|нога${leg.leg}`, leg]));
const legacyLadder = ladder as unknown as LegacyLadder;

/** Enumerate the old table from its JSON, independently of the manifest and v2 data. */
function enumerateLegacyCosts(source: LegacyLadder): LegacyCostRow[] {
  const rows: LegacyCostRow[] = [];
  for (const parent of source.costModel) {
    if (!parent.matrix) throw new Error(`${parent.workbookId}: missing matrix key`);
    rows.push({
      legacyKey: parent.workbookId,
      parent,
      modelId: parent.matrix.modelId,
      resolution: parent.matrix.resolution,
      cogsUsdPerUnit: parent.cogsUsdPerUnit,
      channel: parent.channelPrimary,
      refClipSeconds: parent.refClipSeconds,
    });
    for (const nested of parent.gatewayCosts ?? []) {
      rows.push({
        legacyKey: `${parent.workbookId} · ${nested.gateway} · ${nested.resolution}`,
        parent,
        modelId: parent.matrix.modelId,
        resolution: nested.resolution,
        cogsUsdPerUnit: nested.cogsUsdPerUnit,
        channel: nested.gateway,
        refClipSeconds: parent.refClipSeconds,
      });
    }
  }
  return rows;
}

const legacyRows = enumerateLegacyCosts(legacyLadder);

const PER_RUNG_FLOOR_RUB = creditFloorRub(seedSubscriptionTiers);
const seedModelById = new Map(seedModels.map((model) => [model.id, model]));

function perRungRowKey(row: PricePointSeedRow): string {
  return `${row.modelId}|${row.resolution}|mode=${row.mode}|audio=${row.audio}|videoInput=${row.videoInput}|refs=${row.refsMin}-${row.refsMax ?? 'any'}`;
}

function v2PrimaryForPriceRow(
  row: PricePointSeedRow,
): { entry: CatalogueEntry; leg: CostLeg } | null {
  const matchingLegs = file.legs.filter((leg) => ourPointFor(leg) === row);
  const preferredMode = row.unitKind === 'image' ? 't2i' : 't2v';
  const selectedLeg =
    (row.mode === 'any'
      ? matchingLegs.find((leg) => leg.mode === preferredMode)
      : matchingLegs.find((leg) => leg.mode === row.mode)) ?? matchingLegs[0];
  if (!selectedLeg) return null;
  const key = configKey(selectedLeg);
  const entry = byEntryKey.get(key);
  if (!entry) throw new Error(`${perRungRowKey(row)} catalogue entry missing`);
  const leg = entry.legs.find((candidate) => candidate.leg === 1);
  if (!leg) throw new Error(`${perRungRowKey(row)} catalogue primary leg missing`);
  return { entry, leg };
}

/**
 * Audit-only reproduction of the retired one-row-per-model ladder math.
 *
 * The runtime money path intentionally no longer imports pricing-ladder-v3.json.
 * This test still compares the signed export against that historical calculation,
 * so it must keep an explicit copy of the old formula instead of calling the new
 * SSOT-backed `pricePointBreakEven()` and accidentally making the comparison
 * tautological.
 */
function legacyPrimaryFamily(entry: LegacyCostModel): 'openrouter' | 'direct' {
  return entry.channelPrimary === 'OpenRouter' ? 'openrouter' : 'direct';
}

function legacyReferenceUnits(entry: LegacyCostModel): number {
  return entry.kind === 'video' ? (entry.refClipSeconds ?? 0) : 1;
}

function legacyCostPerCreditAtPrimary(entry: LegacyCostModel): number | null {
  const units = legacyReferenceUnits(entry);
  if (units <= 0 || entry.creditsBaseConfig <= 0) return null;
  return (
    (entry.cogsUsdPerUnit * units * GATEWAY_FX_RUB[legacyPrimaryFamily(entry)]) /
    entry.creditsBaseConfig
  );
}

function legacyModelCostPerCredit(entry: LegacyCostModel, model: BreakEvenModel): number | null {
  const gateway = realGateway(model);
  const family = gatewayFamilyOf(gateway);
  if (family === legacyPrimaryFamily(entry)) return legacyCostPerCreditAtPrimary(entry);
  const declared = (model.capabilities as Record<string, unknown> | null | undefined)?.[
    'priceUsdPerUnit'
  ];
  if (
    typeof declared !== 'number' ||
    !Number.isFinite(declared) ||
    declared <= 0 ||
    entry.creditsBaseConfig <= 0
  ) {
    return null;
  }
  const units = legacyReferenceUnits(entry);
  return units > 0 ? (declared * units * GATEWAY_FX_RUB[family]) / entry.creditsBaseConfig : null;
}

function legacyPointCostRub(
  costPerCredit: number | null,
  entry: LegacyCostModel,
  point: PricePointSeedRow,
): number | null {
  if (
    costPerCredit === null ||
    point.videoInput ||
    point.unitKind !== (entry.kind === 'image' ? 'image' : 'second') ||
    point.baseUnits <= 0
  ) {
    return null;
  }
  const referenceCostRub = costPerCredit * entry.creditsBaseConfig;
  if (entry.kind === 'image') return referenceCostRub * point.baseUnits;
  if (!entry.refClipSeconds || entry.refClipSeconds <= 0) return null;
  return entry.vendorBilling === 'per_clip' || point.flatRate
    ? referenceCostRub
    : referenceCostRub * (point.baseUnits / entry.refClipSeconds);
}

/** `undefined` means no exact legacy gateway row; `null` means an exact row is uncosted. */
function legacyGatewayPointCostRub(
  entry: LegacyCostModel,
  point: PricePointSeedRow,
  gateway: string,
): number | null | undefined {
  const exact = entry.gatewayCosts?.find(
    (candidate) =>
      candidate.gateway.toLowerCase() === gateway &&
      candidate.resolution === point.resolution &&
      (candidate.videoInput ?? false) === point.videoInput,
  );
  if (!exact) return undefined;
  if (
    exact.cogsUsdPerUnit <= 0 ||
    point.videoInput ||
    point.unitKind !== (entry.kind === 'image' ? 'image' : 'second') ||
    point.baseUnits <= 0
  ) {
    return null;
  }
  const referenceUnits =
    exact.refClipSeconds ?? entry.refClipSeconds ?? (entry.kind === 'video' ? point.baseUnits : 1);
  if (!Number.isFinite(referenceUnits) || referenceUnits <= 0) return null;
  const billableUnits = point.flatRate ? referenceUnits : point.baseUnits;
  const usd =
    exact.vendorBilling === 'per_clip'
      ? exact.cogsUsdPerUnit * referenceUnits
      : exact.cogsUsdPerUnit * billableUnits;
  return usd * GATEWAY_FX_RUB[gatewayFamilyOf(gateway)];
}

function legacyPricePointMargin(
  model: BreakEvenModel,
  floorRub: number,
  point: PricePointSeedRow,
): number | null {
  // The retired ladder never represented reference bands. The old test path
  // used the same signed v2 band cost for those rows, so keep that branch
  // explicitly tied to the independent export reconciliation.
  if ((point.refsMin ?? 0) > 0) {
    const v2 = v2PrimaryForPriceRow(point);
    if (!v2) return null;
    return 1 - landedCostRub(v2.leg, point.baseUnits) / (point.baseCredits * floorRub);
  }
  const entry = legacyLadder.costModel.find((candidate) => candidate.matrix?.modelId === model.id);
  if (!entry || floorRub <= 0) return null;
  const routedGateway = realGateway(model);
  const exact = legacyGatewayPointCostRub(entry, point, routedGateway);
  const costRub =
    exact === undefined
      ? legacyPointCostRub(legacyModelCostPerCredit(entry, model), entry, point)
      : exact;
  return costRub === null ? null : 1 - costRub / (point.baseCredits * floorRub);
}

interface PerRungObservation extends Omit<PerRungReconciliationEntry, 'verdict'> {
  row: PricePointSeedRow;
  v2CostRub: number | null;
  oldCostRub: number | null;
}

function observePerRung(row: PricePointSeedRow): PerRungObservation | null {
  const model = seedModelById.get(row.modelId);
  if (!model) throw new Error(`${perRungRowKey(row)} seed model missing`);
  const oldMargin = legacyPricePointMargin(
    model as unknown as BreakEvenModel,
    PER_RUNG_FLOOR_RUB,
    row,
  );
  const v2 = v2PrimaryForPriceRow(row);
  const revenueRub = row.baseCredits * PER_RUNG_FLOOR_RUB;
  const v2CostRub = v2 ? landedCostRub(v2.leg, row.baseUnits) : null;
  const newMargin = v2CostRub === null ? null : 1 - v2CostRub / revenueRub;
  const deltaPp = oldMargin === null || newMargin === null ? null : (newMargin - oldMargin) * 100;
  const oldCostRub = oldMargin === null ? null : revenueRub * (1 - oldMargin);
  const landedCostDeltaRub =
    oldCostRub === null || v2CostRub === null ? null : v2CostRub - oldCostRub;
  const legacyEntryExists = legacyLadder.costModel.some(
    (entry) => entry.matrix?.modelId === row.modelId,
  );

  let kind: PerRungFindingKind | null = null;
  if (v2 === null) kind = 'NO_V2_ENTRY';
  else if (oldMargin === null) kind = legacyEntryExists ? 'OLD_TABLE_UNCOSTED' : 'NO_LEGACY_ENTRY';
  else if (Math.abs(deltaPp ?? 0) > 1e-9) kind = 'DIVERGENCE';
  if (kind === null) return null;

  return {
    row,
    rowKey: perRungRowKey(row),
    kind,
    oldGateway: realGateway(model as unknown as BreakEvenModel),
    v2Leg: v2 ? `${entryKey(v2.entry)}|нога${v2.leg.leg}` : null,
    oldMargin,
    newMargin,
    deltaPp,
    landedCostDeltaRub,
    oldMoreFlattering: kind === 'DIVERGENCE' ? (deltaPp ?? 0) < -1e-9 : null,
    v2CostRub,
    oldCostRub,
  };
}

function observeActivePerRungs(): PerRungObservation[] {
  return PRICE_POINT_SEED.filter((row) => row.isActive)
    .map(observePerRung)
    .filter((observation): observation is PerRungObservation => observation !== null);
}

const UNMATCHED_ACTIVE_PRICE_ROWS: readonly { key: string; reason: string }[] = [
  // happyhorse-1-0 was delisted in migration 0094; no active rows remain without a v2 leg.
];

const DIVERGENCE_VERDICTS: Readonly<Record<string, string>> = {
  'grok-imagine-video · 720p · direct':
    'Verdict: this is a real Kie reprice of approximately 50%, not a unit-normalization error; retain the old price and await finance sign-off.',
  'grok-imagine-video · 720p · direct · kie · 480p':
    'Verdict: this is a real Kie reprice of approximately 50%, not a unit-normalization error; retain the old price and await finance sign-off.',
  'grok-imagine-video · 720p · direct · kie · 720p':
    'Verdict: this is a real Kie reprice of approximately 50%, not a unit-normalization error; retain the old price and await finance sign-off.',
  'gpt-image-2 · high · direct':
    'Verdict: the old table costs the high tier at $0.08 because it assumed a per-tier ' +
    'rate; the leg finance signed bills a FLAT $0.03 at every tier, so the divergence is ' +
    'the old rate being wrong rather than the vendor repricing. Direction is pessimistic ' +
    '(the old figure understates the margin at 26.3% against 72.4%), so nothing was ever ' +
    'activated on a margin it did not earn. No price changes: 13/21/33 is a signed owner ' +
    'override of 2026-08-10 that sells perceived quality, and at one flat cost the price ' +
    'rule would return 13 on all three tiers.',
};

function normalizedLegacyUsd(row: LegacyCostRow): number {
  if (row.parent.kind === 'image') return row.cogsUsdPerUnit;
  if (!row.refClipSeconds || row.refClipSeconds <= 0) {
    throw new Error(`${row.legacyKey}: missing positive reference clip length`);
  }
  return row.cogsUsdPerUnit * row.refClipSeconds;
}

/**
 * The one rung RENAME in the programme, as opposed to a rung that moved.
 *
 * The legacy table froze flux-2-pro's only rung as `default`, because at the time it was
 * the only one. rev. 13 added a `2K` rung and rev. 14 re-banded the cheap one `1K` — the
 * same picture at the same rate, under a name the resolver can put beside `2K`. The
 * legacy side is a frozen historical record and must NOT be edited to match; pairing the
 * two by name is what would be wrong here, so the rename is named instead.
 *
 * Deliberately narrow: one model, one direction, and only where the rate is unchanged.
 * A flux rung that genuinely moves still reports a mismatch.
 */
function isRev14FluxReband(row: LegacyCostRow, leg: CostLeg): boolean {
  return row.modelId === 'flux-2-pro' && row.resolution === 'default' && leg.rung === '1K';
}

function pairingShapeError(row: LegacyCostRow, leg: CostLeg): string | null {
  const split = splitModelId(row.modelId);
  if (leg.modelId !== split.modelId) return `${row.legacyKey}: model mismatch`;

  const isQualityTier =
    row.modelId === 'gpt-image-2' && ['low', 'medium', 'high'].includes(row.resolution);
  if (isQualityTier) {
    if (leg.rung !== 'default' || leg.quality !== row.resolution) {
      return `${row.legacyKey}: gpt-image-2 quality mismatch`;
    }
  } else if (leg.rung !== row.resolution && !isRev14FluxReband(row, leg)) {
    return `${row.legacyKey}: rung mismatch`;
  }

  if (split.mode !== null) {
    if (leg.mode !== split.mode) return `${row.legacyKey}: mode mismatch`;
  } else if (!['t2v', 't2i', 'refs-0-1', 'refs-2-8', 'refs-2-10'].includes(leg.mode)) {
    return `${row.legacyKey}: legacy mode has no rule-6 pairing`;
  }

  if (gatewayFamilyOf(row.channel) !== gatewayFamilyOf(leg.relay)) {
    return `${row.legacyKey}: gateway family mismatch`;
  }
  return null;
}

function manifestRateMismatches(rows: LegacyCostRow[], legs: readonly CostLeg[]): string[] {
  const legacyByKey = new Map(rows.map((row) => [row.legacyKey, row]));
  const v2ByKey = new Map(legs.map((leg) => [`${configKey(leg)}|нога${leg.leg}`, leg]));
  const mismatches: string[] = [];

  for (const disposition of LEGACY_COST_DISPOSITIONS) {
    if (disposition.v2Leg === null) continue;
    const legacy = legacyByKey.get(disposition.legacyKey);
    const v2 = v2ByKey.get(disposition.v2Leg);
    if (!legacy) {
      mismatches.push(`${disposition.legacyKey}: legacy row missing`);
      continue;
    }
    if (!v2) {
      mismatches.push(`${disposition.legacyKey}: v2 leg missing`);
      continue;
    }
    if (legacy.cogsUsdPerUnit !== disposition.legacyUsdPerUnit) {
      mismatches.push(`${disposition.legacyKey}: legacy rate differs from manifest`);
    }
    if (v2.usdPerUnit !== disposition.v2UsdPerUnit) {
      mismatches.push(`${disposition.legacyKey}: v2 rate differs from manifest`);
    }
  }
  return mismatches;
}

function assertManifestRates(rows: LegacyCostRow[], legs: readonly CostLeg[]): void {
  const mismatches = manifestRateMismatches(rows, legs);
  if (mismatches.length > 0) throw new Error(mismatches.join('\n'));
}

function compareAgainstOldTable(): CostComparison[] {
  const floor = creditFloorRub(seedSubscriptionTiers);
  const legacyByKey = new Map(legacyRows.map((row) => [row.legacyKey, row]));
  const comparisons: CostComparison[] = [];

  for (const disposition of LEGACY_COST_DISPOSITIONS) {
    if (disposition.v2Leg === null) continue;
    const legacy = legacyByKey.get(disposition.legacyKey);
    const leg = byV2Leg.get(disposition.v2Leg);
    if (!legacy || !leg) throw new Error(`${disposition.legacyKey}: pairing not found`);
    const entry = byEntryKey.get(configKey(leg));
    if (!entry) throw new Error(`${disposition.legacyKey}: catalogue entry not found`);

    const revenue = entry.credits * floor;
    const oldCost = normalizedLegacyUsd(legacy) * GATEWAY_FX_RUB[gatewayFamilyOf(legacy.channel)];
    const newCost = landedCostRub(leg, entry.baseUnits);
    const oldMargin = 1 - oldCost / revenue;
    const newMargin = 1 - newCost / revenue;
    comparisons.push({
      legacyKey: disposition.legacyKey,
      disposition: disposition.disposition,
      rung: legacy.resolution,
      oldMargin,
      newMargin,
      deltaPp: (newMargin - oldMargin) * 100,
      landedCostDeltaRub: newCost - oldCost,
    });
  }
  return comparisons;
}

function cloneLegacyLadder(): LegacyLadder {
  return JSON.parse(JSON.stringify(legacyLadder)) as LegacyLadder;
}

function walkFiles(directory: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (name === 'node_modules') continue;
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

describe('Phase 1 reconciliation and coverage', () => {
  it('P1-3: comparison revenue and units come from our catalogue', () => {
    const legacy = legacyRows.find((row) => row.legacyKey === 'veo-3-1 · 1080p · direct');
    const leg = byV2Leg.get('veo-3-1|1080p|t2v|да|-|any|нога1');
    if (!legacy || !leg) throw new Error('Veo reconciliation fixture missing');
    const entry = byEntryKey.get(configKey(leg));
    if (!entry) throw new Error('Veo catalogue entry missing');
    const floor = creditFloorRub(seedSubscriptionTiers);

    expect(legacy.parent.creditsBaseConfig).toBe(913);
    expect(entry.credits).toBe(597);
    expect(legacy.refClipSeconds).toBe(8);
    expect(entry.baseUnits).toBe(1);
    expect(1 - landedCostRub(leg, entry.baseUnits) / (entry.credits * floor)).toBeCloseTo(
      leg.margin,
      5,
    );
  });

  it('P1-7: the independently enumerated 32-key universe equals the literal manifest', () => {
    expect(legacyRows).toHaveLength(32);
    const observed = new Set(legacyRows.map((row) => row.legacyKey));
    const manifest = new Set(LEGACY_COST_DISPOSITIONS.map((row) => row.legacyKey));
    expect(manifest).toEqual(observed);
    expect(LEGACY_COST_DISPOSITIONS).toHaveLength(legacyRows.length);

    for (const disposition of LEGACY_COST_DISPOSITIONS) {
      expect(disposition.reason.trim(), disposition.legacyKey).not.toBe('');
      if (disposition.v2Leg === null) {
        expect(disposition.disposition, disposition.legacyKey).toBe('RETIRED_NO_V2_LEG');
        expect(disposition.v2UsdPerUnit, disposition.legacyKey).toBeNull();
      } else {
        expect(disposition.v2UsdPerUnit, disposition.legacyKey).not.toBeNull();
        const row = legacyRows.find((candidate) => candidate.legacyKey === disposition.legacyKey);
        const leg = byV2Leg.get(disposition.v2Leg);
        if (!row || !leg) throw new Error(`${disposition.legacyKey}: manifest pair missing`);
        expect(pairingShapeError(row, leg), disposition.legacyKey).toBeNull();
      }
    }
  });

  it('P1-8: the hand-copied rate oracle catches a legacy or v2 mutation', () => {
    expect(() => assertManifestRates(legacyRows, file.legs)).not.toThrow();

    const changedLegacy = cloneLegacyLadder();
    const legacyEntry = changedLegacy.costModel.find(
      (entry) => entry.workbookId === 'grok-imagine-video · 720p · direct',
    );
    if (!legacyEntry) throw new Error('Grok legacy fixture missing');
    legacyEntry.cogsUsdPerUnit += 0.001;
    expect(() => assertManifestRates(enumerateLegacyCosts(changedLegacy), file.legs)).toThrow(
      /legacy rate differs from manifest/,
    );

    const changedLegs = file.legs.map((leg) =>
      `${configKey(leg)}|нога${leg.leg}` === 'grok-imagine-video|720p|t2v|нет|-|any|нога1'
        ? { ...leg, usdPerUnit: leg.usdPerUnit + 0.001 }
        : leg,
    );
    expect(() => assertManifestRates(legacyRows, changedLegs)).toThrow(
      /v2 rate differs from manifest/,
    );
  });

  it('compares paired costs with the same catalogue revenue and full precision', () => {
    expect(() => assertManifestRates(legacyRows, file.legs)).not.toThrow();
    const comparisons = compareAgainstOldTable();
    expect(comparisons.length).toBeGreaterThan(0);
    expect(comparisons.every((comparison) => Number.isFinite(comparison.deltaPp))).toBe(true);
    const divergences = comparisons.filter((comparison) => Math.abs(comparison.deltaPp) > 1e-9);
    expect(divergences.map((divergence) => divergence.legacyKey).sort()).toEqual(
      Object.keys(DIVERGENCE_VERDICTS).sort(),
    );
    for (const divergence of divergences) {
      expect(DIVERGENCE_VERDICTS[divergence.legacyKey], divergence.legacyKey).toMatch(/^Verdict:/);
    }

    // Keep this output available for the required hand-written divergence report.
    if (process.env['RECONCILE_V2_REPORT']) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(comparisons, null, 2));
    }
  });

  it('reconciles every active price rung through the shipped old path', () => {
    const observed = observeActivePerRungs();
    const observedByKey = new Map(observed.map((finding) => [finding.rowKey, finding]));
    const manifestKeys = PER_RUNG_RECONCILIATION.map((finding) => finding.rowKey);

    expect(observedByKey.size).toBe(observed.length);
    expect(new Set(manifestKeys)).toEqual(new Set(observedByKey.keys()));
    expect(PER_RUNG_RECONCILIATION).toHaveLength(observed.length);

    // DANGER DIRECTION: an old margin above v2 is the activation-gate risk. The
    // gate reads the old number, so that row can be activated on a margin it does
    // not actually earn. The inactive Seedance 4K watch row is asserted separately
    // below because the brief calls it out even though it is not in this active set.
    const flattering = observed
      .filter((finding) => finding.oldMoreFlattering)
      .map((finding) => finding.rowKey)
      .sort();
    expect(flattering).toEqual(
      PER_RUNG_RECONCILIATION.filter((finding) => finding.oldMoreFlattering)
        .map((finding) => finding.rowKey)
        .sort(),
    );

    for (const expected of PER_RUNG_RECONCILIATION) {
      const actual = observedByKey.get(expected.rowKey);
      if (!actual) throw new Error(`${expected.rowKey}: observation missing`);
      expect(actual.kind, expected.rowKey).toBe(expected.kind);
      expect(actual.oldGateway, expected.rowKey).toBe(expected.oldGateway);
      expect(actual.v2Leg, expected.rowKey).toBe(expected.v2Leg);
      if (expected.oldMargin === null) {
        expect(actual.oldMargin, expected.rowKey).toBeNull();
      } else {
        expect(actual.oldMargin, expected.rowKey).toBeCloseTo(expected.oldMargin, 12);
      }
      if (expected.newMargin === null) {
        expect(actual.newMargin, expected.rowKey).toBeNull();
      } else {
        expect(actual.newMargin, expected.rowKey).toBeCloseTo(expected.newMargin, 12);
      }
      if (expected.deltaPp === null) expect(actual.deltaPp, expected.rowKey).toBeNull();
      else expect(actual.deltaPp, expected.rowKey).toBeCloseTo(expected.deltaPp, 12);
      if (expected.landedCostDeltaRub === null) {
        expect(actual.landedCostDeltaRub, expected.rowKey).toBeNull();
      } else {
        expect(actual.landedCostDeltaRub, expected.rowKey).toBeCloseTo(
          expected.landedCostDeltaRub,
          12,
        );
      }
      expect(actual.oldMoreFlattering, expected.rowKey).toBe(expected.oldMoreFlattering);
      expect(expected.verdict.trim(), expected.rowKey).not.toBe('');
    }
  });

  it('pins the inactive Seedance 4K flattering-direction watch row', () => {
    const row = PRICE_POINT_SEED.find(
      (candidate) => candidate.modelId === 'seedance-2-0' && candidate.resolution === '4K',
    );
    if (!row) throw new Error('Seedance 4K seed row missing');
    expect(row.isActive).toBe(false);
    const model = seedModelById.get(row.modelId);
    if (!model) throw new Error('Seedance model missing');
    const entry = byEntryKey.get('seedance-2-0|4K|t2v|нет|-|any');
    if (!entry) throw new Error('Seedance 4K catalogue entry missing');
    const leg = entry.legs.find((candidate) => candidate.leg === 1);
    if (!leg) throw new Error('Seedance 4K primary leg missing');
    const oldMargin = legacyPricePointMargin(
      model as unknown as BreakEvenModel,
      PER_RUNG_FLOOR_RUB,
      row,
    );
    const revenueRub = row.baseCredits * PER_RUNG_FLOOR_RUB;
    const v2CostRub = landedCostRub(leg, row.baseUnits);
    const newMargin = 1 - v2CostRub / revenueRub;
    const oldCostRub = revenueRub * (1 - (oldMargin ?? 0));

    expect(perRungRowKey(row)).toBe(INACTIVE_FLATTERING_WATCH.rowKey);
    expect(`${entryKey(entry)}|нога${leg.leg}`).toBe(INACTIVE_FLATTERING_WATCH.v2Leg);
    expect(oldMargin).toBeCloseTo(INACTIVE_FLATTERING_WATCH.oldMargin, 12);
    expect(newMargin).toBeCloseTo(INACTIVE_FLATTERING_WATCH.newMargin, 12);
    expect((newMargin - (oldMargin ?? 0)) * 100).toBeCloseTo(INACTIVE_FLATTERING_WATCH.deltaPp, 12);
    expect(v2CostRub - oldCostRub).toBeCloseTo(INACTIVE_FLATTERING_WATCH.landedCostDeltaRub, 12);
    expect(INACTIVE_FLATTERING_WATCH.verdict.trim()).not.toBe('');
  });

  it('P1-9: every active price row has a v2 leg, with gaps named explicitly', () => {
    const unmatched = PRICE_POINT_SEED.filter((row) => row.isActive)
      .filter(
        (row) =>
          !file.legs.some((leg) => {
            const ours = ourPointFor(leg);
            return ours === row;
          }),
      )
      .map((row) => `${row.modelId}|${row.resolution}|mode=${row.mode}|refs>=${row.refsMin}`)
      .sort();
    expect(unmatched).toEqual(UNMATCHED_ACTIVE_PRICE_ROWS.map((row) => row.key).sort());
    for (const row of UNMATCHED_ACTIVE_PRICE_ROWS) {
      expect(row.reason.trim(), row.key).not.toBe('');
    }
  });

  it('P1-10: the new module remains private to @seed/db', () => {
    const packagesDirectory = resolve(__dirname, '../..');
    const dbDirectory = resolve(packagesDirectory, 'db');
    const appsDirectory = resolve(packagesDirectory, '../apps');
    const outsideImports = [...walkFiles(packagesDirectory), ...walkFiles(appsDirectory)]
      .filter((path) => !path.startsWith(`${dbDirectory}${resolve('/')}`))
      .filter((path) =>
        /(?:from|import) ['"][^'"]*\/leg-cost['"]/.test(readFileSync(path, 'utf8')),
      );
    expect(outsideImports).toEqual([]);
  });
});
