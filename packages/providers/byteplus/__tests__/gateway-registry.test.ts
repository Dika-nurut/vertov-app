import { describe, expect, it } from 'vitest';
import {
  AtlasCloudAdapter,
  KieUnarmedError,
  KieAdapter,
  StubBytePlusAdapter,
  getAdapter,
  getResumeAdapter,
  type WorkflowSpec,
} from '../src/index';

describe("getAdapter('kie') — fail-closed when unarmed (grok/veo are kie-only)", () => {
  it('THROWS in production when kie is unarmed — never the fake-asset stub', () => {
    expect(() => getAdapter('kie', { NODE_ENV: 'production' })).toThrow(KieUnarmedError);
    expect(() =>
      getAdapter('kie', { NODE_ENV: 'production', KIE_MODE: 'stub', KIE_API_KEY: 'x' }),
    ).toThrow(KieUnarmedError);
    // Missing key while mode=live is still unarmed.
    expect(() => getAdapter('kie', { NODE_ENV: 'production', KIE_MODE: 'live' })).toThrow(
      KieUnarmedError,
    );
  });

  it('returns the REAL KieAdapter (not a stub) when armed in production', () => {
    const a = getAdapter('kie', {
      NODE_ENV: 'production',
      KIE_MODE: 'live',
      KIE_API_KEY: 'sk-kie',
    });
    expect(a).not.toBeInstanceOf(StubBytePlusAdapter);
  });

  it('degrades to the stub OUTSIDE production (dev/test convenience)', () => {
    expect(getAdapter('kie', { NODE_ENV: 'test' })).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('the ALLOW_MOCK_IN_PROD hatch permits the stub in prod (loud, opt-in)', () => {
    expect(getAdapter('kie', { NODE_ENV: 'production', ALLOW_MOCK_IN_PROD: '1' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
  });
});

describe('getAdapter — gateway registry', () => {
  it('atlascloud + stub mode → zero-spend stub (no key needed)', () => {
    expect(getAdapter('atlascloud', { ATLASCLOUD_MODE: 'stub' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
  });

  it('atlascloud + live + key → real AtlasCloud adapter', () => {
    const a = getAdapter('atlascloud', {
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'apikey-x',
    });
    expect(a).toBeInstanceOf(AtlasCloudAdapter);
  });

  it('atlascloud live but NO key → stub (never spends without a key)', () => {
    expect(getAdapter('atlascloud', { ATLASCLOUD_MODE: 'live' })).toBeInstanceOf(
      StubBytePlusAdapter,
    );
  });

  it('explicit gateway resolves to the requested adapter', () => {
    const a = getAdapter('atlascloud', {
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'apikey-x',
    });
    expect(a).toBeInstanceOf(AtlasCloudAdapter);
  });

  it('undefined gateway throws — no global default provider is configured', () => {
    expect(() => getAdapter(undefined, {})).toThrow('gateway_required');
  });

  it('stub gateway is always the stub', () => {
    expect(getAdapter('stub', {})).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('getResumeAdapter binds a live gateway key to its real adapter', () => {
    const a = getResumeAdapter('atlascloud', {
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'apikey-x',
    });
    expect(a).toBeInstanceOf(AtlasCloudAdapter);
  });

  it('getResumeAdapter returns null for an unknown/removed gateway (no silent fallback)', () => {
    // A handle stamped by a gateway we no longer recognise must NOT be polled
    // against some catch-all adapter.
    expect(getResumeAdapter('gone', {})).toBeNull();
  });

  it('getResumeAdapter refuses an unarmed Kie handle but binds an armed one', () => {
    // An unarmed persisted Kie handle must never be resumed against the
    // zero-spend development stub.
    expect(getResumeAdapter('kie', {})).toBeNull();
    expect(getResumeAdapter('kie', { KIE_MODE: 'live', KIE_API_KEY: 'sk-kie' })).toBeInstanceOf(
      KieAdapter,
    );
    // LaoZhang is inline-only and its synthetic id cannot be polled.
    expect(getResumeAdapter('laozhang', {})).toBeNull();
  });

  it('getResumeAdapter returns null when the gateway refuses to build (mock fail-closed in prod)', () => {
    expect(getResumeAdapter('mock', { NODE_ENV: 'production' })).toBeNull();
  });

  it('getResumeAdapter builds the mock gateway outside production', () => {
    expect(getResumeAdapter('mock', { NODE_ENV: 'test' })).not.toBeNull();
  });

  it('atlascloud stub runs an image job end-to-end with zero network', async () => {
    const adapter = getAdapter('atlascloud', { ATLASCLOUD_MODE: 'stub' });
    const spec: WorkflowSpec = {
      modelId: 'seedream-4-5',
      providerModelId: 'doubao-seedream-4.5',
      providerEndpoint: '/api/v3/images/generations',
      kind: 'image',
      prompt: 'тест',
      params: { size: '1:1', n: 1 },
      referenceAssets: [],
      maxDurationSeconds: null,
    };
    const handle = await adapter.generate(spec);
    const result = handle.inlineResult ?? (await adapter.awaitResult(handle, spec));
    expect(result.assets.length).toBeGreaterThan(0);
  });
});
