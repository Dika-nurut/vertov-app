import { describe, expect, it } from 'vitest';
import {
  MockGatewayAdapter,
  ProviderError,
  getAdapter,
  mockErrorFor,
  mockPhaseFor,
  parseMockDirective,
  type MockOutcome,
  type WorkflowSpec,
} from '../src/index';

const imageSpec: WorkflowSpec = {
  modelId: 'seedream-4-5',
  providerModelId: 'seedream-4-5',
  providerEndpoint: '/api/v3/images/generations',
  kind: 'image',
  prompt: 'питерская крыша на закате',
  params: { size: '1024x1024' },
  referenceAssets: [],
  maxDurationSeconds: null,
};

const videoSpec: WorkflowSpec = {
  ...imageSpec,
  kind: 'video',
  modelId: 'seedance-1-0',
  prompt: 'кот идёт по крыше',
  params: {},
  maxDurationSeconds: 5,
};

function withMock(spec: WorkflowSpec, directive: unknown): WorkflowSpec {
  return { ...spec, params: { ...spec.params, __mock: directive } };
}

describe('parseMockDirective', () => {
  it('reads a bare string as the outcome', () => {
    expect(parseMockDirective('moderation')).toEqual({ outcome: 'moderation' });
  });
  it('reads object fields field-by-field, ignoring junk', () => {
    expect(
      parseMockDirective({ outcome: 'success', n: 3, seed: 7, resolution: '720p', bogus: 1 }),
    ).toEqual({ outcome: 'success', n: 3, seed: 7, resolution: '720p' });
  });
  it('returns an empty directive for null/garbage (happy path)', () => {
    expect(parseMockDirective(undefined)).toEqual({});
    expect(parseMockDirective(42)).toEqual({});
  });
});

describe('mockErrorFor / mockPhaseFor — exact live shapes', () => {
  const cases: Array<{
    outcome: MockOutcome;
    code: string;
    status: number;
    retryable: boolean;
    phase: 'submit' | 'poll';
  }> = [
    {
      outcome: 'moderation',
      code: 'SUBMIT_REJECTED',
      status: 400,
      retryable: false,
      phase: 'submit',
    },
    { outcome: 'insufficient', code: 'HTTP_402', status: 402, retryable: false, phase: 'submit' },
    { outcome: 'timeout', code: 'TIMEOUT', status: 408, retryable: false, phase: 'poll' },
    { outcome: 'retry', code: 'POLL_UNREACHABLE', status: 503, retryable: true, phase: 'poll' },
    { outcome: 'noasset', code: 'NO_ASSET', status: 200, retryable: false, phase: 'poll' },
  ];
  for (const c of cases) {
    it(`${c.outcome} → ${c.code} (${c.status}, retryable=${c.retryable}, ${c.phase})`, () => {
      const err = mockErrorFor(c.outcome);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err!.code).toBe(c.code);
      expect(err!.status).toBe(c.status);
      expect(err!.retryable).toBe(c.retryable);
      expect(mockPhaseFor(c.outcome)).toBe(c.phase);
    });
  }
  it('success → no error, no phase', () => {
    expect(mockErrorFor('success')).toBeNull();
    expect(mockPhaseFor('success')).toBe('none');
    expect(mockPhaseFor(undefined)).toBe('none');
  });
});

