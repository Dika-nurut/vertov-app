import { describe, expect, it, vi } from 'vitest';
import { CircuitBreakerAdapter } from '../src/circuit-breaker-adapter';
import { FallbackChainAdapter } from '../src/fallback-chain-adapter';
import { ServingLegAdapter } from '../src/serving-leg';
import {
  AtlasCloudAdapter,
  KieAdapter,
  OpenRouterAdapter,
  StubBytePlusAdapter,
  getAdapter,
  getAdapterWithFallback,
} from '../src/index';
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

describe('CircuitBreakerAdapter — generic per-model fallback', () => {
  it('defers to the primary untouched when it succeeds', async () => {
    const primaryGenerate = vi.fn(() =>
      Promise.resolve<GenerationHandle>({ providerJobId: 'p-1' }),
    );
    const fallbackGenerate = vi.fn();
    const adapter = new CircuitBreakerAdapter(
      fakeAdapter({ generate: primaryGenerate }),
      fakeAdapter({ generate: fallbackGenerate }),
      'openrouter',
      'atlascloud',
    );
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('p-1');
    expect(fallbackGenerate).not.toHaveBeenCalled();
  });

  it('falls back and names the serving leg with the SAME vocabulary the chain uses', async () => {
    const primary = fakeAdapter({ generate: () => Promise.reject(new Error('openrouter 503')) });
    const fallback = fakeAdapter({
      generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'fb-1' }),
      awaitResult: () => Promise.resolve(okResult),
    });
    const adapter = new CircuitBreakerAdapter(primary, fallback, 'openrouter', 'atlascloud');
    const handle = await adapter.generate(spec);
    expect(handle.inlineResult?.meta).toMatchObject({
      servedBy: 'atlascloud',
      fallbackDepth: 1,
      fellBackFrom: 'openrouter',
      primaryError: 'openrouter 503',
    });
  });

  it('primary serves → the result names the primary leg at depth 0', async () => {
    const adapter = new CircuitBreakerAdapter(
      fakeAdapter({
        generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'p-1' }),
        awaitResult: () => Promise.resolve(okResult),
      }),
      fakeAdapter({}),
      'openrouter',
      'atlascloud',
    );
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.meta).toMatchObject({ servedBy: 'openrouter', fallbackDepth: 0 });
  });

  it('breaker around a CHAIN keeps the chain leaf, and the depths add up', async () => {
    // Production wiring for a model with models.fallback_gateway set on a chain
    // gateway: CircuitBreaker(FallbackChain(laozhang → kie), atlascloud). When the
    // chain's 2nd leg serves, the honest answer is "kie, 1 hop" — the breaker
    // must not overwrite it with its own primary name.
    const chain = new FallbackChainAdapter([
      {
        name: 'laozhang',
        adapter: fakeAdapter({ generate: () => Promise.reject(new Error('laozhang down')) }),
      },
      {
        name: 'kie',
        adapter: fakeAdapter({
          generate: () => Promise.resolve<GenerationHandle>({ providerJobId: 'kie-1' }),
          awaitResult: () => Promise.resolve(okResult),
        }),
      },
    ]);
    const adapter = new CircuitBreakerAdapter(chain, fakeAdapter({}), 'nanobanana', 'atlascloud');
    const result = await adapter.awaitResult(await adapter.generate(spec), spec);
    expect(result.meta).toMatchObject({ servedBy: 'kie', fallbackDepth: 1 });
  });

  it('throws an AggregateError when both primary and fallback fail', async () => {
    const primary = fakeAdapter({ generate: () => Promise.reject(new Error('primary down')) });
    const fallback = fakeAdapter({ generate: () => Promise.reject(new Error('fallback down')) });
    const adapter = new CircuitBreakerAdapter(primary, fallback, 'openrouter', 'atlascloud');
    await expect(adapter.generate(spec)).rejects.toThrow(/primary down.*fallback down/s);
  });

  it('defers awaitResult to the primary when no inlineResult was attached', async () => {
    const primaryAwait = vi.fn(() => Promise.resolve(okResult));
    const adapter = new CircuitBreakerAdapter(
      fakeAdapter({ awaitResult: primaryAwait }),
      fakeAdapter({}),
      'openrouter',
      'atlascloud',
    );
    const result = await adapter.awaitResult({ providerJobId: 'p-1' }, spec);
    expect(result.assets).toBe(okResult.assets);
    expect(primaryAwait).toHaveBeenCalled();
  });
});

