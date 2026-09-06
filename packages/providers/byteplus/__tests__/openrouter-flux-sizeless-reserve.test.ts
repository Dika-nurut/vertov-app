import { describe, expect, it } from 'vitest';
import { buildOpenRouterImageBody, type WorkflowSpec } from '../src/index';

/**
 * FLUX.2 Pro's OpenRouter reserve must never carry a rung.
 *
 * kie is the charged primary and prices FLUX PER PICTURE PER TIER — 1K at $0,025 and 2K
 * at a measured $0,035, which is what the 11- and 15-credit rungs are priced off.
 * OpenRouter is the reserve and bills PER MEGAPIXEL at $0,03, on a route whose contract
 * declares no size control at all (`resolution: EMPTY_MENU`).
 *
 * So the two legs do not scale the same way, and forwarding the rung to the reserve is a
 * money question rather than a cosmetic one. 2K is 1536² = 2,36 MP:
 *
 *   cost    2,36 MP × $0,03 × 100,6315 ₽ = 7,12 ₽
 *   revenue 15 credits × 0,331111 ₽      = 4,97 ₽
 *   margin                                 −43%
 *
 * R-1 puts the FALLBACK floor at 0%, not 25% — a thin reserve beats an outage — but −43%
 * is not thin, it is a sale at a loss on every failed-over job. Whether OpenRouter
 * actually honours the field or silently ignores it has NOT been measured, and R-2
 * forbids assuming the convenient answer. Omitting it is the only branch that is correct
 * under both.
 *
 * The residual exposure is deliberate and is the smaller one: a 2K job that fails over
 * comes back at ~1 MP — a smaller picture at the 2K price, at 36% margin. Finance has
 * asked for the paid OpenRouter 2K call that settles it.
 */
describe('FLUX.2 Pro on its OpenRouter reserve — no rung on the wire', () => {
  const flux = (params: Record<string, unknown>): WorkflowSpec =>
    ({
      modelId: 'flux-2-pro',
      providerModelId: 'black-forest-labs/flux.2-pro',
      providerEndpoint: '/images',
      kind: 'image',
      prompt: 'sizeless reserve guard',
      params: { n: 1, ...params },
      referenceAssets: [],
      maxDurationSeconds: 0,
      capabilities: { resolutions: ['1K', '2K'] },
    }) as unknown as WorkflowSpec;

  it('drops a 2K ask rather than risk a per-megapixel bill at a per-picture price', () => {
    expect(buildOpenRouterImageBody(flux({ resolution: '2K' }))).not.toHaveProperty('resolution');
  });

  it('drops a 1K ask too — the reserve has no size control to honour either way', () => {
    expect(buildOpenRouterImageBody(flux({ resolution: '1K' }))).not.toHaveProperty('resolution');
  });

  it('still sends everything else, so this is a dropped FIELD and not a dropped request', () => {
    const body = buildOpenRouterImageBody(flux({ resolution: '2K', aspect_ratio: '16:9' }));
    expect(body['model']).toBe('black-forest-labs/flux.2-pro');
    expect(body['aspect_ratio']).toBe('16:9');
    expect(body['n']).toBe(1);
  });

  it('does NOT silence the rung for models whose OpenRouter route does have one', () => {
    // The narrowness is the point: this is a per-model fact about one vendor route, not a
    // new rule that OpenRouter ignores resolutions. A blanket drop would quietly downgrade
    // every laddered image model on its OpenRouter leg.
    const seedream = {
      ...flux({ resolution: '2K' }),
      modelId: 'seedream-5-0-pro',
      providerModelId: 'seedream/5-pro-image-to-image',
    } as WorkflowSpec;
    expect(buildOpenRouterImageBody(seedream)['resolution']).toBe('2K');
  });
});
