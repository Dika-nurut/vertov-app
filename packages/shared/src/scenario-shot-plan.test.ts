import { describe, expect, it } from 'vitest';
import {
  normalizeScenarioShotPlan,
  scenarioShotPlanRawSchema,
  ScenarioShotPlanDurationError,
} from './scenario-shot-plan';

const raw = (durations: number[]) =>
  scenarioShotPlanRawSchema.parse({
    sceneId: 'scene:1',
    shots: durations.map((durationSec, index) => ({
      order: index + 1,
      title: `Кадр ${index + 1}`,
      durationSec,
      dramaticBeat: 'Конкретное изменение состояния.',
      promptDraft: 'Инертный черновик промпта.',
      requiredLocks: ['canon:character:1'],
      unresolvedAssets: [],
    })),
  });

describe('Scenario shot-plan contract', () => {
  it('normalizes order and filters unknown lock ids while preserving exact duration', () => {
    const plan = normalizeScenarioShotPlan({
      raw: raw([5, 6]),
      targetDurationSeconds: 12,
      allowedLockIds: new Set(['canon:character:1']),
    });
    expect(plan.shots.map((shot) => shot.order)).toEqual([1, 2]);
    expect(plan.shots.map((shot) => shot.durationSec)).toEqual([6, 6]);
    expect(plan.shots[0]!.requiredLocks).toEqual(['canon:character:1']);
  });

  it('rejects semantic duration disagreement instead of redistributing it silently', () => {
    expect(() =>
      normalizeScenarioShotPlan({
        raw: raw([3, 3]),
        targetDurationSeconds: 20,
        allowedLockIds: new Set(),
      }),
    ).toThrow(ScenarioShotPlanDurationError);
  });

  it('rejects a long scene collapsed into one shot', () => {
    expect(() =>
      normalizeScenarioShotPlan({
        raw: raw([12]),
        targetDurationSeconds: 12,
        allowedLockIds: new Set(),
      }),
    ).toThrow('scene collapsed into one shot');
  });
});
