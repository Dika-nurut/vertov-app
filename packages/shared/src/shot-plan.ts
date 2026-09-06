import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  assistCostUsdForBudget,
  creditsForCostUsd,
  modelPrice,
  type ModelPriceUsdPerMTok,
} from './assist-tiers';
import { BOARD_LIMITS } from './board-contract';
import { LLM_PRICING_WORKBOOK, llmPricingRecord } from './llm-pricing-workbook';

const SHOT_PLAN_WORKBOOK = llmPricingRecord('boards_shot_plan', 'default');
export const SHOT_PLAN_MODEL = SHOT_PLAN_WORKBOOK.model;
export const SHOT_PLAN_BUDGET = { ...SHOT_PLAN_WORKBOOK.maxTokenBudget } as const;
export const SHOT_PLAN_MAX_ATTEMPTS = SHOT_PLAN_WORKBOOK.primaryMaxAttempts;
export const SHOT_PLAN_DEADLINE_MS = 180_000 as const;
export const SHOT_PLAN_VERSION = 'sp-1' as const;
export const SHOT_PLAN_INPUT_CHARS = 48_000 as const;
export const SHOT_PLAN_CHARS_PER_TOKEN = 2 as const;
export const SHOT_PLAN_MAX_SCENES = 12 as const;
export const SHOT_PLAN_SCENE_MAX_CHARS = 6_000 as const;
export const SHOT_PLAN_PROMPT_MAX_CHARS = 1_000 as const;
export const SHOT_PLAN_MAX_SHOTS = 8 as const;
export const SHOT_PLAN_BYTES_PER_SHOT = 4_500 as const;
export const SHOT_PLAN_ID_MAX = 48 as const;

/**
 * The planner's registered $/Mtok price. Exported because settle-actual (§4) runs
 * in the API route, which must price attempts with the SAME numbers the ceiling
 * was derived from — `modelPrice` fails closed on an unregistered slug.
 */
export const SHOT_PLAN_PRICE = modelPrice(SHOT_PLAN_MODEL);

/** Signed worst-case reserve from the workbook: two complete OpenRouter attempts. */
export const SHOT_PLAN_CEILING_CREDITS = SHOT_PLAN_WORKBOOK.credits;

const shotPlanShotSchema = z
  .object({
    action: z.string().max(240),
    prompt: z.string().max(SHOT_PLAN_PROMPT_MAX_CHARS),
    castNodeIds: z.array(z.string().max(128)).max(4),
    locationNodeId: z.string().max(128).optional(),
    durationSeconds: z.number().int().min(1).max(120),
    dialogue: z.string().max(300).optional(),
    cue: z.string().max(64).optional(),
  })
  .strict();

const shotPlanSceneSchema = z
  .object({
    sceneNodeId: z.string().max(128),
    complete: z.boolean(),
    shots: z.array(shotPlanShotSchema).min(1).max(SHOT_PLAN_MAX_SHOTS),
  })
  .strict();

export const shotPlanResultSchema = z
  .object({ scenes: z.array(shotPlanSceneSchema).max(SHOT_PLAN_MAX_SCENES) })
  .strict();

export const shotPlanStoredResultSchema = z
  .object({
    version: z.literal(SHOT_PLAN_VERSION),
    creditsSpent: z.number().int().min(1),
    scenes: shotPlanResultSchema.shape.scenes,
  })
  .strict();

export type ShotPlanShot = z.infer<typeof shotPlanShotSchema>;
export type ShotPlanScene = z.infer<typeof shotPlanSceneSchema>;
export type ShotPlanResult = z.infer<typeof shotPlanResultSchema>;
export type ShotPlanStoredResult = z.infer<typeof shotPlanStoredResultSchema>;

export interface ShotPlanUsage {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  [key: string]: unknown;
}

/**
 * An attempt that REACHED the provider. Attempts refused before `fetch` are not
 * in the array at all — there is deliberately no "this one was free" flag, since
 * a flag is a way to zero out a real attempt.
 */
