import { describe, expect, it } from 'vitest';
import { costCatalogue } from '@seed/db';
import { emitShadowRoute, type ShadowRouteLogger } from './route-shadow';

function logger() {
  const info: Array<Record<string, unknown>> = [];
  const warn: Array<Record<string, unknown>> = [];
  const value: ShadowRouteLogger = {
    info(bindings) {
      info.push(bindings);
    },
    warn(bindings) {
      warn.push(bindings);
    },
  };
  return { value, info, warn };
}

describe('route selection shadow logging', () => {
  it('emits one structured shadow decision without making it load-bearing', () => {
    const entry = costCatalogue().find(
      (candidate) =>
        candidate.modelId === 'wan-2-7' && candidate.rung === '720p' && candidate.mode === 't2v',
    );
    if (!entry) throw new Error('Wan shadow fixture is missing');
    const logs = logger();
    emitShadowRoute({
      jobId: 'job-shadow-test',
      modelId: entry.modelId,
      entry,
      request: {
        references: 0,
        durationSeconds: 5,
        frames: [],
        audio: false,
        resolution: entry.rung,
        aspect: '16:9',
        units: entry.baseUnits,
        revenueRub: entry.credits * 0.33111111111111113,
        health: () => 'healthy',
      },
      now: new Date('2026-08-08T00:00:00.000Z'),
      legacyChoice: 'kie',
      apiForcedGateway: 'kie',
      logger: logs.value,
    });
    expect(logs.info).toHaveLength(1);
    expect(logs.info[0]).toMatchObject({
      shadowRoute: {
        jobId: 'job-shadow-test',
        modelId: 'wan-2-7',
        rung: '720p',
        legacyChoice: 'kie',
        agrees: true,
        apiForcedGateway: 'kie',
      },
    });
    expect(logs.warn).toHaveLength(0);
  });

  it('swallows a selector throw so the surrounding job response is unchanged', () => {
    const entry = costCatalogue()[0]!;
    const logs = logger();
    const response = { statusCode: 201, body: { jobId: 'job-shadow-test', status: 'queued' } };
    const before = structuredClone(response);
    emitShadowRoute({
      jobId: 'job-shadow-test',
      modelId: entry.modelId,
      entry,
      request: {
        references: 0,
        durationSeconds: null,
        frames: [],
        audio: false,
        resolution: entry.rung,
        aspect: null,
        units: entry.baseUnits,
        revenueRub: entry.credits,
        health: () => 'healthy',
      },
      now: new Date('2026-08-08T00:00:00.000Z'),
      legacyChoice: 'kie',
      apiForcedGateway: 'kie',
      logger: logs.value,
      selector: () => {
        throw new Error('synthetic selector failure');
      },
    });
    expect(response).toEqual(before);
    expect(logs.info).toHaveLength(0);
    expect(logs.warn[0]).toMatchObject({
      shadowRouteError: {
        jobId: 'job-shadow-test',
        error: 'synthetic selector failure',
      },
    });
  });
});
