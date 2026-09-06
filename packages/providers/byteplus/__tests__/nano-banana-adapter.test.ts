import { describe, expect, it, vi } from 'vitest';
import { NanoBananaAdapter } from '../src/nano-banana-adapter';
import type {
  GenerationHandle,
  GenerationResult,
  ProviderAdapter,
  WorkflowSpec,
} from '../src/types';

function fakeAdapter(opts: {
  generate?: () => Promise<GenerationHandle>;
  awaitResult?: () => Promise<GenerationResult>;
}): ProviderAdapter {
  return {
    generate: opts.generate ?? vi.fn(() => Promise.reject(new Error('not configured'))),
    awaitResult: opts.awaitResult ?? vi.fn(() => Promise.reject(new Error('not configured'))),
  };
}

const spec = {} as WorkflowSpec;
const okResult: GenerationResult = {
  assets: [{ bytes: Buffer.from('x'), contentType: 'image/png', extension: 'png' }],
};

describe('NanoBananaAdapter circuit breaker', () => {
  it('returns the primary result untouched when laozhang succeeds', async () => {
    const primaryGenerate = vi.fn(() =>
      Promise.resolve<GenerationHandle>({ providerJobId: 'lz-1', inlineResult: okResult }),
    );
    const fallbackGenerate = vi.fn();
    const adapter = new NanoBananaAdapter(
      fakeAdapter({ generate: primaryGenerate }),
      fakeAdapter({ generate: fallbackGenerate }),
    );
    const handle = await adapter.generate(spec);
    expect(handle.inlineResult).toBe(okResult);
    expect(fallbackGenerate).not.toHaveBeenCalled();
  });

  it('falls back to kie.ai when laozhang.ai fails, and tags the result', async () => {
    const primary = fakeAdapter({
      generate: () => Promise.reject(new Error('laozhang 503')),
    });
    const fallback = fakeAdapter({
      generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'kie-1' }),
      awaitResult: () => Promise.resolve(okResult),
    });
    const adapter = new NanoBananaAdapter(primary, fallback);
    const handle = await adapter.generate(spec);
    expect(handle.inlineResult?.assets).toEqual(okResult.assets);
    expect(handle.inlineResult?.meta).toMatchObject({
      fellBackFrom: 'laozhang',
      primaryError: 'laozhang 503',
    });
  });

  it('throws an AggregateError when both primary and fallback fail', async () => {
    const primary = fakeAdapter({ generate: () => Promise.reject(new Error('laozhang down')) });
    const fallback = fakeAdapter({ generate: () => Promise.reject(new Error('kie down')) });
    const adapter = new NanoBananaAdapter(primary, fallback);
    await expect(adapter.generate(spec)).rejects.toThrow(/laozhang down.*kie down/s);
  });

  it('awaitResult just returns the already-attached inlineResult', async () => {
    const adapter = new NanoBananaAdapter(fakeAdapter({}), fakeAdapter({}));
    const result = await adapter.awaitResult({ providerJobId: 'x', inlineResult: okResult }, spec);
    expect(result).toBe(okResult);
  });
});
