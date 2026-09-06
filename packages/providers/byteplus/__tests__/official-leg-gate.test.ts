import { describe, expect, it, vi, afterEach } from 'vitest';
import { OfficialOpenRouterFallbackAdapter } from '../src/official-fallback-adapter';
import { setOfficialLegBudget, type OfficialLegBudget } from '../src/official-leg-budget';
import { getAdapter } from '../src/index';
import { FallbackChainAdapter } from '../src/fallback-chain-adapter';
import { ServingLegAdapter } from '../src/serving-leg';
import type { OpenRouterAdapter } from '../src/openrouter-adapter';
import { ProviderError, type WorkflowSpec } from '../src/types';

/**
 * The third leg of the `nanobanana` chain (laozhang → kie → Google's own listing
 * on OpenRouter) used to arm itself: a hardcoded slug map served four gemini
 * rows whether or not the row had asked for it, and nobody had costed the leg.
 * Finance ruled on 2026-08-02 (Ask 8, option b): keep it as insurance, inside a
 * ₽ cap, and never serve a rung whose cost we cannot compute.
 *
 * Four independent gates, in the order `generate()` applies them.
 */

const NANO_BANANA_PRO = {
  jobId: 'job_1',
  modelId: 'gemini-3-pro-image',
  providerModelId: 'gemini-3-pro-image',
  kind: 'image',
  params: { resolution: '4K' },
  capabilities: {
    resolutions: ['1K', '2K', '4K'],
    openrouterFallbackSlug: 'google/gemini-3-pro-image',
    // The one figure we hold a real OpenRouter invoice for.
    officialUsdPerUnit: { '4K': 0.241344 },
  },
} as unknown as WorkflowSpec;

function fakeOpenRouter() {
  return {
    generate: vi.fn(() => Promise.resolve({ providerJobId: 'x' })),
    awaitResult: vi.fn(() => Promise.resolve({ assets: [] })),
  } as unknown as OpenRouterAdapter;
}

/** A budget that books everything, and records what it was asked to book. Each
 *  booking gets its own attempt id — that is the whole point of the handle. */
function openBudget() {
  let attempt = 0;
  return {
    reserve: vi.fn(() =>
      Promise.resolve({ reserved: true as const, attemptId: `attempt_${++attempt}` }),
    ),
    release: vi.fn(() => Promise.resolve()),
  };
}

const spentBudget: OfficialLegBudget = {
  reserve: () => Promise.resolve({ reserved: false, reason: 'budget-exhausted' }),
  release: () => Promise.resolve(),
};

afterEach(() => {
  setOfficialLegBudget(null);
  vi.unstubAllEnvs();
});

describe('gate 1 — a spend nothing could settle is a spend we do not make', () => {
  it('refuses a spec with no jobId', async () => {
    // The reservation is keyed on the job id. Without one it could never be
    // settled or released, so its ₽ would hold against the cap for 30 days.
    const inner = fakeOpenRouter();
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, budget);
    const { jobId: _dropped, ...noJobId } = NANO_BANANA_PRO as WorkflowSpec & { jobId: string };
    await expect(adapter.generate(noJobId as WorkflowSpec)).rejects.toMatchObject({
      code: 'OFFICIAL_LEG_UNTRACKABLE',
    });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(inner.generate).not.toHaveBeenCalled();
  });
});

describe('gate 2 — the leg is opt-in per model row, never inferred', () => {
  it('serves a row that carries an official slug', async () => {
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, openBudget());
    await adapter.generate(NANO_BANANA_PRO);
    const passed = (inner.generate as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as WorkflowSpec;
    expect(passed.providerModelId).toBe('google/gemini-3-pro-image');
  });

  it('refuses a gemini row that has NOT opted in, even though the old map knew its slug', async () => {
    // 'gemini-2-5-flash-image' was one of the four rows the hardcoded map armed.
    // With the map gone, a row with no slug on it is simply not on this leg.
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, openBudget());
    await expect(
      adapter.generate({
        jobId: 'job_2',
        modelId: 'gemini-2-5-flash-image',
        kind: 'image',
        params: {},
        capabilities: { resolutions: [] },
      } as unknown as WorkflowSpec),
    ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    expect(inner.generate).not.toHaveBeenCalled();
  });
});

