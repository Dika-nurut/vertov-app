import {
  OFFICIAL_LEG_FX_RUB,
  executableIdentity,
  usdAtReferenceCount,
  type CatalogueEntry,
} from '@seed/db';
import { MAX_IMAGE_BATCH } from '@seed/provider-byteplus';
import { officialLegServability } from '@seed/shared/official-leg-cost';
import { unitsForGenerationModel } from '@seed/shared';
import { resolveCatalogueEntry } from '@seed/shared/select-route';

export interface AttemptLegContext {
  legIdentity: string;
  rung: string;
  role: 'primary' | 'fallback';
  units: number;
  configuredExpectedCostRub: number;
  revenueRub: number;
  vendorRubPerUsd: number;
}

export interface RouteAttemptContext {
  legs: Readonly<Record<string, AttemptLegContext>>;
}

/**
 * Resolve the journal's leg identity from the same finance catalogue used by
 * Phase 2. Chains get one context per leaf, because a single WorkflowSpec can
 * be submitted by laozhang, Kie, or OpenRouter after a fallback.
 */
export function routeAttemptContext(input: {
  model: { id: string; kind: string; maxDurationSeconds: number | null; capabilities: unknown };
  params: Record<string, unknown>;
  referenceAssets: readonly string[];
  revenueRub: number;
  gatewayNames?: readonly string[];
}): RouteAttemptContext | null {
  const references = imageReferenceCount(input.params, input.referenceAssets);
  const resolution = stringParam(input.params, ['resolution', 'quality']) ?? 'default';
  const audio = audioFor(input.params);
  const unitsResult = unitsForGenerationModel({
    kind: input.model.kind as 'image' | 'image-edit' | 'video' | 'voice',
    params: input.params,
    maxDurationSeconds: input.model.maxDurationSeconds,
    minDurationSeconds: minDuration(input.model.capabilities),
  });
  if (!unitsResult.ok) return null;
  const modes = modeCandidates(input.model.kind, input.params, references);
  const entries = uniqueEntries(
    modes
      .map((mode) =>
        resolveCatalogueEntry({
          modelId: input.model.id,
          resolution,
          references,
          mode,
          ...(audio === undefined ? {} : { audio }),
        }),
      )
      .filter((entry): entry is CatalogueEntry => entry !== null),
  );
  const names = input.gatewayNames ?? [
    'kie',
    'laozhang',
    'openrouter',
    'openrouter-official',
    'atlascloud',
  ];
  const legs: Record<string, AttemptLegContext> = {};
  for (const gateway of names) {
    if (gateway.toLowerCase() === 'openrouter-official') {
      const official = officialLegServability(
        input.model.capabilities,
        input.params,
        input.model.kind,
      );
      const entry = entries[0];
      if (!official.servable || !entry) continue;
      const vendorUnits = Math.min(unitsResult.units, MAX_IMAGE_BATCH);
      legs[gateway] = {
        legIdentity: `openrouter-official|${entry.modelId}|${entry.rung}|${entry.mode}`,
        rung: official.rung,
        role: 'fallback',
        units: vendorUnits,
        configuredExpectedCostRub: official.usdPerUnit * OFFICIAL_LEG_FX_RUB * vendorUnits,
        revenueRub: input.revenueRub,
        vendorRubPerUsd: OFFICIAL_LEG_FX_RUB,
      };
      continue;
    }
    const relay = relayForGateway(gateway);
    if (!relay) continue;
    const found = entries
      .map((entry) => ({
        entry,
        leg: entry.legs.find((candidate) => candidate.relay.toLowerCase() === relay),
      }))
      .find((candidate) => candidate.leg !== undefined);
    if (!found?.leg) continue;
    const usd = usdAtReferenceCount(found.leg, references);
    if (usd === null) continue;
    // The request kernel reports customer/output units. A signed per-clip leg
    // is the deliberate exception: the vendor charges one task regardless of
    // duration, so its configured cost and journal units must stay at one.
    const vendorUnits = found.leg.basis === 'за клип' ? 1 : unitsResult.units;
    legs[gateway] = {
      legIdentity: executableIdentity(found.leg),
      rung: found.entry.rung,
      role: found.leg.leg === 1 ? 'primary' : 'fallback',
      units: vendorUnits,
      configuredExpectedCostRub: usd * found.leg.landedRubPerUnit * vendorUnits,
      revenueRub: input.revenueRub,
      vendorRubPerUsd: found.leg.landedRubPerUnit,
    };
  }
  return Object.keys(legs).length > 0 ? { legs } : null;
}

function relayForGateway(gateway: string): string | null {
  switch (gateway.toLowerCase()) {
    case 'kie':
      return 'kie';
    case 'laozhang':
      return 'laozhang';
    case 'openrouter':
    case 'openrouter-official':
      return 'openrouter';
    case 'atlascloud':
      return 'atlascloud';
    default:
      return null;
  }
}

function modeCandidates(
  kind: string,
  params: Record<string, unknown>,
  references: number,
): string[] {
  const hasImage =
    references > 0 ||
    (Array.isArray(params['frameImages']) && params['frameImages'].length > 0) ||
    (Array.isArray(params['imageUrls']) && params['imageUrls'].length > 0);
  if (kind === 'image' || kind === 'image-edit') {
    return hasImage ? ['i2i', 't2i', 'any'] : ['t2i', 'i2i', 'any'];
  }
  return hasImage ? ['i2v', 'r2v', 'video-edit', 't2v', 'any'] : ['t2v', 'i2v', 'r2v', 'any'];
}

function uniqueEntries(entries: readonly CatalogueEntry[]): CatalogueEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.modelId}|${entry.rung}|${entry.mode}|${entry.audio ?? '-'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function imageReferenceCount(params: Record<string, unknown>, assets: readonly string[]): number {
  const imageUrls = params['imageUrls'];
  if (Array.isArray(imageUrls)) {
    const valid = imageUrls.filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (valid.length > 0) return valid.length;
  }
  return assets.filter((url) => !/\.(mp4|mov|webm)(\?|$)/i.test(url)).length;
}

function stringParam(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    if (typeof params[key] === 'string' && params[key].length > 0) {
      return params[key] as string;
    }
  }
  return null;
}

function audioFor(params: Record<string, unknown>): boolean | undefined {
  return typeof params['generate_audio'] === 'boolean' ? params['generate_audio'] : undefined;
}

function minDuration(capabilities: unknown): number | null {
  if (!capabilities || typeof capabilities !== 'object') return null;
  const durations = (capabilities as Record<string, unknown>)['durations'];
  if (!Array.isArray(durations)) return null;
  const values = durations.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  return values.length > 0 ? Math.min(...values) : null;
}
