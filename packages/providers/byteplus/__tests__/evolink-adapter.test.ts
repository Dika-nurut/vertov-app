import { describe, expect, it } from 'vitest';
import { buildBody } from '../src/evolink-adapter';
import type { WorkflowSpec } from '../src/types';

/** Minimal image spec; params override per case. */
function imageSpec(params: Record<string, unknown>): WorkflowSpec {
  return {
    modelId: 'seedream-4-5',
    providerModelId: 'doubao-seedream-4.5',
    providerEndpoint: 'https://example/images/generations',
    kind: 'image',
    prompt: 'a cat on a sofa',
    params,
    referenceAssets: [],
  };
}

describe('evolink buildBody — negative_prompt passthrough (cinema/style presets)', () => {
  it('forwards negative_prompt when the preset supplies one', () => {
    const body = buildBody(imageSpec({ negative_prompt: 'blurry, low quality' }));
    expect(body['negative_prompt']).toBe('blurry, low quality');
  });

  it('trims the negative prompt before sending', () => {
    const body = buildBody(imageSpec({ negative_prompt: '  deformed hands  ' }));
    expect(body['negative_prompt']).toBe('deformed hands');
  });

  it('omits the field entirely when absent or blank (no no-op key)', () => {
    expect('negative_prompt' in buildBody(imageSpec({}))).toBe(false);
    expect('negative_prompt' in buildBody(imageSpec({ negative_prompt: '   ' }))).toBe(false);
  });
});

describe('evolink buildBody — canonical Board image controls', () => {
  it('maps aspect, resolution, and count to Evolink fields', () => {
    const body = buildBody(imageSpec({ aspect_ratio: '9:16', resolution: '4K', n: 3 }));
    expect(body['size']).toBe('9:16');
    expect(body['quality']).toBe('4K');
    expect(body['n']).toBe(3);
  });
});

describe('evolink buildBody — typed frame compatibility', () => {
  it('keeps first/last role order when converting to the legacy image_urls wire field', () => {
    const spec: WorkflowSpec = {
      ...imageSpec({}),
      kind: 'video',
      providerModelId: 'seedance-2.0-text-to-video',
      params: {
        duration_seconds: 5,
        frameImages: [
          { role: 'last', url: 'https://x/last.png' },
          { role: 'first', url: 'https://x/first.png' },
        ],
      },
    };
    expect(buildBody(spec)['image_urls']).toEqual(['https://x/first.png', 'https://x/last.png']);
  });
});