describe('getAdapterWithFallback', () => {
  it('no fallback configured → plain getAdapter, no breaker wrapping', () => {
    const a = getAdapterWithFallback('atlascloud', null, { ATLASCLOUD_MODE: 'stub' });
    expect(a).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('fallback equal to primary → no breaker wrapping (no-op)', () => {
    const a = getAdapterWithFallback('atlascloud', 'atlascloud', { ATLASCLOUD_MODE: 'stub' });
    expect(a).toBeInstanceOf(StubBytePlusAdapter);
  });

  it('distinct fallback → wraps in a CircuitBreakerAdapter', () => {
    const a = getAdapterWithFallback('atlascloud', 'openrouter', {
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'k',
      OPENROUTER_MODE: 'live',
      OPENROUTER_API_KEY: 'k',
    });
    expect(a).toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('flux 2K is finance-signed single-leg, so an outage fails instead of downgrading output', () => {
    const a = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'flux-2-pro', rung: '2K', mode: 't2i' },
    );
    expect(a).not.toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('flux 1K keeps its signed reserve and still builds the breaker', () => {
    const a = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'flux-2-pro', rung: '1K', mode: 't2i' },
    );
    expect(a).toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('flux 2K i2i does not build a fallback whose route cannot honor 2K', () => {
    const a = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'flux-2-pro', rung: '2K', mode: 'i2i' },
    );
    expect(a).not.toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('flux 1K i2i keeps the fallback because it is the route default', () => {
    const a = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'flux-2-pro', rung: '1K', mode: 'i2i' },
    );
    expect(a).toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('keeps a fallback whose route declares the requested resolution menu', () => {
    const a = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'seedream-4-5', rung: '2K', mode: 'i2i' },
    );
    expect(a).toBeInstanceOf(CircuitBreakerAdapter);
  });

  it('single-leg construction still lets the MODEL ROW pick the door, not the cost export', () => {
    // Deliberate, and the reason is wan: the export signs its i2v rows to OpenRouter while
    // the row routes them to kie, which our measured COGS work chose. A cost export states
    // what a leg costs; it is not authorised to move live traffic. So the single-leg branch
    // suppresses the RESERVE and nothing else. Seedance 4K is the case where the two
    // disagree expensively, and it is held shut at activation instead — see
    // UNDELIVERABLE_ON_ROUTE in apps/api/src/pricing-activation-gate.ts.
    const seedance4k = getAdapterWithFallback(
      'openrouter',
      'kie',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'seedance-2-0', rung: '4K', mode: 't2v' },
    );
    expect(seedance4k).toBeInstanceOf(OpenRouterAdapter);
  });

  it('KEEPS the reserve when the signed sole leg is not the leg we would construct', () => {
    // wan i2v USED to be the case that proved this rule, and it broke a live feature on
    // this branch before deploy: the export signed OpenRouter as the sole i2v leg
    // because kie's `wan/2-7-image-to-video` was unwired, so suppressing the reserve
    // left every first/last-frame wan job to fail.
    //
    // Since rev. 21 it no longer proves the rule — the slug is wired, finance signs kie
    // primary AND an OpenRouter reserve, so wan i2v is not a single-leg configuration at
    // all and there is nothing to suppress. The assertion stays because a two-leg config
    // keeping its reserve is still worth pinning, but it is now the WEAK half of this
    // test. The rule itself is exercised below, on a configuration that is still signed
    // sole-leg while the model row routes somewhere else.
    //
    // NO live configuration currently exercises the "signed sole leg != constructed leg"
    // branch to a KEPT reserve, and that is worth writing down rather than faking. The
    // two remaining signed-vs-row divergences are both seedance 4K, and both are held
    // shut earlier by UNDELIVERABLE_ON_ROUTE, so they never reach this rule. Adding
    // either here asserts the wrong outcome — verified 2026-08-12, it returns a bare
    // OpenRouterAdapter. Until such a configuration exists again, the branch is covered
    // only by the flux case below in its OPPOSITE direction (signed == constructed ->
    // suppressed).
    const wanI2v = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'wan-2-7', rung: '720p', mode: 'i2v' },
    );
    expect(wanI2v).toBeInstanceOf(CircuitBreakerAdapter);

    // And the reserve still goes when the two agree: flux 2K t2i is signed to kie and
    // kie is what the row routes to, so there is nothing standing behind it.
    const flux2k = getAdapterWithFallback(
      'kie',
      'openrouter',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        OPENROUTER_MODE: 'live',
        OPENROUTER_API_KEY: 'k',
      },
      {},
      { modelId: 'flux-2-pro', rung: '2K', mode: 't2i' },
    );
    expect(flux2k).toBeInstanceOf(KieAdapter);
    expect(flux2k).not.toBeInstanceOf(CircuitBreakerAdapter);
  });

  const chainEnv = {
    LAOZHANG_MODE: 'live',
    LAOZHANG_API_KEY: 'test-lz',
    KIE_MODE: 'live',
    KIE_API_KEY: 'test-kie',
  } as unknown as NodeJS.ProcessEnv;

  it('constructs the signed LaoZhang primary plus Kie reserve through the chain alias', () => {
    const adapter = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gemini-2-5-flash-image', rung: 'default', mode: 't2i' },
    );
    expect(adapter).toBeInstanceOf(FallbackChainAdapter);
    expect(
      (adapter as unknown as { legs: { name: string }[] }).legs.map((leg) => leg.name),
    ).toEqual(['laozhang', 'kie']);
  });

  it('keeps the costed Kie reserve for gemini-2-5-flash-image default', () => {
    const adapter = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gemini-2-5-flash-image', rung: 'default', mode: 't2i' },
    );
    expect(adapter).toBeInstanceOf(FallbackChainAdapter);
  });

  it('collapses gemini-3-pro-image 1K but not its 4K chain', () => {
    const oneK = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gemini-3-pro-image', rung: '1K', mode: 't2i' },
    );
    const fourK = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gemini-3-pro-image', rung: '4K', mode: 't2i' },
    );
    expect(oneK).not.toBeInstanceOf(FallbackChainAdapter);
    expect(fourK).toBeInstanceOf(FallbackChainAdapter);
  });

  it('keeps the costed Kie reserve for gpt-image-2 default', () => {
    const adapter = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gpt-image-2', rung: 'default', mode: 't2i' },
    );
    expect(adapter).toBeInstanceOf(FallbackChainAdapter);
  });

  it('uses the signed first leg when a chain request is not single-leg', async () => {
    const adapter = getAdapterWithFallback(
      'nanobanana',
      null,
      chainEnv,
      {},
      { modelId: 'gemini-3-1-flash-image', rung: '1K' },
    ) as unknown as { legs: { name: string; adapter: ProviderAdapter }[]; generate: Function };
    const submitted: string[] = [];
    for (const leg of adapter.legs) {
      leg.adapter = fakeAdapter({
        generate: async () => {
          submitted.push(leg.name);
          throw new Error(`${leg.name} down`);
        },
      });
    }
    const request = {
      modelId: 'gemini-3-1-flash-image',
      providerModelId: 'gemini-3-1-flash-image',
      providerEndpoint: '/v1/chat/completions',
      kind: 'image' as const,
      prompt: 'signed leg',
      params: { resolution: '1K' },
      referenceAssets: [],
    } satisfies WorkflowSpec;
    await expect(adapter.generate(request)).rejects.toThrow();
    expect(submitted).toEqual(['kie', 'laozhang']);
  });

  it('unarmed fallback (stub) is never wired into the breaker — degrades to primary only', () => {
    // A stub fallback leg would be a free-asset backdoor on a primary outage
    // (docs/platform/backend-providers.md §B3: "a stub is NEVER a fallback").
    const a = getAdapterWithFallback('atlascloud', 'openrouter', {
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'k',
      // OPENROUTER intentionally not armed.
    });
    expect(a).toBeInstanceOf(AtlasCloudAdapter);
  });

  it('stub primary + stub fallback → plain stub, no breaker wrapping', () => {
    const a = getAdapterWithFallback('atlascloud', 'openrouter', {
      ATLASCLOUD_MODE: 'stub',
      OPENROUTER_MODE: 'stub',
    });
    expect(a).toBeInstanceOf(StubBytePlusAdapter);
  });
});

