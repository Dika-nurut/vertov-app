import { describe, expect, it } from 'vitest';
import {
  ASSIST_PRICING,
  assistCostUsdForBudget,
  creditsForCostUsd,
  modelPrice,
} from './assist-tiers';
import {
  attemptUsd,
  computeShotPlanSettlement,
  estimateShotPlanBytes,
  packShotPlanBatch,
  SHOT_PLAN_BUDGET,
  SHOT_PLAN_BYTES_PER_SHOT,
  SHOT_PLAN_CEILING_CREDITS,
  SHOT_PLAN_ID_MAX,
  SHOT_PLAN_INPUT_CHARS,
  SHOT_PLAN_MAX_ATTEMPTS,
  SHOT_PLAN_MAX_SCENES,
  SHOT_PLAN_MODEL,
  SHOT_PLAN_PROMPT_MAX_CHARS,
  shotPlanCapacity,
  shotPlanResultSchema,
  shotPlanSourceHash,
  validateShotPlanScene,
} from './shot-plan';
import { LLM_PRICING_WORKBOOK, llmPricingRecord } from './llm-pricing-workbook';

const price = modelPrice(SHOT_PLAN_MODEL);

const usage = (values: {
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}) => ({
  usage: {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    costUsd: null,
    ...values,
  },
});

describe('shot plan pricing', () => {
  it('derives the ceiling from the retry budget and model price, not a pinned digit', () => {
    // The ceiling is cost-plus at the margin floor, so it MOVES whenever finance
    // re-bases the landed FX rate — it went 21 → 23 when the retired 76.5 basis
    // was corrected to 106.182. A hard-coded number here would have let
    // production re-derive correctly while this suite asserted the retired
    // answer and stayed green, which is the exact failure that shipped an ~11%
    // under-price before. Assert the derivation instead.
    expect(SHOT_PLAN_CEILING_CREDITS).toBe(
      creditsForCostUsd(
        SHOT_PLAN_MAX_ATTEMPTS * assistCostUsdForBudget(SHOT_PLAN_BUDGET, price),
        LLM_PRICING_WORKBOOK.financial.marginFloor,
      ),
    );
    expect(SHOT_PLAN_CEILING_CREDITS).toBe(llmPricingRecord('boards_shot_plan', 'default').credits);
    expect(SHOT_PLAN_CEILING_CREDITS).toBeGreaterThan(0);
  });

  it('clears the assist credit-floor margin guardrail', () => {
    const costRub =
      SHOT_PLAN_MAX_ATTEMPTS *
      assistCostUsdForBudget(SHOT_PLAN_BUDGET, price) *
      ASSIST_PRICING.landedRubPerUsd;
    const revenueRub = SHOT_PLAN_CEILING_CREDITS * ASSIST_PRICING.creditFloorRub;
    const margin = 1 - costRub / revenueRub;
    expect(margin).toBeGreaterThanOrEqual(LLM_PRICING_WORKBOOK.financial.marginFloor);
  });
});

describe('shot plan attempt settlement inputs', () => {
  it('uses a provider-reported non-negative cost', () => {
    expect(attemptUsd(usage({ costUsd: 0.007 }), price)).toBe(0.007);
  });

  it('derives cost from whichever token fields are present', () => {
    expect(attemptUsd(usage({ inputTokens: 2_000, outputTokens: null }), price)).toBe(
      (2_000 * price.input) / 1e6,
    );
  });

  it('uses the single-attempt ceiling when usage has no cost or tokens', () => {
    expect(attemptUsd(usage({ costUsd: null, inputTokens: null, outputTokens: null }), price)).toBe(
      assistCostUsdForBudget(SHOT_PLAN_BUDGET, price),
    );
  });

  it('uses the single-attempt ceiling when usage is null', () => {
    expect(attemptUsd({ usage: null }, price)).toBe(
      assistCostUsdForBudget(SHOT_PLAN_BUDGET, price),
    );
  });

  it('uses the single-attempt ceiling when the usage key is absent entirely', () => {
    expect(attemptUsd({}, price)).toBe(assistCostUsdForBudget(SHOT_PLAN_BUDGET, price));
  });

  it('charges nothing when no provider attempt was made', () => {
    expect(attemptUsd(undefined, price)).toBe(0);
  });
});

