import { seedModels } from '../../seed/models';
import { PRICE_POINT_SEED, type PricePointSeedRow } from '../../seed/price-points';
import { servingModelId } from '../../src/price-catalogue';
import type { CostLeg } from '../../src/cost-legs';

const knownModelIds = new Set(seedModels.map((model) => model.id));

const priceKey = (
  modelId: string,
  resolution: string,
  audio: boolean,
  mode: string,
  refsMin: number,
): string => `${modelId}|${resolution}|audio=${audio}|${mode}|refs>=${refsMin}`;

const ours = new Map(
  PRICE_POINT_SEED.filter((row) => row.isActive && !row.videoInput).map((row) => [
    priceKey(row.modelId, row.resolution, row.audio, row.mode, row.refsMin),
    row,
  ]),
);

/**
 * Our price row for one export leg, under the SAME selection rule the resolver uses.
 *
 * An exact-mode row wins; otherwise the plain `any` row serves, because `any` is
 * literally «this price covers every mode». That fallback is what makes this a check
 * rather than a list: seedance, veo and happyhorse all price i2v AT their t2v number,
 * so the `any` row genuinely is the signed i2v price — and if a future revision ever
 * moves one of them apart, this reports a drift instead of quietly naming the leg
 * unmatched. The reference band must match exactly: a 2–10 leg may never fall back
 * to the 0–1 row, which is the under-quote the band was added to end.
 *
 * `video-edit` is excluded from the fallback. Those legs are with-video
 * configurations, our with-video rows are parked inactive, and letting a video-edit
 * leg borrow the plain row would claim we price something we refuse to sell —
 * happyhorse-1-0 would read as covered at 284 against a signed 487.
 */
export function ourPointFor(leg: CostLeg): PricePointSeedRow | undefined {
  const resolution = leg.quality ?? leg.rung;
  const audio = leg.audio ?? false;
  const picker = servingModelId(leg, knownModelIds);
  if (picker && picker !== leg.modelId) {
    return ours.get(priceKey(picker, resolution, audio, 'any', 0));
  }
  if (!knownModelIds.has(leg.modelId)) return undefined;
  const exact = ours.get(priceKey(leg.modelId, resolution, audio, leg.mode, leg.refsMin));
  if (exact) return exact;
  if (leg.mode === 'video-edit') return undefined;
  return ours.get(priceKey(leg.modelId, resolution, audio, 'any', leg.refsMin));
}