describe('MockGatewayAdapter — registry + back-compat', () => {
  it("getAdapter('mock') returns the mock gateway", () => {
    expect(getAdapter('mock', {})).toBeInstanceOf(MockGatewayAdapter);
  });

  it('no directive ⇒ happy-path image inline result (stub-compatible)', async () => {
    const a = new MockGatewayAdapter();
    const handle = await a.generate(imageSpec);
    expect(handle.providerJobId).toMatch(/^mock-img-/);
    expect(handle.inlineResult?.assets).toHaveLength(1);
    expect(handle.inlineResult!.assets[0]!.contentType).toBe('image/svg+xml');
  });

  it('honours n and is deterministic per spec', async () => {
    const a = new MockGatewayAdapter();
    const h1 = await a.generate(withMock(imageSpec, { outcome: 'success', n: 3 }));
    const h2 = await a.generate(withMock(imageSpec, { outcome: 'success', n: 3 }));
    expect(h1.inlineResult!.assets).toHaveLength(3);
    expect(h1.providerJobId).toBe(h2.providerJobId); // no Date.now → reproducible
    expect(h1.inlineResult!.assets[0]!.bytes.toString()).toBe(
      h2.inlineResult!.assets[0]!.bytes.toString(),
    );
  });

  it('video success ⇒ mp4 via awaitResult, with directive meta', async () => {
    const a = new MockGatewayAdapter();
    const spec = withMock(videoSpec, { outcome: 'success', durationSec: 5, resolution: '720p' });
    const handle = await a.generate(spec);
    expect(handle.inlineResult).toBeUndefined();
    const result = await a.awaitResult(handle, spec);
    expect(result.assets[0]!.contentType).toBe('video/mp4');
    expect(result.meta).toMatchObject({ mock: true, durationSec: 5, resolution: '720p' });
  });
});

describe('MockGatewayAdapter — failure outcomes throw in the right phase', () => {
  it('moderation throws SUBMIT_REJECTED at generate (submit phase)', async () => {
    const a = new MockGatewayAdapter();
    await expect(a.generate(withMock(videoSpec, 'moderation'))).rejects.toMatchObject({
      code: 'SUBMIT_REJECTED',
      status: 400,
      retryable: false,
    });
  });

  it('insufficient throws HTTP_402 at generate', async () => {
    const a = new MockGatewayAdapter();
    await expect(a.generate(withMock(videoSpec, 'insufficient'))).rejects.toMatchObject({
      code: 'HTTP_402',
      retryable: false,
    });
  });

  it('timeout/retry/noasset submit cleanly then throw at awaitResult (poll phase)', async () => {
    const a = new MockGatewayAdapter();
    for (const [outcome, code] of [
      ['timeout', 'TIMEOUT'],
      ['retry', 'POLL_UNREACHABLE'],
      ['noasset', 'NO_ASSET'],
    ] as const) {
      const spec = withMock(videoSpec, outcome);
      const handle = await a.generate(spec); // submit succeeds
      await expect(a.awaitResult(handle, spec)).rejects.toMatchObject({ code });
    }
  });

  it('retry outcome is the only retryable failure (drives BullMQ retry path)', async () => {
    const a = new MockGatewayAdapter();
    const spec = withMock(videoSpec, 'retry');
    const handle = await a.generate(spec);
    await expect(a.awaitResult(handle, spec)).rejects.toMatchObject({ retryable: true });
  });
});

describe('MockGatewayAdapter — serving the T2 media corpus', () => {
  const corpus = [
    { durationSec: 1, path: '/tmp/__nope_short.mp4' },
    {
      durationSec: 5,
      path: new URL('../fixtures/seedance-success.json', import.meta.url).pathname,
    },
  ];
  it('picks the clip nearest the requested durationSec', async () => {
    // Use a real readable file as the "5s" clip; request 4s → nearest is 5s.
    const a = new MockGatewayAdapter({ corpus });
    const spec = withMock(videoSpec, { outcome: 'success', durationSec: 4 });
    const handle = await a.generate(spec);
    const result = await a.awaitResult(handle, spec);
    expect(result.meta).toMatchObject({ servedClip: corpus[1]!.path });
    expect(result.assets[0]!.bytes.byteLength).toBeGreaterThan(0);
    expect(result.assets[0]!.contentType).toBe('video/mp4');
  });
});

describe('MockGatewayAdapter — injected default directive (whole-suite arming)', () => {
  it('applies the constructor default when a job carries none', async () => {
    const a = new MockGatewayAdapter({ defaultDirective: { outcome: 'moderation' } });
    await expect(a.generate(videoSpec)).rejects.toMatchObject({ code: 'SUBMIT_REJECTED' });
  });
  it('per-job directive overrides the default', async () => {
    const a = new MockGatewayAdapter({ defaultDirective: { outcome: 'moderation' } });
    const handle = await a.generate(withMock(imageSpec, { outcome: 'success' }));
    expect(handle.inlineResult?.assets).toHaveLength(1);
  });
});
