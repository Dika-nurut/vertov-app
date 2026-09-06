import { createHash } from 'node:crypto';

/** Bumped only when the deterministic timing policy changes. */
export const SCENARIO_TIMING_POLICY_VERSION = 'page-estimate-v1';

export interface ScenarioTimingSource {
  sourceId?: string | undefined;
  ordinal: number;
  sourceText: string;
}

export function scenarioTimingSourceUnitId(source: ScenarioTimingSource): string {
  return source.sourceId?.trim() || `scene:${source.ordinal}`;
}

export function scenarioTimingSourceRevisionId(sourceText: string): string {
  return createHash('sha256').update(sourceText).digest('hex');
}

/** Vertov suggestions become stale after their source changes; user approvals do not. */
export function scenarioTimingIsStale(input: {
  owner: string;
  sourceRevisionId: string;
  currentSourceRevisionId: string;
}): boolean {
  return input.owner === 'vertov' && input.sourceRevisionId !== input.currentSourceRevisionId;
}