describe('shot plan settlement', () => {
  it('charges far less than the reserved ceiling for typical usage', () => {
    const settlement = computeShotPlanSettlement({
      reserved: SHOT_PLAN_CEILING_CREDITS,
      attempts: [usage({ inputTokens: 600, outputTokens: 300 })],
      price,
    });
    expect(settlement.spent).toBeLessThan(SHOT_PLAN_CEILING_CREDITS);
    expect(settlement.unspent).toBe(SHOT_PLAN_CEILING_CREDITS - settlement.spent);
  });

  it('clamps actual usage above the reservation and never over-charges', () => {
    const settlement = computeShotPlanSettlement({
      reserved: SHOT_PLAN_CEILING_CREDITS,
      attempts: [
        usage({
          inputTokens: SHOT_PLAN_BUDGET.input * 2,
          outputTokens: SHOT_PLAN_BUDGET.output * 2,
        }),
        usage({
          inputTokens: SHOT_PLAN_BUDGET.input * 2,
          outputTokens: SHOT_PLAN_BUDGET.output * 2,
        }),
      ],
      price,
    });
    expect(settlement.spent).toBe(SHOT_PLAN_CEILING_CREDITS);
    expect(settlement.unspent).toBe(0);
  });
});

describe('shot plan batch packing', () => {
  it('keeps each batch within the scene-count and character bounds', () => {
    const scenes = Array.from({ length: SHOT_PLAN_MAX_SCENES + 1 }, (_, index) => ({
      id: `scene-${index}`,
      sourceText: 'x'.repeat(4_000),
    }));
    const overheadChars = 1_000;
    const batches = packShotPlanBatch(scenes, overheadChars);

    expect(batches.every((batch) => batch.length <= SHOT_PLAN_MAX_SCENES)).toBe(true);
    expect(
      batches.every(
        (batch) =>
          overheadChars + batch.reduce((sum, scene) => sum + scene.sourceText.length, 0) <=
          SHOT_PLAN_INPUT_CHARS,
      ),
    ).toBe(true);
  });

  it('puts a scene larger than the remaining budget in its own truncated batch', () => {
    const scenes = [
      { id: 'first', sourceText: 'a'.repeat(20_000) },
      { id: 'oversized', sourceText: 'b'.repeat(6_000) },
    ];
    const batches = packShotPlanBatch(scenes, 43_000);

    expect(batches).toHaveLength(2);
    expect(batches[1]?.map((scene) => scene.id)).toEqual(['oversized']);
    expect(batches[1]?.[0]?.sourceText.length).toBe(5_000);
  });
});

describe('shot plan source identity', () => {
  const input = {
    version: 'sp-1',
    boardId: 'board-1',
    scriptId: 'script-1',
    maxShotsPerScene: 6,
  };

  it('distinguishes identical text hashes when scene node ids differ', () => {
    const first = shotPlanSourceHash({
      ...input,
      scenes: [{ id: 'scene-a', hash: 'same-text' }],
    });
    const second = shotPlanSourceHash({
      ...input,
      scenes: [{ id: 'scene-b', hash: 'same-text' }],
    });
    expect(first).not.toBe(second);
  });

  it('preserves request order in the source hash', () => {
    const first = shotPlanSourceHash({
      ...input,
      scenes: [
        { id: 'scene-a', hash: 'hash-a' },
        { id: 'scene-b', hash: 'hash-b' },
      ],
    });
    const second = shotPlanSourceHash({
      ...input,
      scenes: [
        { id: 'scene-b', hash: 'hash-b' },
        { id: 'scene-a', hash: 'hash-a' },
      ],
    });
    expect(first).not.toBe(second);
  });
});

describe('shot plan capacity', () => {
  it('fails the edge inequality while the node inequality still passes', () => {
    const capacity = shotPlanCapacity({
      currentNodes: 0,
      currentEdges: 1_000,
      currentBytes: 0,
      sceneCount: 40,
      maxShotsPerScene: 6,
    });
    expect(capacity.nodes).toBe(true);
    expect(capacity.edges).toBe(false);
    expect(capacity.scenesWouldFit).toBe(33);
  });
});