// Sanity: getAdapter itself is unaffected by the new export (regression guard
// for the existing registry test file).
describe('getAdapter still works standalone', () => {
  it('atlascloud live → AtlasCloudAdapter', () => {
    expect(
      getAdapter('atlascloud', { ATLASCLOUD_MODE: 'live', ATLASCLOUD_API_KEY: 'k' }),
    ).toBeInstanceOf(AtlasCloudAdapter);
  });
});

describe('gpt-image-2 reserve', () => {
  it('is not built for a quality tier kie cannot express', () => {
    // We sell this model at low/medium/high — OpenAI quality TIERS, real on the laozhang
    // primary. kie has no such field; its spec's one size control is resolution 1K|2K|4K.
    // Until 2026-08-11 the kie route DECLARED the tier menu, so the reserve was built and
    // received an unknown field with no size — and kie renders 1K when given none. A
    // customer paying 33 credits for `high` got the cheapest rung on failover.
    const high = getAdapterWithFallback(
      'nanobanana',
      'kie',
      {
        KIE_MODE: 'live',
        KIE_API_KEY: 'k',
        LAOZHANG_MODE: 'live',
        LAOZHANG_API_KEY: 'k',
      } as never,
      {},
      { modelId: 'gpt-image-2', rung: 'high', mode: 'i2i' },
    );
    expect(high).not.toBeInstanceOf(CircuitBreakerAdapter);
  });

  /**
   * The test above passes through `getAdapterWithFallback('nanobanana','kie',…)`. gpt-image-2
   * carries `capabilities.forceGateway: 'nanobanana'` and no `models.fallback_gateway`, so the
   * worker calls `getAdapterWithFallback('nanobanana', undefined, …)`, which returns
   * `getAdapter` before a fallback leg is ever built: the rung guard was unreachable on
   * the real path, and gpt-image-2 was covered only by the accident that finance signs
   * its band single-leg. This exercises the door the worker actually opens.
   */
  it('keeps a reserve out of the CHAIN for a rung it cannot express', () => {
    const env = {
      KIE_MODE: 'live',
      KIE_API_KEY: 'k',
      LAOZHANG_MODE: 'live',
      LAOZHANG_API_KEY: 'k',
    } as never;
    // gemini-3-1-flash-image is the honest probe: unlike gpt-image-2 it is NOT
    // single-leg at any rung, so its kie leg is included or excluded by this guard
    // alone. Asserting the guard through gpt-image-2 would prove nothing — finance
    // signs all three of its tiers single-leg, which drops kie for its own reasons.
    const request = { modelId: 'gemini-3-1-flash-image', mode: 'i2i' };

    // 2K is in kie's declared 1K|2K|4K menu → both legs stand, so a real chain.
    expect(getAdapter('nanobanana', env, {}, { ...request, rung: '2K' } as never)).toBeInstanceOf(
      FallbackChainAdapter,
    );

    // A rung the kie route does not declare must drop that leg entirely rather than
    // reorder it behind the primary — a reserve that renders its own default cannot
    // serve a named rung, and the customer paid for the named one. No live row sells
    // such a rung on this family today; the guard is structural, and this is the only
    // way to exercise it without waiting for the catalogue to grow one.
    expect(
      getAdapter('nanobanana', env, {}, { ...request, rung: '8K' } as never),
    ).not.toBeInstanceOf(FallbackChainAdapter);
  });
});
