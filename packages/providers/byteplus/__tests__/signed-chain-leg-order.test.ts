import { beforeEach, describe, expect, it } from 'vitest';
import { SIGNED_CHAIN_LEG_ORDER } from '@seed/shared/relay-gateway';
import {
  getAdapter,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from '../src/index';
import { FallbackChainAdapter } from '../src/fallback-chain-adapter';

/**
 * Which vendor serves a Nano Banana image is a MARGIN decision, and finance signs it per
 * (model, rung) while the chain is one list shared by five models and three rungs.
 *
 * For `gemini-3-1-flash-image` the signed order inverts between rungs (rev. 13,
 * «НОГИ (экспорт)», `Маржа ноги`):
 *
 *   1K — Kie 28,49% / LaoZhang  1,67%
 *   2K — LaoZhang 27,32% / Kie 20,72%
 *   4K — LaoZhang 40,30% / Kie  2,31%
 *
 * The construction order is laozhang-first, so before this guard every 1K image sold at
 * 1,67% — finance's RESERVE leg, running live as the primary. A flat flip of the chain
 * would have fixed 1K and dropped 4K from 40,30% to 2,31%.
 *
 * A failure here is a margin regression, not a test being stale. The expectations are the
 * signed numbers; if the vendor rates genuinely moved, finance re-signs the export FIRST
 * and `SIGNED_CHAIN_LEG_ORDER` changes with it.
 */
describe('Nano Banana chain — the signed per-rung leg order', () => {
  const env = {
    LAOZHANG_MODE: 'live',
    LAOZHANG_API_KEY: 'test-lz',
    KIE_MODE: 'live',
    KIE_API_KEY: 'test-kie',
    // Official leg deliberately unarmed: this test is about the two PRICED legs.
  } as unknown as NodeJS.ProcessEnv;

  let submitted: string[] = [];
  beforeEach(() => {
    submitted = [];
  });

  /** Record which leg is asked first, then fail it so the chain walks on. */
  function spy(name: string) {
    return {
      async generate(): Promise<GenerationHandle> {
        submitted.push(name);
        throw new Error(`${name} down`);
      },
      async awaitResult(): Promise<GenerationResult> {
        throw new Error('unreachable');
      },
    };
  }

  function spec(modelId: string, resolution: string | undefined): WorkflowSpec {
    return {
      modelId,
      providerModelId: 'gemini-3.1-flash-image',
      providerEndpoint: '/v1/chat/completions',
      kind: 'image',
      prompt: 'leg order guard',
      params: { ...(resolution ? { resolution } : {}), n: 1, aspect_ratio: '1:1' },
      referenceAssets: [],
      maxDurationSeconds: 0,
      capabilities: { forceGateway: 'nanobanana' },
    } as unknown as WorkflowSpec;
  }

  /** Ask the real chain to serve, with every leg failing, and read the attempt order. */
  async function legOrderFor(modelId: string, resolution: string | undefined): Promise<string[]> {
    const chain = getAdapter('nanobanana', env) as unknown as {
      legs: { name: string; adapter: unknown }[];
    };
    // Swap each armed leg's adapter for a recorder — the chain's own ordering logic,
    // which is what is under test, stays untouched.
    for (const leg of chain.legs) leg.adapter = spy(leg.name);
    await expect(getAdapterFrom(chain).generate(spec(modelId, resolution))).rejects.toThrow();
    return submitted;
  }

  function getAdapterFrom(chain: unknown) {
    return chain as { generate(spec: WorkflowSpec): Promise<GenerationHandle> };
  }

  it('1K goes to Kie first — 28,49% instead of the reserve leg at 1,67%', async () => {
    expect(await legOrderFor('gemini-3-1-flash-image', '1K')).toEqual(['kie', 'laozhang']);
  });

  it('2K stays LaoZhang-first — 27,32% over 20,72%', async () => {
    expect(await legOrderFor('gemini-3-1-flash-image', '2K')).toEqual(['laozhang', 'kie']);
  });

  it('4K stays LaoZhang-first — a flat flip would have cost 38 points here', async () => {
    expect(await legOrderFor('gemini-3-1-flash-image', '4K')).toEqual(['laozhang', 'kie']);
  });

  it('a model with no signed exception keeps the chain order untouched', async () => {
    // gpt-image-2 measures 29,86–72,37% on LaoZhang and has no signed kie leg at all;
    // it must not be moved by a table written for a different model.
    expect(await legOrderFor('gpt-image-2', undefined)).toEqual(['laozhang', 'kie']);
  });

  it('an unrung request keeps the chain order — no rung, no signed order, no change', async () => {
    expect(await legOrderFor('gemini-3-1-flash-image', undefined)).toEqual(['laozhang', 'kie']);
  });

  it('the table names only rungs the model actually sells', () => {
    const rungs = SIGNED_CHAIN_LEG_ORDER.filter((r) => r.modelId === 'gemini-3-1-flash-image').map(
      (r) => r.rung,
    );
    expect(rungs).toEqual(['1K', '2K', '4K']);
  });

  it('every signed order runs best-margin first', () => {
    // Deliberately NOT the whole check. Order and margins are two fields of one
    // hand-written literal, so this only proves they agree with each other — they can
    // drift together and still pass. What pins them to finance is
    // `packages/shared/src/signed-leg-order-vs-export.test.ts`, which compares BOTH
    // against the export they are copied from. This is the local sanity rule: whatever
    // the numbers are, the chain must try the better one first.
    for (const row of SIGNED_CHAIN_LEG_ORDER) {
      const margins = row.order.map((g) => row.signedMargin[g]);
      expect(
        margins.every((m) => typeof m === 'number'),
        `${row.modelId}|${row.rung}`,
      ).toBe(true);
      const sorted = [...(margins as number[])].sort((a, b) => b - a);
      expect(margins, `${row.modelId}|${row.rung} must run best-margin first`).toEqual(sorted);
    }
  });
});

/**
 * The chain's reorder hook may only PERMUTE its legs.
 *
 * The signed reorder shipped here cannot violate that — it sorts a copy — but the guard
 * is what makes the next reorder safe, and a length-only check was not one: it accepted
 * a duplicate standing in for a deleted leg, which bills one vendor twice and drops the
 * leg that was supposed to serve.
 */
describe('FallbackChainAdapter rejects a reorder that is not a permutation', () => {
  const leg = (name: string) => ({
    name,
    adapter: {
      generate: async () => ({ providerJobId: `${name}-job`, inlineResult: undefined }),
      awaitResult: async () => ({ assets: [], meta: {} }),
    } as unknown as ProviderAdapter,
  });
  const legs = [leg('laozhang'), leg('kie'), leg('openrouter-official')];
  const spec = { modelId: 'gemini-3-1-flash-image', params: {} } as unknown as WorkflowSpec;

  const served = async (
    reorder: (l: readonly { name: string }[]) => readonly { name: string; adapter: unknown }[],
  ) => {
    const chain = new FallbackChainAdapter(
      legs,
      reorder as unknown as ConstructorParameters<typeof FallbackChainAdapter>[1],
    );
    const handle = await chain.generate(spec);
    return handle.providerJobId;
  };

  it('runs the signed order when the reorder is a real permutation', async () => {
    expect(await served(() => [legs[1]!, legs[0]!, legs[2]!])).toBe('kie-job');
  });

  it('falls back to construction order when a leg is duplicated over a deleted one', async () => {
    expect(await served(() => [legs[1]!, legs[1]!, legs[2]!])).toBe('laozhang-job');
  });

  it('falls back to construction order when a leg is dropped', async () => {
    expect(await served(() => [legs[1]!, legs[2]!])).toBe('laozhang-job');
  });
});
