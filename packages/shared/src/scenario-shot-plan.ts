import { z } from 'zod';
import { boardShotGrammarSchema } from './board-contract';
import {
  STRUCTURIZE_CREDITS,
  STRUCTURIZE_MAX_ATTEMPTS,
  STRUCTURIZE_MODEL,
  STRUCTURIZE_TOKEN_BUDGET,
} from './assist-tiers';

/** Versioned contract for the normalized Scenario → shot-plan projection. */
export const SCENARIO_SHOT_PLAN_VERSION = 'scenario-shot-plan-v1' as const;

/**
 * The planner deliberately reuses the already registered economy model and its
 * fail-closed workbook price. A new planner slug would require a finance/catalog
 * ruling; this milestone does not silently create one.
 */
export const SCENARIO_SHOT_PLAN_MODEL = STRUCTURIZE_MODEL;
export const SCENARIO_SHOT_PLAN_BUDGET = { ...STRUCTURIZE_TOKEN_BUDGET } as const;
export const SCENARIO_SHOT_PLAN_MAX_ATTEMPTS = STRUCTURIZE_MAX_ATTEMPTS;
export const SCENARIO_SHOT_PLAN_CREDITS = STRUCTURIZE_CREDITS;
export const SCENARIO_SHOT_PLAN_MAX_INPUT_BYTES = 30_000 as const;
export const SCENARIO_SHOT_PLAN_SOURCE_MAX_BYTES = 18_000 as const;
export const SCENARIO_SHOT_PLAN_PROMPT_MAX_CHARS = 1_200 as const;
export const SCENARIO_SHOT_PLAN_MAX_SHOTS = 60 as const;
export const SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS = 120 as const;
export const SCENARIO_SHOT_PLAN_DEADLINE_MS = 120_000 as const;

/**
 * Backend generation requests currently accept integer seconds. Keeping this
 * as an explicit one-second step set makes the planner's normalization policy
 * visible and lets a future model-specific menu replace it without changing
 * the persisted contract.
 */
export const SCENARIO_SHOT_DURATION_STEPS = Array.from(
  { length: SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS },
  (_, index) => index + 1,
);

const boundedId = z.string().trim().min(1).max(160);

const scenarioShotGrammarOutputSchema = boardShotGrammarSchema;

const scenarioShotRawSchema = z
  .object({
    order: z.number().finite(),
    title: z.string().trim().min(1).max(240),
    durationSec: z.number().finite().positive().max(7_200),
    dramaticBeat: z.string().trim().max(500),
    promptDraft: z.string().trim().min(1).max(SCENARIO_SHOT_PLAN_PROMPT_MAX_CHARS),
    shotGrammar: scenarioShotGrammarOutputSchema.optional(),
    requiredLocks: z.array(boundedId).max(16),
    unresolvedAssets: z.array(z.string().trim().min(1).max(240)).max(16),
  })
  .strict();

export const scenarioShotPlanRawSchema = z
  .object({
    sceneId: boundedId,
    shots: z.array(scenarioShotRawSchema).min(1).max(120),
  })
  .strict();

const scenarioShotSchema = z
  .object({
    order: z.number().int().positive().max(SCENARIO_SHOT_PLAN_MAX_SHOTS),
    title: z.string().trim().min(1).max(240),
    durationSec: z.number().int().min(1).max(SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS),
    dramaticBeat: z.string().trim().max(500),
    promptDraft: z.string().trim().min(1).max(SCENARIO_SHOT_PLAN_PROMPT_MAX_CHARS),
    shotGrammar: scenarioShotGrammarOutputSchema.optional(),
    requiredLocks: z.array(boundedId).max(16),
    unresolvedAssets: z.array(z.string().trim().min(1).max(240)).max(16),
  })
  .strict();

export const scenarioShotPlanSchema = z
  .object({
    version: z.literal(SCENARIO_SHOT_PLAN_VERSION),
    sceneId: boundedId,
    targetDurationSeconds: z.number().int().positive().max(7_200),
    shots: z.array(scenarioShotSchema).min(1).max(SCENARIO_SHOT_PLAN_MAX_SHOTS),
  })
  .strict();

export type ScenarioShotRaw = z.infer<typeof scenarioShotRawSchema>;
export type ScenarioShotPlanRaw = z.infer<typeof scenarioShotPlanRawSchema>;
export type ScenarioShot = z.infer<typeof scenarioShotSchema>;
export type ScenarioShotPlan = z.infer<typeof scenarioShotPlanSchema>;

export class ScenarioShotPlanDurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioShotPlanDurationError';
  }
}

function snapDuration(value: number): number {
  const rounded = Math.round(value);
  return Math.max(1, Math.min(SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS, rounded));
}

/**
 * Normalize one model response. A duration mismatch is only repaired when the
 * delta is small enough to be integer rounding; semantic under/over-planning is
 * rejected so the route can make its one bounded retry and then refund.
 */
export function normalizeScenarioShotPlan(input: {
  raw: ScenarioShotPlanRaw;
  targetDurationSeconds: number;
  allowedLockIds: ReadonlySet<string>;
}): ScenarioShotPlan {
  const target = input.targetDurationSeconds;
  const selected = input.raw.shots.slice(0, SCENARIO_SHOT_PLAN_MAX_SHOTS);
  if (selected.length === 0) throw new ScenarioShotPlanDurationError('no shots');
  if (target >= 6 && selected.length < 2) {
    throw new ScenarioShotPlanDurationError('scene collapsed into one shot');
  }

  const durations = selected.map((shot) => snapDuration(shot.durationSec));
  let delta = target - durations.reduce((sum, value) => sum + value, 0);
  // Only a one-second-per-shot correction is considered rounding repair. A
  // larger delta means the model misunderstood the target and must be retried.
  if (Math.abs(delta) > selected.length) {
    throw new ScenarioShotPlanDurationError(
      `duration sum mismatch: target=${target} actual=${target - delta}`,
    );
  }
  for (let index = 0; index < durations.length && delta !== 0; index += 1) {
    if (delta > 0 && durations[index]! < SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS) {
      durations[index] = Math.min(
        SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS,
        durations[index]! + 1,
      );
      delta -= 1;
    } else if (delta < 0 && durations[index]! > 1) {
      durations[index] = Math.max(1, durations[index]! - 1);
      delta += 1;
    }
  }
  if (delta !== 0) throw new ScenarioShotPlanDurationError('duration sum cannot be repaired');

  const normalized = selected.map((shot, index) => ({
    order: index + 1,
    title: shot.title,
    durationSec: durations[index]!,
    dramaticBeat: shot.dramaticBeat,
    promptDraft: shot.promptDraft,
    ...(shot.shotGrammar ? { shotGrammar: shot.shotGrammar } : {}),
    requiredLocks: [...new Set(shot.requiredLocks.filter((id) => input.allowedLockIds.has(id)))],
    unresolvedAssets: [...new Set(shot.unresolvedAssets)],
  }));

  const result = scenarioShotPlanSchema.safeParse({
    version: SCENARIO_SHOT_PLAN_VERSION,
    sceneId: input.raw.sceneId,
    targetDurationSeconds: target,
    shots: normalized,
  });
  if (!result.success) {
    throw new ScenarioShotPlanDurationError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return result.data;
}