describe('shot plan scene validation', () => {
  it('drops a location from castNodeIds when its role is not character', () => {
    const scene = shotPlanResultSchema.parse({
      scenes: [
        {
          sceneNodeId: 'scene-1',
          complete: true,
          shots: [
            {
              action: 'Action',
              prompt: 'Prompt',
              castNodeIds: ['location-1', 'character-1'],
              durationSeconds: 5,
            },
          ],
        },
      ],
    }).scenes[0]!;
    const validated = validateShotPlanScene(
      scene,
      new Map([
        ['location-1', { castKind: 'location' }],
        ['character-1', { castKind: 'character' }],
      ]),
      'Action',
    );
    expect(validated.shots[0]?.castNodeIds).toEqual(['character-1']);
  });

  it('keeps products in castNodeIds but rejects a product as locationNodeId', () => {
    const scene = shotPlanResultSchema.parse({
      scenes: [
        {
          sceneNodeId: 'scene-1',
          complete: true,
          shots: [
            {
              action: 'Action',
              prompt: 'Prompt',
              castNodeIds: ['product-1'],
              locationNodeId: 'product-1',
              durationSeconds: 5,
            },
          ],
        },
      ],
    }).scenes[0]!;
    const validated = validateShotPlanScene(
      scene,
      new Map([['product-1', { castKind: 'product' }]]),
      'Action',
    );

    expect(validated.shots[0]?.castNodeIds).toEqual(['product-1']);
    expect(validated.shots[0]).not.toHaveProperty('locationNodeId');
  });

  it('drops dialogue that is not a whitespace-normalised source substring', () => {
    const scene = shotPlanResultSchema.parse({
      scenes: [
        {
          sceneNodeId: 'scene-1',
          complete: true,
          shots: [
            {
              action: 'Action',
              prompt: 'Prompt',
              castNodeIds: [],
              durationSeconds: 5,
              dialogue: 'This was not said',
            },
          ],
        },
      ],
    }).scenes[0]!;
    const validated = validateShotPlanScene(scene, new Map(), 'MARIA\nI will return.');
    expect(validated.shots[0]).not.toHaveProperty('dialogue');
  });
});

describe('shot plan byte estimate', () => {
  it('keeps the maximal planner-generated shot below the per-shot byte bound', () => {
    const promptId = 'p'.repeat(SHOT_PLAN_ID_MAX);
    const generateId = 'g'.repeat(SHOT_PLAN_ID_MAX);
    const sceneId = 's'.repeat(SHOT_PLAN_ID_MAX);
    const referenceIds = ['a', 'b', 'c', 'd', 'l'].map((prefix) => prefix.repeat(SHOT_PLAN_ID_MAX));
    const serialized = JSON.stringify({
      nodes: [
        {
          id: promptId,
          type: 'prompt',
          version: 1,
          position: { x: 0, y: 0 },
          data: { text: 'я'.repeat(SHOT_PLAN_PROMPT_MAX_CHARS), sourceSceneNodeId: sceneId },
        },
        {
          id: generateId,
          type: 'generate',
          version: 1,
          position: { x: 0, y: 0 },
          data: {
            mode: 'video',
            prompt: '',
            durationSeconds: 120,
            sourceSceneNodeId: sceneId,
            status: 'idle',
            count: 1,
            videoResolution: '720p',
            videoAspect: '16:9',
            generateAudio: true,
            imageAspect: '1:1',
            imageQuality: '2K',
            shotOrdinal: 8,
            plannedFromHash: sceneId,
            plannerVersion: 'sp-1',
          },
        },
      ],
      edges: Array.from({ length: 5 }, (_, index) => ({
        id: `${'e'.repeat(SHOT_PLAN_ID_MAX - 1)}${index}`,
        source: index === 0 ? promptId : referenceIds[index - 1]!,
        target: generateId,
        sourceHandle: 'out',
        targetHandle: index === 0 ? 'prompt' : `images[${index - 1}]`,
      })),
    });
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(SHOT_PLAN_BYTES_PER_SHOT);
    expect(estimateShotPlanBytes(1)).toBe(SHOT_PLAN_BYTES_PER_SHOT);
  });
});
