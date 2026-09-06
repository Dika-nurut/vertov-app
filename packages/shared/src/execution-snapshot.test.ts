import { describe, expect, it } from 'vitest';
import {
  EXECUTION_SNAPSHOT_VERSION,
  executionSnapshotSchema,
  parseExecutionSnapshot,
} from './execution-snapshot';

const v2Snapshot = {
  snapshotVersion: EXECUTION_SNAPSHOT_VERSION,
  model: {
    kind: 'image',
    provider: 'byteplus',
    providerModelId: 'seedream-test',
    providerEndpoint: '/images',
    gatewayOverride: null,
    fallbackGateway: null,
    capabilities: { resolutions: ['1K'] },
    maxDurationSeconds: null,
    pricing: { source: 'parametric', imageUnitCredits: 20 },
  },
  effectiveGateway: 'openrouter',
  validatedRequest: {
    prompt: 'a test frame',
    params: { prompt: 'a test frame', resolution: '1K' },
    referenceAssets: [],
  },
  unitsBreakdown: { units: 1, imageUnitCredits: 20, referenceCount: 0 },
  quotedCredits: 20,
};

// A row written before the v2 purge: same shape plus the mandatory ceiling.
const v1Snapshot = {
  ...v2Snapshot,
  snapshotVersion: 1,
  model: { ...v2Snapshot.model, creditCostPerUnit: 20 },
};

describe('execution snapshot contract', () => {
  it('accepts the immutable pre-queue shape', () => {
    expect(executionSnapshotSchema.parse(v2Snapshot)).toEqual(v2Snapshot);
  });

  it('rejects an unknown version or an extra mutable field', () => {
    expect(() =>
      executionSnapshotSchema.parse({
        ...v2Snapshot,
        snapshotVersion: EXECUTION_SNAPSHOT_VERSION + 1,
      }),
    ).toThrow();
    expect(() =>
      executionSnapshotSchema.parse({ ...v2Snapshot, liveModelId: 'should-not-be-here' }),
    ).toThrow();
  });

  it('rejects a v2 model block that still carries the purged ceiling field', () => {
    expect(() =>
      executionSnapshotSchema.parse({ ...v2Snapshot, model: v1Snapshot.model }),
    ).toThrow();
  });

  describe('parseExecutionSnapshot (worker-side dual-version reader)', () => {
    it('parses a current v2 row unchanged', () => {
      const parsed = parseExecutionSnapshot(v2Snapshot);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.snapshot).toEqual(v2Snapshot);
    });

    it('tolerates an in-flight v1 row and drops the ceiling field from the result', () => {
      const parsed = parseExecutionSnapshot(v1Snapshot);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.snapshot).toEqual(v2Snapshot);
        expect('creditCostPerUnit' in parsed.snapshot.model).toBe(false);
      }
    });

    it('fails loudly on a corrupt row under either version', () => {
      expect(parseExecutionSnapshot({ ...v2Snapshot, quotedCredits: -1 }).ok).toBe(false);
      expect(parseExecutionSnapshot({ ...v1Snapshot, model: null }).ok).toBe(false);
    });
  });
});
