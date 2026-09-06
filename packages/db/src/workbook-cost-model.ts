import { PRICE_POINT_SEED, type PricePointSeedRow } from '../seed/price-points';
import { costCatalogue } from './cost-catalogue';
import { landedCostRub } from './leg-cost';
import { splitModelId, type CatalogueEntry } from './price-catalogue';
import type { CostLeg } from './cost-legs';

/**
 * Runtime view of the finance workbook.
 *
 * `cost-legs.csv` is the checked-in, generated export of the workbook's
 * «НОГИ (экспорт)» sheet.  The catalogue is built from that export, so this
 * module deliberately resolves COGS from the exact `(model, rung, mode, band)`
 * entry rather than from the old one-row-per-model `pricing-ladder-v3.json`
 * snapshot.  The latter remains useful as an audit record, but it is not a
 * money-path input anymore.
 */

export type WorkbookGatewayFamily = 'openrouter' | 'direct';

/** Immutable provenance for the generated workbook export consumed at runtime. */
export const WORKBOOK_SSOT = {
  path: 'docs/business/pricing-workbook/Vertov_Pricing_Model_v14_2026-07-28.xlsx',
  sha256: 'ab35021e534e264a9bbb16c7ed391fb05b1a4056fc523b8e487728c41dd2d2fd',
  exportRevision: 22,
  exportHash16: '4a945faf95385d54',
  exportColumnsHash16: 'da54ec1b730a358b',
} as const;

export interface WorkbookPricePointCost {
  entry: CatalogueEntry;
  leg: CostLeg;
  costRub: number;
}

/** The route key used by the application → the relay named in the workbook. */
function relayAliases(gateway: string): readonly string[] {
  const key = gateway.trim().toLowerCase();
  if (!key) return [];
  // The capped official OpenRouter insurance leg is a distinct runtime route.
  // It must never borrow the ordinary workbook `OpenRouter` reserve row: that
  // row is a normal relay price, while the official leg is costed only when its
  // per-rung capability has been explicitly signed by finance.
  if (key === 'openrouter-official') return ['openrouter-official'];
  if (key.startsWith('openrouter')) return ['openrouter'];
  // These keys are provider chains, not individual workbook relays. The signed
  // export's first leg is the serving leg for the selected rung; explicit
  // failover checks use `kie`/`atlascloud` below instead of guessing a relay.
  if (key === 'nanobanana' || key === 'geminiomni') return [];
  return [key];
}

export function workbookGatewayFamily(gateway: string): WorkbookGatewayFamily {
  return gateway.trim().toLowerCase().startsWith('openrouter') ? 'openrouter' : 'direct';
}

/**
 * Find the signed workbook configuration for one seeded price point.
 *
 * Audio is ignored only for image rows, where the workbook has no audio axis.
 * Video rows with separate quiet/sound prices must match the signed audio state.
 * `videoInput`, mode and reference band are also real dimensions and must match.
 */
