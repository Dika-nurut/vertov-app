import { describe, expect, it } from 'vitest';
import { priceModeForRequest } from '@seed/shared';
import { FallbackChainAdapter, getAdapterWithFallback } from '@seed/provider-byteplus';
import { adapterRouteRequest } from './route-request';

describe('worker route mode agrees with the priced mode', () => {
  it('uses the catalogue mode for references, image-less models, and video frames', () => {
    const cases = [
      {
        name: 'reference image',
        model: {
          id: 'reference-image-test',
          kind: 'image' as const,
          capabilities: { reference: true, maxRefs: 1 },
        },
        params: { imageUrls: ['https://example.test/reference.png'] },
        expected: 'i2i',
      },
      {
        name: 'imageUrls on a model with no image input (divergent regression)',
        model: {
          id: 'image-without-input-test',
          kind: 'image' as const,
          capabilities: { reference: false, maxRefs: 0 },
        },
        params: { imageUrls: ['https://example.test/ignored.png'] },
        expected: 't2i',
      },
      {
        name: 'video frame',
        model: {
          id: 'frame-video-test',
          kind: 'video' as const,
          capabilities: { frames: ['first'], maxRefs: 1 },
        },
        params: { frameImages: [{ role: 'first', url: 'https://example.test/frame.png' }] },
        expected: 'i2v',
      },
    ] as const;

    for (const testCase of cases) {
      const route = adapterRouteRequest(testCase.model, testCase.params, []);
      const priced = priceModeForRequest(testCase.model, testCase.params, 0);
      expect(route.mode, testCase.name).toBe(testCase.expected);
      expect(route.mode, testCase.name).toBe(priced);
    }
  });

  it('pins a crafted image rung to default and keeps its signed reserve', () => {
    const image = {
      id: 'gemini-2-5-flash-image',
      kind: 'image' as const,
      capabilities: { resolutions: [] },
    };

    const route = adapterRouteRequest(image, { resolution: '2K' }, []);
    const adapter = getAdapterWithFallback(
      'nanobanana',
      null,
      {
        LAOZHANG_MODE: 'live',
        LAOZHANG_API_KEY: 'test-lz',
        KIE_MODE: 'live',
        KIE_API_KEY: 'test-kie',
      },
      {},
      route,
    );
    expect(route.rung).toBe('default');
    // The rung is normalized to the provider default, but Gemini 2.5 now has a
    // costed Kie reserve at that default, so normalization must not suppress the
    // signed two-leg chain.
    expect(adapter).toBeInstanceOf(FallbackChainAdapter);
  });

  it('does not treat video quality as the charged resolution', () => {
    const video = {
      id: 'video-quality-regression',
      kind: 'video' as const,
      capabilities: { resolutions: ['480p', '720p'] },
    };

    expect(adapterRouteRequest(video, { quality: '480p' }, []).rung).toBe('default');
  });
});