describe('gate 3 — nothing is served that cannot be priced in the units it bills in', () => {
  it('refuses an opted-in row that carries no per-rung cost map at all', async () => {
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, openBudget());
    await expect(
      adapter.generate({
        jobId: 'job_3',
        modelId: 'gemini-3-1-flash-image',
        kind: 'image',
        params: { resolution: '4K' },
        capabilities: {
          resolutions: ['1K', '2K', '4K'],
          openrouterFallbackSlug: 'google/gemini-3.1-flash-image',
        },
      } as unknown as WorkflowSpec),
    ).rejects.toMatchObject({ code: 'OFFICIAL_LEG_UNPRICED' });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it('refuses the 1K rung of the row whose 4K rung IS costed', async () => {
    // We hold an invoice for gemini-3-pro-image at 4K and nothing else. The rest
    // of its ladder is as uncostable as the other three rows.
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, openBudget());
    await expect(
      adapter.generate({ ...NANO_BANANA_PRO, params: { resolution: '1K' } } as WorkflowSpec),
    ).rejects.toMatchObject({ code: 'OFFICIAL_LEG_UNPRICED' });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it('refuses a scalar cost written in the shape legs 0 and 1 use', async () => {
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, openBudget());
    await expect(
      adapter.generate({
        ...NANO_BANANA_PRO,
        capabilities: {
          ...(NANO_BANANA_PRO.capabilities as Record<string, unknown>),
          officialUsdPerUnit: 0.241344,
        },
      } as unknown as WorkflowSpec),
    ).rejects.toMatchObject({ code: 'OFFICIAL_LEG_UNPRICED' });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it('refuses a VIDEO row, which `makeGeminiOmniAdapter` arms this leg for', async () => {
    // Video bills by output second; the rung map is per unit. Serving one here
    // would spend real money that no billable-unit source could turn into ₽ —
    // and gemini-omni is a video chain that appends this exact leg. The chain
    // degrades to its two relay legs instead.
    const inner = fakeOpenRouter();
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, budget);
    await expect(
      adapter.generate({
        jobId: 'job_video',
        modelId: 'gemini-omni-flash',
        kind: 'video',
        params: { resolution: '720p', duration: 5 },
        capabilities: {
          resolutions: ['720p'],
          openrouterFallbackSlug: 'google/gemini-omni',
          officialUsdPerUnit: { '720p': 0.08 },
        },
      } as unknown as WorkflowSpec),
    ).rejects.toMatchObject({ code: 'OFFICIAL_LEG_UNPRICED' });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(inner.generate).not.toHaveBeenCalled();
  });
});

describe('gate 4 — the leg books its loss before it submits', () => {
  it('reserves the job worst case, priced at the rung it will be charged at', async () => {
    const inner = fakeOpenRouter();
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, budget);
    await adapter.generate({ ...NANO_BANANA_PRO, params: { resolution: '4K', n: 3 } });
    expect(budget.reserve).toHaveBeenCalledWith({
      jobId: 'job_1',
      modelId: 'gemini-3-pro-image',
      rung: '4K',
      // Three images means three paid calls — the fan-out `generate()` will
      // issue. Reserving one would under-book by two thirds.
      units: 3,
      usdPerUnit: 0.241344,
    });
  });

  it('caps the reserved units at the fan-out ceiling the delegate actually issues', async () => {
    const inner = fakeOpenRouter();
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, budget);
    await adapter.generate({ ...NANO_BANANA_PRO, params: { resolution: '4K', n: 99 } });
    expect(budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ units: 4 }));
  });

  it('refuses once a cap is crossed', async () => {
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, spentBudget);
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({
      code: 'OFFICIAL_LEG_BUDGET_EXHAUSTED',
    });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it('refuses when no subscription tier prices a credit, before submitting', async () => {
    // Revenue would be 0, so the leg can only lose. This has to stop here: after
    // the submit, the money is already gone.
    const inner = fakeOpenRouter();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, {
      reserve: () => Promise.resolve({ reserved: false, reason: 'no-credit-floor' }),
      release: () => Promise.resolve(),
    });
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({
      code: 'OFFICIAL_LEG_BUDGET_EXHAUSTED',
    });
    expect(inner.generate).not.toHaveBeenCalled();
  });

  it('books before submitting, not after', async () => {
    // The order matters: a post-submit check would have already spent the money
    // it was meant to withhold.
    const calls: string[] = [];
    const inner = {
      generate: vi.fn(() => {
        calls.push('generate');
        return Promise.resolve({ providerJobId: 'x' });
      }),
      awaitResult: vi.fn(),
    } as unknown as OpenRouterAdapter;
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, {
      reserve: () => {
        calls.push('reserve');
        return Promise.resolve({ reserved: true });
      },
      release: () => Promise.resolve(),
    });
    await adapter.generate(NANO_BANANA_PRO);
    expect(calls).toEqual(['reserve', 'generate']);
  });

  it('does not re-book when resolving a handle it already submitted', async () => {
    const inner = fakeOpenRouter();
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(inner, budget);
    await adapter.awaitResult({ providerJobId: 'x' }, NANO_BANANA_PRO);
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(inner.awaitResult).toHaveBeenCalled();
  });
});

