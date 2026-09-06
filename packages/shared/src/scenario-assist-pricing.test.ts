import { describe, expect, it } from 'vitest';
import {
  planScenarioAssistPricing,
  scenarioContextBand,
  ScenarioContextLimitError,
  SCENARIO_CONTEXT_BANDS,
} from './scenario-assist-pricing';

describe('Scenario workbook context bands', () => {
  it('selects the smallest UTF-8 envelope and changes price by band', () => {
    const small = planScenarioAssistPricing({
      tier: 'standard',
      scope: 'scene',
      inputBytes: 8_001,
      conspectIncluded: false,
    });
    const large = planScenarioAssistPricing({
      tier: 'standard',
      scope: 'scene',
      inputBytes: 16_001,
      conspectIncluded: false,
    });
    expect(small.inputBand).toBe('16k');
    expect(large.inputBand).toBe('28k');
    expect(large.credits).toBeGreaterThan(small.credits);
  });

  it('prices rolling conspect only when the predicate says it is present', () => {
    const without = planScenarioAssistPricing({
      tier: 'max',
      scope: 'project',
      inputBytes: 7_900,
      conspectIncluded: false,
    });
    const withConspect = planScenarioAssistPricing({
      tier: 'max',
      scope: 'project',
      inputBytes: 7_900,
      conspectIncluded: true,
    });
    expect(withConspect.credits).toBeGreaterThan(without.credits);
  });

  it('prices a pending conspect refresh independently from an existing summary', () => {
    const noSummaryButRefresh = planScenarioAssistPricing({
      tier: 'max',
      scope: 'project',
      inputBytes: 7_900,
      conspectIncluded: false,
      conspectRefreshRequired: true,
    });
    const summaryWithoutRefresh = planScenarioAssistPricing({
      tier: 'max',
      scope: 'project',
      inputBytes: 7_900,
      conspectIncluded: true,
      conspectRefreshRequired: false,
    });
    expect(noSummaryButRefresh.credits).toBeGreaterThan(summaryWithoutRefresh.credits);
    expect(noSummaryButRefresh.conspectRefreshRequired).toBe(true);
    expect(summaryWithoutRefresh.conspectIncluded).toBe(true);
  });

  it('fails closed instead of clipping a whole script past its last band', () => {
    const max = SCENARIO_CONTEXT_BANDS.script.at(-1)!.maxInputBytes;
    expect(() => scenarioContextBand('script', max + 1)).toThrow(ScenarioContextLimitError);
  });
});
