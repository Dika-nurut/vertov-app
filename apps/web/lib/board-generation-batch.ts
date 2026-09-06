import { BOARD_LIMITS } from '@seed/shared/board-contract';

export function boardBatchCost(
  cost: number | null,
  mode: 'image' | 'video',
  count = 1,
): number | null {
  if (cost === null || mode === 'image') return cost;
  return cost * Math.max(1, count);
}

/**
 * Flatten resolved per-job assets in submission order for the take strip.
 *
 * `already` carries takes recovered from the persisted node — after a reload
 * mid-batch every job is resumed, including ones that had already finished, so
 * their assets arrive a second time. De-duplicating by URL is what keeps that
 * from filling the strip with copies of one take.
 */
export function boardTakesInSubmitOrder(
  jobIds: readonly string[],
  assetsByJobId: ReadonlyMap<string, readonly string[]>,
  already: readonly string[] = [],
): string[] {
  const takes: string[] = [];
  const seen = new Set<string>();
  const push = (asset: string) => {
    if (seen.has(asset) || takes.length >= BOARD_LIMITS.takes) return;
    seen.add(asset);
    takes.push(asset);
  };
  // Attributed assets first, in job order — a recovered take whose job has
  // re-resolved must sit where its job sits, not wherever the reload left it.
  for (const jobId of jobIds) {
    for (const asset of assetsByJobId.get(jobId) ?? []) push(asset);
  }
  // Then the recovered takes still unattributed to any resolved job, so a
  // partially-restored batch never loses a take it already paid for.
  for (const asset of already) push(asset);
  return takes;
}