export interface ShotPlanAttempt {
  usage?: ShotPlanUsage | null;
  [key: string]: unknown;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function oneAttemptCeilingUsd(price: ModelPriceUsdPerMTok): number {
  return assistCostUsdForBudget(SHOT_PLAN_BUDGET, price);
}

export function attemptUsd(
  attempt: ShotPlanAttempt | null | undefined,
  price: ModelPriceUsdPerMTok,
): number {
  if (!attempt) return 0;

  // Missing usage is NOT free. `parseOpenAiUsage` returns null when the provider
  // omits the block, and an absent key is the same story — both mean "we burned
  // tokens and cannot see how many", so both cost the attempt ceiling. Reading
  // either as zero is a margin hole the provider could open without telling us.
  const usage = attempt.usage;
  if (usage === undefined || usage === null) return oneAttemptCeilingUsd(price);
  if (isNonNegativeNumber(usage.costUsd)) return usage.costUsd;

  const inputTokens = isNonNegativeNumber(usage.inputTokens) ? usage.inputTokens : null;
  const outputTokens = isNonNegativeNumber(usage.outputTokens) ? usage.outputTokens : null;
  if (inputTokens === null && outputTokens === null) return oneAttemptCeilingUsd(price);

  return ((inputTokens ?? 0) * price.input + (outputTokens ?? 0) * price.output) / 1e6;
}

export function computeShotPlanSettlement(input: {
  reserved: number;
  attempts: readonly (ShotPlanAttempt | null | undefined)[];
  price: ModelPriceUsdPerMTok;
}): { spent: number; unspent: number } {
  const actualUsd = input.attempts.reduce(
    (sum, attempt) => sum + attemptUsd(attempt, input.price),
    0,
  );
  const spent = Math.min(
    input.reserved,
    Math.max(1, creditsForCostUsd(actualUsd, LLM_PRICING_WORKBOOK.financial.marginFloor)),
  );
  return { spent, unspent: input.reserved - spent };
}

function sceneText(scene: unknown): string {
  if (typeof scene === 'string') return scene;
  if (scene !== null && typeof scene === 'object') {
    const data = scene as Record<string, unknown>;
    if (typeof data.sourceText === 'string') return data.sourceText;
    if (typeof data.text === 'string') return data.text;
  }
  throw new TypeError('shot plan scene must contain sourceText');
}

function sceneWithText<T>(scene: T, text: string): T {
  if (typeof scene === 'string') return text as T;
  const data = scene as Record<string, unknown>;
  if (typeof data.sourceText === 'string') return { ...data, sourceText: text } as T;
  if (typeof data.text === 'string') return { ...data, text } as T;
  return scene;
}

export function packShotPlanBatch<T>(scenes: readonly T[], overheadChars: number): T[][] {
  const overhead = Math.max(0, overheadChars);
  const remainingForScenes = Math.max(0, SHOT_PLAN_INPUT_CHARS - overhead);
  const items = scenes.map((scene) => {
    const text = sceneText(scene);
    const cappedText = text.slice(0, SHOT_PLAN_SCENE_MAX_CHARS);
    return { scene, text: cappedText, chars: cappedText.length };
  });

  const batches: T[][] = [];
  let batch: T[] = [];
  let batchChars = 0;

  const pushBatch = () => {
    if (batch.length > 0) batches.push(batch);
    batch = [];
    batchChars = 0;
  };

  for (const item of items) {
    if (batch.length === SHOT_PLAN_MAX_SCENES || batchChars + item.chars > remainingForScenes) {
      pushBatch();
    }

    if (item.chars > remainingForScenes) {
      const ownText = item.text.slice(0, remainingForScenes);
      batches.push([sceneWithText(item.scene, ownText)]);
      continue;
    }

    batch.push(sceneWithText(item.scene, item.text));
    batchChars += item.chars;
  }

  pushBatch();
  return batches;
}

export function shotPlanSourceHash(input: {
  version: string;
  boardId: string;
  scriptId: string;
  maxShotsPerScene: number;
  scenes: readonly { id: string; hash: string }[];
}): string {
  const source = [
    input.version,
    input.boardId,
    input.scriptId,
    String(input.maxShotsPerScene),
    ...input.scenes.map((scene) => `${scene.id}:${scene.hash}`),
  ].join('\n');
  return createHash('sha256').update(source).digest('hex');
}

export function estimateShotPlanBytes(shotCount: number): number {
  return shotCount * SHOT_PLAN_BYTES_PER_SHOT;
}

const SHOT_PLAN_BOARD_MAX_NODES = BOARD_LIMITS.nodes;
const SHOT_PLAN_BOARD_MAX_EDGES = BOARD_LIMITS.edges;
const SHOT_PLAN_BOARD_MAX_BYTES = BOARD_LIMITS.stateBytes;
const SHOT_PLAN_BOARD_BYTES_HEADROOM = 0.9;

export interface ShotPlanCapacity {
  nodes: boolean;
  edges: boolean;
  bytes: boolean;
  scenesWouldFit: number;
}

export function shotPlanCapacity(input: {
  currentNodes: number;
  currentEdges: number;
  currentBytes: number;
  sceneCount: number;
  maxShotsPerScene: number;
}): ShotPlanCapacity {
  const plannedShots = input.sceneCount * input.maxShotsPerScene;
  const plannedNodes = plannedShots * 2;
  const plannedEdges = plannedShots * 5;
  const plannedBytes = estimateShotPlanBytes(plannedShots);
  const byteLimit = SHOT_PLAN_BOARD_MAX_BYTES * SHOT_PLAN_BOARD_BYTES_HEADROOM;

  const nodes = input.currentNodes + plannedNodes <= SHOT_PLAN_BOARD_MAX_NODES;
  const edges = input.currentEdges + plannedEdges <= SHOT_PLAN_BOARD_MAX_EDGES;
  const bytes = input.currentBytes + plannedBytes <= byteLimit;

  const shotsPerScene = input.maxShotsPerScene;
  const scenesByNodes =
    shotsPerScene > 0
      ? Math.floor((SHOT_PLAN_BOARD_MAX_NODES - input.currentNodes) / (shotsPerScene * 2))
      : 0;
  const scenesByEdges =
    shotsPerScene > 0
      ? Math.floor((SHOT_PLAN_BOARD_MAX_EDGES - input.currentEdges) / (shotsPerScene * 5))
      : 0;
  const scenesByBytes =
    shotsPerScene > 0
      ? Math.floor((byteLimit - input.currentBytes) / (shotsPerScene * SHOT_PLAN_BYTES_PER_SHOT))
      : 0;
  const capacity = Math.max(0, Math.min(scenesByNodes, scenesByEdges, scenesByBytes));

  return {
    nodes,
    edges,
    bytes,
    scenesWouldFit: Math.min(Math.max(0, input.sceneCount), capacity),
  };
}

export type ShotPlanDictionary =
  | ReadonlyMap<string, { castKind?: unknown }>
  | Readonly<Record<string, { castKind?: unknown }>>;

function dictionaryEntry(
  dictionary: ShotPlanDictionary,
  id: string,
): { castKind?: unknown } | undefined {
  if (dictionary instanceof Map) return dictionary.get(id);
  return (dictionary as Readonly<Record<string, { castKind?: unknown }>>)[id];
}

function truncateAction(value: string, max: number): string {
  if (value.length <= max) return value;
  const capped = value.slice(0, max);
  for (let index = capped.length - 1; index >= 0; index -= 1) {
    if (/\s/u.test(capped[index] ?? '')) {
      return capped.slice(0, index).trimEnd();
    }
  }
  return capped;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function preservesSourceText(value: string, sceneSourceText: string): boolean {
  const normalizedValue = normalizeWhitespace(value);
  return (
    normalizedValue.length > 0 && normalizeWhitespace(sceneSourceText).includes(normalizedValue)
  );
}

export function validateShotPlanScene(
  scene: ShotPlanScene,
  dictionary: ShotPlanDictionary,
  sceneSourceText: string,
): ShotPlanScene {
  const shots = scene.shots.map((shot) => {
    const validatedShot: ShotPlanShot = {
      action: truncateAction(shot.action, 240),
      prompt: shot.prompt.slice(0, SHOT_PLAN_PROMPT_MAX_CHARS),
      castNodeIds: shot.castNodeIds.filter((id) => {
        const castKind = dictionaryEntry(dictionary, id)?.castKind;
        return castKind === 'character' || castKind === 'product';
      }),
      durationSeconds: Math.min(120, Math.max(1, shot.durationSeconds)),
    };

    if (
      shot.locationNodeId !== undefined &&
      dictionaryEntry(dictionary, shot.locationNodeId)?.castKind === 'location'
    ) {
      validatedShot.locationNodeId = shot.locationNodeId;
    }
    if (shot.dialogue !== undefined && preservesSourceText(shot.dialogue, sceneSourceText)) {
      validatedShot.dialogue = shot.dialogue;
    }
    if (shot.cue !== undefined && preservesSourceText(shot.cue, sceneSourceText)) {
      validatedShot.cue = shot.cue;
    }

    return validatedShot;
  });

  return { ...scene, shots };
}