describe('a reservation goes back only when the vendor provably billed nothing', () => {
  function rejectingWith(err: unknown) {
    return {
      generate: vi.fn(() => Promise.reject(err)),
      awaitResult: vi.fn(),
    } as unknown as OpenRouterAdapter;
  }

  it('releases a single-image request the vendor refused with a 4xx', async () => {
    // A wrong OPENROUTER_API_KEY 401s every request. Holding those reservations
    // would burn the whole day's budget on calls that cost nothing, and take the
    // leg offline for 24 h during the ban wave it exists for.
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(
      rejectingWith(
        new ProviderError({ code: 'HTTP_401', status: 401, retryable: false, message: 'bad key' }),
      ),
      budget,
    );
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({ code: 'HTTP_401' });
    // The ATTEMPT that was refused, never the job: a sibling attempt that WAS
    // billed keeps its ₽.
    expect(budget.release).toHaveBeenCalledWith('attempt_1');
  });

  it('KEEPS the reservation when the request returned no usable asset', async () => {
    // `NO_ASSET` is our own 200-status code: the call ran and was billed, it just
    // gave us nothing to sell. That is a 100% loss and must stay booked.
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(
      rejectingWith(
        new ProviderError({ code: 'NO_ASSET', status: 200, retryable: true, message: 'empty' }),
      ),
      budget,
    );
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({ code: 'NO_ASSET' });
    expect(budget.release).not.toHaveBeenCalled();
  });

  it('KEEPS the reservation when a multi-image fan-out rejects', async () => {
    // `generate()` fires one paid call per image with Promise.all: it rejects on
    // the first failure while the siblings are billed anyway. A 4xx tells us
    // nothing about what the other calls cost.
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(
      rejectingWith(
        new ProviderError({ code: 'HTTP_429', status: 429, retryable: true, message: 'slow down' }),
      ),
      budget,
    );
    await expect(
      adapter.generate({ ...NANO_BANANA_PRO, params: { resolution: '4K', n: 3 } }),
    ).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(budget.release).not.toHaveBeenCalled();
  });

  it('KEEPS the reservation on a 408, which does not prove the work never ran', async () => {
    // A request timeout is the one 4xx that is not a refusal: the request was
    // accepted and we stopped waiting for it, so the generation may well have
    // run and been billed. Nobody has shown that OpenRouter guarantees an
    // unbilled 408, and it is RETRYABLE — so releasing here both under-counts a
    // real charge and hands the retry a budget it has already spent.
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(
      rejectingWith(
        new ProviderError({ code: 'HTTP_408', status: 408, retryable: true, message: 'timeout' }),
      ),
      budget,
    );
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({ code: 'HTTP_408' });
    expect(budget.release).not.toHaveBeenCalled();
  });

  it('KEEPS the reservation on a vendor 5xx, which may well have run the work', async () => {
    const budget = openBudget();
    const adapter = new OfficialOpenRouterFallbackAdapter(
      rejectingWith(
        new ProviderError({ code: 'HTTP_502', status: 502, retryable: true, message: 'upstream' }),
      ),
      budget,
    );
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({ code: 'HTTP_502' });
    expect(budget.release).not.toHaveBeenCalled();
  });
});

