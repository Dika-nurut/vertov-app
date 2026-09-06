import { describe, expect, it } from 'vitest';
import type { ExecutionSnapshot } from '@seed/shared/execution-snapshot';
import {
  computeSpent,
  executionSnapshotMismatch,
  MANUAL_RECONCILIATION_REQUIRED,
  resolveServingLeg,
} from './job-runner';

const imageSnapshot: ExecutionSnapshot = {
  snapshotVersion: 2,
  model: {
    kind: 'image',
    provider: 'byteplus',
    providerModelId: 'seedream-test',
    providerEndpoint: '/images',
    gatewayOverride: null,
    fallbackGateway: null,
    capabilities: {},
    maxDurationSeconds: null,
    pricing: { source: 'parametric', imageUnitCredits: 10 },
  },
  effectiveGateway: 'mock',
  validatedRequest: { prompt: 'test', params: { n: 1 }, referenceAssets: [] },
  unitsBreakdown: { units: 1, imageUnitCredits: 10, referenceCount: 0 },
  quotedCredits: 10,
};

describe('execution snapshot ↔ job money contract', () => {
  it('accepts matching reserve and settlement facts', () => {
    expect(
      executionSnapshotMismatch({ creditsReserved: 10, creditUnitCost: 10 }, imageSnapshot),
    ).toBe(null);
  });

  it('rejects a quoted reserve mismatch before any provider call', () => {
    expect(
      executionSnapshotMismatch({ creditsReserved: 11, creditUnitCost: 10 }, imageSnapshot),
    ).toContain('quoted credits 10 != reserved credits 11');
  });

  it('rejects a settlement-rate mismatch', () => {
    expect(
      executionSnapshotMismatch({ creditsReserved: 10, creditUnitCost: 11 }, imageSnapshot),
    ).toContain('image unit rate 10 != persisted unit rate 11');
  });
});

describe('legacy image settlement without credit_unit_cost', () => {
  it('uses persisted requested image count to preserve partial-delivery refunds', () => {
    // A legacy reservation of 100 for four requested images must charge 50 when
    // two arrive. The mutable current catalog rate is intentionally irrelevant.
    expect(computeSpent({ kind: 'image' }, 2, 100, null, { n: 4 })).toBe(50);
  });

  it('keeps the manual-reconciliation refusal as a settlement invariant', () => {
    expect(() => computeSpent({ kind: 'image' }, 1, 100, null, { n: 1.5 })).toThrow(
      MANUAL_RECONCILIATION_REQUIRED,
    );
  });
});

describe('recording which gateway leg actually served the job', () => {
  it('records the chain leaf, not the chain alias, when an inner leg served', () => {
    // 'nanobanana' is laozhang → kie → official OpenRouter. A job the 3rd leg
    // served used to be stored as gateway 'nanobanana' at depth 0, i.e. priced at
    // the primary's rate — the leg costs ~2.7x that.
    expect(
      resolveServingLeg({ servedBy: 'openrouter-official', fallbackDepth: 2 }, 'nanobanana'),
    ).toEqual({ gatewayUsed: 'openrouter-official', fallbackDepth: 2 });
  });

  it('records the circuit breaker fallback the same way the chain reports it', () => {
    expect(resolveServingLeg({ servedBy: 'atlascloud', fallbackDepth: 1 }, 'openrouter')).toEqual({
      gatewayUsed: 'atlascloud',
      fallbackDepth: 1,
    });
  });

  it('records the primary leg at depth 0 when the chain says so', () => {
    expect(resolveServingLeg({ servedBy: 'laozhang', fallbackDepth: 0 }, 'nanobanana')).toEqual({
      gatewayUsed: 'laozhang',
      fallbackDepth: 0,
    });
  });

  it('an adapter that cannot fail over at all serves from the routed gateway, depth 0', () => {
    expect(resolveServingLeg(undefined, 'kie')).toEqual({ gatewayUsed: 'kie', fallbackDepth: 0 });
    expect(resolveServingLeg({ seed: 42 }, 'evolink')).toEqual({
      gatewayUsed: 'evolink',
      fallbackDepth: 0,
    });
  });
});
