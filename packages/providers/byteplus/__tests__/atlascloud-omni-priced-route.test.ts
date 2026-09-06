import { describe, expect, it } from 'vitest';
import { buildAtlasRequest, type WorkflowSpec } from '../src/index';
import { ATLAS_OMNI_PRICED_ROUTE_SUFFIX } from '../src/atlascloud-adapter';

/**
 * The `-developer` suffix on AtlasCloud's Gemini Omni routes is a PRICED CONSTANT.
 *
 * Atlas sells omni in two tiers: `-developer` at `$0,112` per second, standard at
 * `$0,125–0,135`. Finance signs the reserve leg at 273 credits, which is **+0,25%** on
 * `-developer` and **−11,3%** on standard (rev. 13, ДОСТОВЕРНОСТЬ on
 * `gemini-omni-flash|default|t2v|да|-|any|нога1`: «Маржа держится на том, что адаптер
 * вызывает именно -developer»).
 *
 * This is the only margin input in the catalogue that is neither a vendor rate nor a
 * price of ours — it is a string in our own source. Losing it produces NO external
 * signal: Atlas still answers, still returns video, still invoices, just at a rate above
 * what we charge. There is no alarm that could catch it after the fact, so the guard has
 * to be here, before the call goes out.
 *
 * If this test fails, do not "fix" it by updating the expectation. Either the route
 * genuinely moved (then finance re-signs the leg FIRST and the rate changes with it), or
 * a refactor dropped the suffix and just put the omni reserve leg under water.
 */
describe('AtlasCloud Gemini Omni — the priced route suffix', () => {
  const spec = (params: Record<string, unknown>, providerModelId: string): WorkflowSpec => ({
    modelId: 'gemini-omni-flash',
    providerModelId,
    providerEndpoint: '/videos',
    kind: 'video',
    prompt: 'priced route guard',
    params: { duration_seconds: 8, aspect_ratio: '16:9', ...params },
    referenceAssets: [],
    maxDurationSeconds: 10,
    capabilities: { forceGateway: 'geminiomni', audio: true },
  });

  // All three modes, because the suffix is applied once for a value the mode selects —
  // a refactor that special-cases one branch would otherwise leave the other two guarded
  // and that branch silently standard-tier.
  const cases: ReadonlyArray<[string, WorkflowSpec, string]> = [
    ['text-to-video', spec({}, 'gemini-omni-flash-text-to-video'), 'text-to-video'],
    [
      'image-to-video',
      spec({ imageUrls: ['https://assets.test/a.png'] }, 'gemini-omni-flash-text-to-video'),
      'image-to-video',
    ],
    [
      'reference-to-video',
      spec({ imageUrls: ['https://assets.test/a.png'] }, 'gemini-omni-flash-reference-to-video'),
      'reference-to-video',
    ],
  ];

  for (const [name, workflow, mode] of cases) {
    it(`${name} calls the -developer tier, never the dearer standard one`, () => {
      const model = (buildAtlasRequest(workflow).body as Record<string, unknown>)['model'];
      expect(model, `${name}: omni must stay on the $0,112 tier`).toBe(
        `google/gemini-omni-flash/${mode}-developer`,
      );
    });
  }

  it('the suffix is a named constant, so a rename cannot silently become a rate change', () => {
    expect(ATLAS_OMNI_PRICED_ROUTE_SUFFIX).toBe('-developer');
  });

  it('every built omni route ends in the priced suffix', () => {
    for (const [name, workflow] of cases.map(([n, w]) => [n, w] as const)) {
      const model = String((buildAtlasRequest(workflow).body as Record<string, unknown>)['model']);
      expect(model.endsWith(ATLAS_OMNI_PRICED_ROUTE_SUFFIX), `${name}: ${model}`).toBe(true);
    }
  });
});
