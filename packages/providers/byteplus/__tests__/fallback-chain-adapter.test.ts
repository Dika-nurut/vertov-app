import { describe, expect, it, vi } from 'vitest';
import { FallbackChainAdapter } from '../src/fallback-chain-adapter';
import type {
  GenerationHandle,
  GenerationResult,
  ProviderAdapter,
  WorkflowSpec,
} from '../src/types';

const okResult: GenerationResult = {
  assets: [{ bytes: Buffer.from('x'), contentType: 'image/png', extension: 'png' }],
};
function leg(
  name: string,
  opts: {
    generate?: () => Promise<GenerationHandle>;
    awaitResult?: () => Promise<GenerationResult>;
  },
) {
  return {
    name,
    adapter: {
      generate: opts.generate ?? vi.fn(() => Promise.reject(new Error(`${name} down`))),
      awaitResult: opts.awaitResult ?? vi.fn(() => Promise.resolve(okResult)),
    } as ProviderAdapter,
  };
}
const spec = { modelId: 'gemini-2-5-flash-image', capabilities: {} } as unknown as WorkflowSpec;

describe('FallbackChainAdapter — laozhang → kie → openrouter', () => {
  it('primary serves → its handle is returned as-is (primary path unchanged)', async () => {
    const primaryHandle = { providerJobId: 'lz-1', inlineResult: okResult };
    const kieGen = vi.fn();
    const chain = new FallbackChainAdapter([
      leg('laozhang', { generate: () => Promise.resolve(primaryHandle) }),
      leg('kie', { generate: kieGen }),
    ]);
    const h = await chain.generate(spec);
    expect(h).toBe(primaryHandle);
    expect(kieGen).not.toHaveBeenCalled();
  });

  it('primary dead → falls to leg 2, tags servedBy/fellBackFrom/depth', async () => {
    const chain = new FallbackChainAdapter([
      leg('laozhang', {}), // rejects
      leg('kie', {
        generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'kie-1' }),
        awaitResult: () => Promise.resolve(okResult),
      }),
    ]);
    const h = await chain.generate(spec);
    expect(h.inlineResult?.meta).toMatchObject({
      servedBy: 'kie',
      fellBackFrom: 'laozhang',
      fallbackDepth: 1,
    });
  });

  it('BOTH relays dead → the 3rd leg (openrouter) serves', async () => {
    const orGen = vi.fn(() => Promise.resolve<GenerationHandle>({ providerJobId: 'or-1' }));
    const chain = new FallbackChainAdapter([
      leg('laozhang', {}),
      leg('kie', {}),
      leg('openrouter-official', { generate: orGen, awaitResult: () => Promise.resolve(okResult) }),
    ]);
    const h = await chain.generate(spec);
    expect(orGen).toHaveBeenCalledOnce();
    expect(h.inlineResult?.meta).toMatchObject({
      servedBy: 'openrouter-official',
      fellBackFrom: 'kie',
      fallbackDepth: 2,
    });
  });

  // The worker persists jobs.gateway_used from the meta it gets back out of
  // awaitResult(). Everything below is about that hand-off: whatever leg served,
  // the result the worker sees must name the LEAF gateway — never the chain.
  it('primary serves inline → awaitResult names laozhang at depth 0, not "the chain"', async () => {
    const chain = new FallbackChainAdapter([
      leg('laozhang', {
        generate: () => Promise.resolve({ providerJobId: 'lz-1', inlineResult: okResult }),
      }),
      leg('kie', {}),
    ]);
    const result = await chain.awaitResult(await chain.generate(spec), spec);
    expect(result.meta).toMatchObject({ servedBy: 'laozhang', fallbackDepth: 0 });
  });

  it('primary serves a pollable handle → the poll result is tagged laozhang at depth 0', async () => {
    const chain = new FallbackChainAdapter([
      leg('laozhang', {
        generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'lz-async' }),
        awaitResult: () => Promise.resolve(okResult),
      }),
      leg('kie', {}),
    ]);
    const result = await chain.awaitResult(await chain.generate(spec), spec);
    expect(result.meta).toMatchObject({ servedBy: 'laozhang', fallbackDepth: 0 });
  });

  it('3rd leg served → awaitResult still reports openrouter-official at depth 2', async () => {
    // The −55% margin case: the official leg costs ~2.7× the primary. If this
    // tag is lost the job is reported as if the primary served it.
    const chain = new FallbackChainAdapter([
      leg('laozhang', {}),
      leg('kie', {}),
      leg('openrouter-official', {
        generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'or-1' }),
        awaitResult: () => Promise.resolve(okResult),
      }),
    ]);
    const result = await chain.awaitResult(await chain.generate(spec), spec);
    expect(result.meta).toMatchObject({
      servedBy: 'openrouter-official',
      fellBackFrom: 'kie',
      fallbackDepth: 2,
    });
  });

  it('ALL legs dead → one AggregateError naming every leg (no hang)', async () => {
    const chain = new FallbackChainAdapter([
      leg('laozhang', {}),
      leg('kie', {}),
      leg('openrouter-official', {}),
    ]);
    await expect(chain.generate(spec)).rejects.toThrow(
      /laozhang down.*kie down.*openrouter-official down/s,
    );
  });

  it('requires ≥2 legs', () => {
    expect(() => new FallbackChainAdapter([leg('solo', {})])).toThrow(/≥2 legs/);
  });
});

// The OfficialOpenRouterFallbackAdapter's own gates (per-row opt-in, per-rung
// cost, loss budget) moved to `official-leg-gate.test.ts` when the hardcoded
// slug map was retired on 2026-08-02.