describe('chain construction — no budget registered means no third leg', () => {
  function armRelays(): void {
    vi.stubEnv('LAOZHANG_MODE', 'live');
    vi.stubEnv('LAOZHANG_API_KEY', 'lz');
    vi.stubEnv('KIE_MODE', 'live');
    vi.stubEnv('KIE_API_KEY', 'kie');
    vi.stubEnv('OPENROUTER_MODE', 'live');
    vi.stubEnv('OPENROUTER_API_KEY', 'or');
  }

  it('builds a 2-leg chain when nothing registered a budget', () => {
    armRelays();
    const adapter = getAdapter('nanobanana', process.env as Record<string, string>);
    expect(adapter).toBeInstanceOf(FallbackChainAdapter);
    expect((adapter as unknown as { legs: { name: string }[] }).legs.map((l) => l.name)).toEqual([
      'laozhang',
      'kie',
    ]);
  });

  it('appends the third leg once a budget is registered', () => {
    setOfficialLegBudget(openBudget());
    armRelays();
    const adapter = getAdapter('nanobanana', process.env as Record<string, string>);
    expect((adapter as unknown as { legs: { name: string }[] }).legs.map((l) => l.name)).toEqual([
      'laozhang',
      'kie',
      'openrouter-official',
    ]);
  });

  it('still NAMES the official leg when the ban wave leaves it as the only one', () => {
    // Both relays down is the exact scenario this leg exists for — and the one
    // where the chain collapses to a single leg. Returning the bare adapter there
    // dropped the only `servedBy` stamp on the path, so the ~2.7x leg reported
    // itself as plain 'openrouter' and went uncounted.
    setOfficialLegBudget(openBudget());
    vi.stubEnv('LAOZHANG_MODE', 'stub');
    vi.stubEnv('KIE_MODE', 'stub');
    vi.stubEnv('OPENROUTER_MODE', 'live');
    vi.stubEnv('OPENROUTER_API_KEY', 'or');
    const adapter = getAdapter('nanobanana', process.env as Record<string, string>);
    expect(adapter).toBeInstanceOf(ServingLegAdapter);
    expect((adapter as unknown as { name: string }).name).toBe('openrouter-official');
  });

  it('tags the result of a collapsed chain with the leg that really served it', async () => {
    const inner = {
      generate: vi.fn(() => Promise.resolve({ providerJobId: 'x' })),
      awaitResult: vi.fn(() => Promise.resolve({ assets: [] })),
    };
    const adapter = new ServingLegAdapter('openrouter-official', inner);
    const result = await adapter.awaitResult({ providerJobId: 'x' }, NANO_BANANA_PRO);
    expect(result.meta).toMatchObject({ servedBy: 'openrouter-official', fallbackDepth: 0 });
  });

  it('lets a single leg own error code through instead of an AggregateError', async () => {
    // A 1-leg FallbackChainAdapter would wrap this, and the worker would record
    // 'INTERNAL' instead of the refusal that actually happened.
    const inner = {
      generate: vi.fn(() =>
        Promise.reject(
          new ProviderError({
            code: 'OFFICIAL_LEG_BUDGET_EXHAUSTED',
            status: 503,
            retryable: false,
            message: 'over budget',
          }),
        ),
      ),
      awaitResult: vi.fn(),
    };
    const adapter = new ServingLegAdapter('openrouter-official', inner);
    await expect(adapter.generate(NANO_BANANA_PRO)).rejects.toMatchObject({
      code: 'OFFICIAL_LEG_BUDGET_EXHAUSTED',
    });
  });
});
