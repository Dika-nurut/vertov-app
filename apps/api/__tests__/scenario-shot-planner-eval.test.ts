import { describe, expect, it } from 'vitest';
import {
  runScenarioShotPlanMockEval,
  scoreScenarioShotPlan,
  SCENARIO_SHOT_PLAN_EVAL_CORPUS,
} from '../src/scenario-shot-planner-eval';

describe('Scenario shot-planner eval corpus', () => {
  it('contains 13 scenes per format and 52 scenes total', () => {
    expect(SCENARIO_SHOT_PLAN_EVAL_CORPUS).toHaveLength(52);
    expect(new Set(SCENARIO_SHOT_PLAN_EVAL_CORPUS.map((entry) => entry.id)).size).toBe(52);
    for (const format of ['film', 'social', 'ad', 'sketch'] as const) {
      expect(
        SCENARIO_SHOT_PLAN_EVAL_CORPUS.filter((entry) => entry.format === format),
      ).toHaveLength(13);
    }
  });

  it('golden plans pass every rubric dimension on the first mock attempt', () => {
    for (const entry of SCENARIO_SHOT_PLAN_EVAL_CORPUS) {
      expect(scoreScenarioShotPlan(entry, entry.golden), entry.id).toMatchObject({
        validJsonFirstAttempt: true,
        durationSumExact: true,
        shotsConcrete: true,
        locksCorrect: true,
        unresolvedAssetsCorrect: true,
        passed: true,
        score: 1,
      });
    }
  });

  it('reports both registered comparator models without provider spend', () => {
    const report = runScenarioShotPlanMockEval();
    expect(report).toHaveLength(2);
    expect(report.map((row) => row.model)).toEqual([
      'deepseek/deepseek-v4-flash',
      'qwen/qwen3.5-plus-02-15',
    ]);
    for (const row of report) {
      expect(row.mode).toBe('mock_replay');
      expect(row.sceneCount).toBe(52);
      expect(row.validJsonRate).toBe(1);
      expect(row.passRate).toBe(1);
      expect(row.meanScore).toBe(1);
      expect(row.costPerSuccessUsd).toBeGreaterThan(0);
    }
  });
});
