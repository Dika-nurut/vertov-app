import {
  costCatalogue,
  costLegFile,
  fallbackGatewayOf,
  realGateway,
  splitModelId,
  type CostLegFile,
} from '@seed/db';
import { seedModels } from '@seed/db/seed/models';
import { officialLegServability } from './official-leg-cost';
import { CHAIN_RELAY_EXPANSIONS, isGatewayArmed, type GatewayArming } from './relay-gateway';

export interface RouteEngineG2Model {
  id: string;
  providerModelId: string;
  kind: string;
  isActive?: boolean | undefined;
  gatewayOverride?: string | null | undefined;
  fallbackGateway?: string | null | undefined;
  capabilities?: unknown;
}

/**
 * The one EXCLUDED reason that means «this leaf IS costed, at the primary's own rate».
 *
 * Finance writes a reserve row only when the reserve costs something different. Where a
 * vendor charges exactly what the primary charges, a second row would be a duplicate
 * that has to be kept in step by hand, so the position goes in the EXCLUDED block with
 * this reason instead. Every other reason (`снято с продажи`) excuses nothing: a
 * withdrawn rung has no price at all, which is the opposite situation.
 */
export const DUPLICATE_RESERVE_REASON = 'резерв дублирует основную';

/**
 * EXCLUDED `position` → the executable leaf it excuses.
 *
 * Written out rather than matched, and that is the whole design. Positions are the
 * workbook's own prose and vendor slugs while a leaf key is
 * `model|rung|quality|mode|audio|gateway`. Any rule that derived one from the other
 * would be a fuzzy match on finance's spelling, and a near-miss would silently excuse
 * the WRONG leaf. Rev. 22 has explicit cost rows for the former duplicate GPT reserve
 * positions, so the signed export currently has no duplicate-reserve exemptions.
 */
export const DUPLICATE_RESERVE_EXCUSED_LEAVES: Readonly<Record<string, string>> = {};

/** EXCLUDED duplicate-reserve positions nobody has mapped to a leaf yet. Must stay
 *  empty: an unmapped exclusion excuses nothing and would read as a real cost gap. */
export function unmappedDuplicateReserveExclusions(file: CostLegFile = costLegFile): string[] {
  return file.excluded
    .filter((row) => row.reason === DUPLICATE_RESERVE_REASON)
    .map((row) => row.position)
    .filter((position) => !(position in DUPLICATE_RESERVE_EXCUSED_LEAVES));
}

/** The leaves the export's own EXCLUDED block certifies as costed at the primary rate. */
export function duplicateReserveExcusedLeaves(file: CostLegFile = costLegFile): Set<string> {
  return new Set(
    file.excluded
      .filter((row) => row.reason === DUPLICATE_RESERVE_REASON)
      .flatMap((row) => {
        const leaf = DUPLICATE_RESERVE_EXCUSED_LEAVES[row.position];
        return leaf ? [leaf] : [];
      }),
  );
}

/**
 * G2's CI projection: expand the configured primary/fallback chain into its
 * real leaves, apply live arming, and require an exact signed cost leg for
 * every executable catalogue configuration. Official OpenRouter is included
 * only when its own adapter servability predicate says the rung can run.
 *
 * `excused` is the export's own EXCLUDED block, read rather than ignored: a leaf finance
 * declared a duplicate of its primary is costed — at the primary's rate — and reporting
 * it as a gap sends finance a question they already answered in the file.
 */
export function routeEngineG2CostGaps(
  arming: GatewayArming,
  models: readonly RouteEngineG2Model[] = seedModels,
  excused: ReadonlySet<string> = duplicateReserveExcusedLeaves(),
): string[] {
  const catalogue = costCatalogue();
  const gaps: string[] = [];
  for (const model of models.filter((candidate) => candidate.isActive !== false)) {
    const entries = catalogue.filter(
      (entry) => entry.modelId === splitModelId(model.id).modelId && entry.blockers.length === 0,
    );
    for (const gateway of leafGateways(model)) {
      if (!isGatewayArmed(gateway, arming)) continue;
      for (const entry of entries) {
        if (gateway === 'openrouter-official') {
          const official = officialLegServability(
            model.capabilities,
            { resolution: entry.quality ?? entry.rung },
            model.kind,
          );
          if (!official.servable) continue;
          continue;
        }
        const costed = entry.legs.some(
          (leg) =>
            leg.relay.toLowerCase() === gateway.toLowerCase() &&
            leg.costKnown &&
            Number.isFinite(leg.usdPerUnit) &&
            leg.usdPerUnit > 0,
        );
        // The quality tier belongs in the key. gpt-image-2 sells medium and high as
        // two configurations that both carry `rung: 'default'`, so a rung-only key
        // collapsed them into one string and the gap list carried a literal duplicate
        // — two different uncosted configurations reported as if they were one.
        const key = `${model.id}|${entry.rung}|${entry.quality ?? '-'}|${entry.mode}|audio=${String(entry.audio)}|${gateway}`;
        if (!costed && !excused.has(key)) gaps.push(key);
      }
    }
  }
  return gaps;
}

/**
 * The gateways a model can BOTH be routed to and be priced on: its configured
 * primary/fallback chain expanded to real leaves, intersected with the relays finance
 * has signed a usable cost row for.
 *
 * G5 needs this because a capability is only real if some leg we can actually reach
 * AND actually price supports it. Unioning across the whole contract registry lets a
 * model advertise a resolution reachable only through a gateway it is not configured
 * to use, or one we cannot charge for — which is R-2 (uncosted ⇒ not sellable) read
 * backwards.
 *
 * KNOWN LIMIT, do not read this for more than it says: the join is per GATEWAY, not
 * per configuration. One costed t2v row keeps the whole gateway "costed", so a
 * capability that only the model's uncosted r2v configuration needs still counts as
 * executable. G2 catches that uncosted configuration separately; this function does
 * not. Making it capability-specific means mapping each capability to the
 * configurations that require it, which is a bigger change than this guard.
 */
export function executableCostedGateways(model: RouteEngineG2Model): Set<string> {
  const base = splitModelId(model.id).modelId;
  const entries = costCatalogue().filter(
    (entry) => entry.modelId === base && entry.blockers.length === 0,
  );
  const reachable = new Set<string>();
  for (const gateway of leafGateways(model)) {
    const costed = entries.some((entry) =>
      entry.legs.some(
        (leg) =>
          leg.relay.toLowerCase() === gateway.toLowerCase() &&
          leg.costKnown &&
          Number.isFinite(leg.usdPerUnit) &&
          leg.usdPerUnit > 0,
      ),
    );
    if (costed) reachable.add(gateway);
  }
  return reachable;
}

function leafGateways(model: RouteEngineG2Model): string[] {
  const normalized = {
    ...model,
    gatewayOverride: model.gatewayOverride ?? null,
    fallbackGateway: model.fallbackGateway ?? null,
  };
  const configured = [realGateway(normalized), fallbackGatewayOf(normalized)].filter(
    (gateway): gateway is string => typeof gateway === 'string' && gateway.length > 0,
  );
  const leaves: string[] = [];
  for (const gateway of configured) {
    if (gateway === 'nanobanana' || gateway === 'geminiomni') {
      leaves.push(...CHAIN_RELAY_EXPANSIONS[gateway]);
    } else {
      leaves.push(gateway);
    }
  }
  return [...new Set(leaves)];
}