export function workbookEntryForPoint(
  point: Pick<
    PricePointSeedRow,
    'modelId' | 'resolution' | 'videoInput' | 'audio' | 'mode' | 'refsMin' | 'refsMax'
  >,
): CatalogueEntry | null {
  const { modelId, mode: pointMode } = splitModelId(point.modelId);
  const refsMin = point.refsMin ?? 0;
  const refsMax = point.refsMax ?? null;
  const refsMatch = (entry: CatalogueEntry): boolean => {
    const entryRefsMin = entry.legs[0]?.refsMin ?? 0;
    const entryRefsMax = entry.legs[0]?.refsMax ?? 0;
    // A plain price row (0..null in our DB key) may be represented by the
    // workbook's explicit 0..1 reference band. Seedream 5 Pro is the current
    // example: finance signs one price for zero or one input image, then a
    // separate 2..10 band. Do not broaden any nonzero band.
    if (refsMin === 0 && refsMax === null) {
      return entryRefsMin === 0 && (entryRefsMax === 0 || entry.mode === 'refs-0-1');
    }
    return entryRefsMin === refsMin && entryRefsMax === (refsMax ?? 0);
  };
  // A `-reference-to-video` picker id is a product face, not proof that the
  // request carried a video reference. Its active image-only mirror rows are
  // deliberately priced from the ordinary t2v twin (owner ruling 5); only the
  // inactive `videoInput=true` rows use the signed r2v configuration. An
  // explicit mode on a future row still wins over this selector-id rule.
  const explicitMode = point.mode !== 'any' ? point.mode : undefined;
  const selectorMode = point.videoInput ? pointMode : undefined;
  const expectedMode =
    refsMin > 0 && refsMax !== null
      ? `refs-${refsMin}-${refsMax}`
      : (explicitMode ?? selectorMode ?? (point.videoInput ? 'r2v' : undefined));

  const candidates = costCatalogue().filter((entry) => {
    if (entry.modelId !== modelId) return false;
    if ((entry.quality ?? entry.rung) !== point.resolution) return false;
    if (entry.audio !== null && entry.audio !== point.audio) return false;
    if (
      expectedMode === undefined &&
      entry.mode !== 't2i' &&
      entry.mode !== 't2v' &&
      entry.mode !== 'refs-0-1'
    )
      return false;
    if (!refsMatch(entry)) return false;
    if (expectedMode !== undefined && entry.mode !== expectedMode) return false;
    return true;
  });
  if (candidates.length > 0) {
    // `mode: any` is deliberately price-neutral. Prefer the ordinary t2i/t2v
    // export when both t2i and i2i (or t2v and i2v) carry the same signed price.
    return [...candidates].sort((a, b) => {
      const ordinary = (mode: string): number => (mode === 't2i' || mode === 't2v' ? 0 : 1);
      return ordinary(a.mode) - ordinary(b.mode);
    })[0]!;
  }

  // A point whose public seed resolution is a quality label (GPT low/medium/high)
  // maps to the export's `default` rung plus its `quality` column. The same exact
  // mode/band selection above did not find it because the catalogue identity uses
  // rung and quality separately.
  const qualityCandidate = costCatalogue().find((entry) => {
    if (entry.modelId !== modelId || entry.rung !== 'default') return false;
    if (entry.audio !== null && entry.audio !== point.audio) return false;
    if (entry.quality !== point.resolution) return false;
    if (!refsMatch(entry)) return false;
    return expectedMode === undefined
      ? entry.mode === 't2i' || entry.mode === 't2v' || entry.mode === 'refs-0-1'
      : entry.mode === expectedMode;
  });
  if (qualityCandidate) return qualityCandidate;

  // A legacy/delisted point can have a mode that is no longer present in the
  // export (HappyHorse 1.0 is the current example).  It remains auditable, but
  // must not make model-level coverage disappear.  Keep the fallback narrow:
  // same model, rung and reference band, never a different priced rung.
  return (
    costCatalogue().find(
      (entry) =>
        entry.modelId === modelId &&
        (entry.quality ?? entry.rung) === point.resolution &&
        (entry.audio === null || entry.audio === point.audio) &&
        refsMatch(entry) &&
        (expectedMode === undefined
          ? entry.mode === 't2i' || entry.mode === 't2v' || entry.mode === 'refs-0-1'
          : entry.mode === expectedMode),
    ) ?? null
  );
}

/** Resolve a route key to the named workbook leg. Empty means the primary leg. */
export function workbookLegForGateway(entry: CatalogueEntry, gateway: string): CostLeg | null {
  const aliases = relayAliases(gateway);
  if (aliases.length === 0) return entry.legs[0] ?? null;
  return entry.legs.find((leg) => aliases.includes(leg.relay.trim().toLowerCase())) ?? null;
}

export function workbookCostForPoint(
  point: Pick<
    PricePointSeedRow,
    | 'modelId'
    | 'resolution'
    | 'videoInput'
    | 'audio'
    | 'mode'
    | 'refsMin'
    | 'refsMax'
    | 'baseUnits'
    | 'flatRate'
  >,
  gateway: string,
): WorkbookPricePointCost | null {
  const entry = workbookEntryForPoint(point);
  if (!entry) return null;
  const leg = workbookLegForGateway(entry, gateway);
  if (!leg) return null;

  // A flat point describes one whole job.  For all other points the workbook's
  // `Количество`/price-point baseUnits is the billed quantity.
  const units = point.flatRate ? 1 : point.baseUnits;
  if (!Number.isFinite(units) || units <= 0) return null;
  return { entry, leg, costRub: landedCostRub(leg, units) };
}

/** Pick the dearest seeded configuration as the conservative model reference. */
export function workbookReferencePoint(modelId: string): PricePointSeedRow | null {
  const rows = PRICE_POINT_SEED.filter((row) => row.modelId === modelId);
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) =>
      b.baseCredits - a.baseCredits ||
      Number(b.isActive) - Number(a.isActive) ||
      a.sourceRef.localeCompare(b.sourceRef),
  )[0]!;
}

/** Conservative reference row for a particular executable gateway. */
export function workbookReferencePointForGateway(
  modelId: string,
  gateway: string,
): PricePointSeedRow | null {
  const rows = PRICE_POINT_SEED.filter(
    (row) => row.modelId === modelId && workbookCostForPoint(row, gateway) !== null,
  );
  const candidates =
    rows.length > 0 ? rows : PRICE_POINT_SEED.filter((row) => row.modelId === modelId);
  return (
    [...candidates].sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        b.baseCredits - a.baseCredits ||
        a.sourceRef.localeCompare(b.sourceRef),
    )[0] ?? null
  );
}

export function workbookReferenceCost(
  modelId: string,
  gateway: string,
): WorkbookPricePointCost | null {
  const point = workbookReferencePointForGateway(modelId, gateway);
  return point ? workbookCostForPoint(point, gateway) : null;
}
