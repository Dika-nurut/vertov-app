import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rules = readFileSync(resolve(process.cwd(), '../../infra/observability/alerts.yml'), 'utf8');

describe('Scenario alert semantics', () => {
  it('never treats sustained normal in-flight traffic as a stuck request', () => {
    expect(rules).not.toMatch(
      /SeedScenarioAssistStuck[\s\S]*?seed_scenario_assist_in_flight\s*>\s*0/,
    );
  });

  it('pages on the terminal hard-deadline outcome', () => {
    expect(rules).toContain('alert: SeedScenarioAssistTimeouts');
    expect(rules).toContain('outcome="aborted_refunded"');
  });
});
