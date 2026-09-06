import { describe, expect, it } from 'vitest';
import pricing from '../seed/llm-pricing.generated.json';

describe('active Scenario context-band workbook contract', () => {
  const rows = pricing.records.filter((row) => row.surface === 'scenario_assist_band');

  it('contains every tier × scope × band × conspect predicate', () => {
    expect(rows).toHaveLength(84);
    for (const tier of ['economy', 'standard', 'max']) {
      for (const scope of ['project', 'span', 'scene', 'script']) {
        const selected = rows.filter((row) => row.selector.startsWith(`${tier}/${scope}/`));
        expect(selected.length, `${tier}/${scope}`).toBe((scope === 'script' ? 5 : 3) * 2);
        expect(new Set(selected.map((row) => row.selector.split('/').at(-1))).size).toBe(2);
      }
    }
  });

  it('holds the active no-cache worst route above the 25% floor', () => {
    expect(pricing.financial.scenarioBandMarginFloor).toBe(0.25);
    expect(rows.every((row) => row.marginAtFloor >= 0.25)).toBe(true);
    const structurize = pricing.records.find(
      (row) => row.surface === 'scenario_structurize_active',
    );
    expect(structurize?.credits).toBe(4);
    expect(structurize?.marginAtFloor).toBeGreaterThanOrEqual(0.25);
  });

  it('records explicit cache economics without assuming an unverified discount', () => {
    const active = [
      ...rows,
      ...pricing.records.filter((row) => row.surface === 'scenario_structurize_active'),
    ];
    expect(active.every((row) => row.cacheReadMultiplier === 1)).toBe(true);
    expect(active.every((row) => row.cacheWriteMultiplier === 1)).toBe(true);
    expect(active.every((row) => row.cacheStatus === 'unverified_disabled')).toBe(true);
    expect(active.every((row) => row.cacheEvidence.includes('OWNER-GATED PROBE'))).toBe(true);
  });
});
