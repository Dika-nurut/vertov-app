import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, setGlobalDispatcher } from 'undici';
import {
  KieAdapter,
  KieClient,
  buildKieImageBody,
  buildKieVideoBody,
  kieModelSlug,
} from '../src/index';
// buildKieVeoBody/isKieVeoModel are veo-only helpers not re-exported from the
// package barrel (dormant wiring); import them straight from the module.
import { buildKieVeoBody, isKieVeoModel } from '../src/kie-adapter';
import type { WorkflowSpec } from '../src/types';

const BASE = 'https://mock.kie.test';
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

function makeAdapter() {
  return new KieAdapter(
    new KieClient({ baseUrl: BASE, apiKey: 'sk-kie-test', pollTimeoutMs: 5_000 }),
    { pollBackoffMs: [5] },
  );
}

function imageSpec(params: Record<string, unknown> = {}): WorkflowSpec {
  return {
    modelId: 'gemini-3-pro-image',
    providerModelId: 'gemini-3-pro-image',
    providerEndpoint: '/api/v1/jobs/createTask',
    kind: 'image',
    prompt: 'a red cube',
    params,
    referenceAssets: [],
    maxDurationSeconds: null,
  };
}

function videoSpec(params: Record<string, unknown> = {}): WorkflowSpec {
  return {
    modelId: 'gemini-omni-flash',
    providerModelId: 'gemini-omni-flash-text-to-video',
    providerEndpoint: '/api/v1/jobs/createTask',
    kind: 'video',
    prompt: 'a whale breaching at sunset',
    params,
    referenceAssets: [],
    maxDurationSeconds: 10,
  };
}

describe('kie.ai model slug mapping', () => {
  it('maps our Gemini providerModelId to the kie.ai marketplace slug', () => {
    expect(kieModelSlug('gemini-3-pro-image')).toBe('nano-banana-pro');
    expect(kieModelSlug('gemini-3-pro-image-preview')).toBe('nano-banana-pro');
    expect(kieModelSlug('gemini-2.5-flash-image')).toBe('google/nano-banana');
    expect(() => kieModelSlug('unknown-model')).toThrow(/no kie.ai slug/);
  });

  it('maps the owner-mandated palette models added 2026-07-16', () => {
    // Verified against kie's own OpenAPI docs — see
    // docs/strategy/vitrina-prompt-research/06-kie-wiring-verification.md.
    expect(kieModelSlug('seedream-5-0-pro')).toBe('seedream/5-pro-text-to-image');
    expect(kieModelSlug('seedream-5-0-lite')).toBe('seedream/5-lite-text-to-image');
    expect(kieModelSlug('doubao-seedream-4.5')).toBe('seedream/4.5-text-to-image');
    expect(kieModelSlug('happyhorse-1-1-text-to-video')).toBe('happyhorse-1-1/text-to-video');
  });

  it("pins HappyHorse to the EXPLICIT versioned slug, never kie's unversioned alias", () => {
    // kie also publishes an unversioned `happyhorse/text-to-video` whose docs
    // never state which version it serves — it could silently drift across
    // releases. We map only the versioned slug, so nothing is inferred.
    expect(kieModelSlug('happyhorse-1-1-text-to-video')).not.toBe('happyhorse/text-to-video');
    expect(() => kieModelSlug('happyhorse-1-0-text-to-video')).toThrow(/no kie.ai slug/);
  });

  it('resolves the gemini-omni video slug that used to be hardcoded in buildKieVideoBody', () => {
    expect(kieModelSlug('gemini-omni-flash-text-to-video')).toBe('gemini-omni-video');
  });

  it('maps grok-imagine-video to the kie marketplace text-to-video slug', () => {
    expect(kieModelSlug('x-ai/grok-imagine-video')).toBe('grok-imagine/text-to-video');
  });

  it('maps the active HappyHorse 1.1 row (alibaba/happyhorse-1.1) to kie v1.1 slug for fallback', () => {
    expect(kieModelSlug('alibaba/happyhorse-1.1')).toBe('happyhorse-1-1/text-to-video');
  });

  it('maps the Seedance 2.0 family to kie slugs (availability fallback)', () => {
    expect(kieModelSlug('seedance-2.0-text-to-video')).toBe('bytedance/seedance-2');
    expect(kieModelSlug('seedance-2-0-fast')).toBe('bytedance/seedance-2-fast');
    expect(kieModelSlug('seedance-2.0-reference-to-video')).toBe('bytedance/seedance-2');
    expect(kieModelSlug('seedance-2.0-fast-reference-to-video')).toBe('bytedance/seedance-2-fast');
  });

  it('maps the slash-form Veo providerModelIds to kie underscore veo3* slugs', () => {
    expect(kieModelSlug('google/veo-3.1')).toBe('veo3');
    expect(kieModelSlug('google/veo-3.1-fast')).toBe('veo3_fast');
    expect(kieModelSlug('google/veo-3.1-lite')).toBe('veo3_lite');
  });

  it('flags only the three Veo models as using the dedicated /veo endpoint path', () => {
    expect(isKieVeoModel('google/veo-3.1')).toBe(true);
    expect(isKieVeoModel('google/veo-3.1-fast')).toBe(true);
    expect(isKieVeoModel('google/veo-3.1-lite')).toBe(true);
    // Grok stays on the createTask/recordInfo market path, not /veo.
    expect(isKieVeoModel('x-ai/grok-imagine-video')).toBe(false);
    expect(isKieVeoModel('gemini-omni-flash-text-to-video')).toBe(false);
  });

  it('uses model-specific reference and control fields', () => {
    expect(
      buildKieImageBody({
        ...imageSpec({ aspect_ratio: '9:16', imageUrls: ['https://x/ref.png'] }),
        modelId: 'gemini-2-5-flash-image',
        providerModelId: 'gemini-2.5-flash-image',
      }),
    ).toEqual({
      model: 'google/nano-banana-edit',
      input: {
        prompt: 'a red cube',
        image_urls: ['https://x/ref.png'],
        aspect_ratio: '9:16',
        output_format: 'png',
      },
    });
    expect(
      buildKieImageBody({
        ...imageSpec({ aspect_ratio: '16:9', resolution: '4K' }),
        modelId: 'gemini-3-1-flash-lite-image',
        providerModelId: 'gemini-3.1-flash-lite-image',
      }),
    ).toEqual({
      model: 'nano-banana-2-lite',
      input: { prompt: 'a red cube', aspect_ratio: '16:9', output_format: 'png' },
    });
  });
});

describe('kie.ai image body — flux-2-pro (kie became the PRIMARY leg 2026-08-04)', () => {
  // kie is cheaper than OpenRouter ($0.025 vs $0.03 at the 1K tier we sell). `resolution`
  // is required and billed per tier — the one constraint the price list never carried,
  // and load-bearing on money. `input_urls` is a REQUIRED ARRAY per the vendor's own
  // OpenAPI capture (kie-specs/flux2__pro-image-to-image.md, maxItems 8) — corrected
  // 2026-08-09 from a wrong single-uri assumption nothing ever verified.
  function fluxSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...imageSpec(params),
      modelId: 'flux-2-pro',
      providerModelId: 'black-forest-labs/flux.2-pro',
    };
  }

  it('a bare text-to-image request buys the cheap rung, which is what it is priced at', () => {
    const body = buildKieImageBody(fluxSpec());
    expect(body['model']).toBe('flux-2/pro-text-to-image');
    expect((body['input'] as Record<string, unknown>)['resolution']).toBe('1K');
  });

  it('serves 2K when the caller asks for it, because 2K is now a rung we sell', () => {
    // INVERTED 2026-08-10, and the inversion is the point. This test used to read «never
    // emits 2K, even when the caller asks for it» and it was RIGHT then: 2K costs $0,035
    // measured, and against the single 13-credit price the model had, that is 18,2% —
    // under the floor. rev. 13 signed the rung at 15 credits (29,1%) and rev. 14 re-banded
    // the cheap rung `default` → `1K` so the two can be declared side by side. Honouring
    // the ask is now the correct behaviour; ignoring it would deliver 1K at the 2K price.
    const body = buildKieImageBody(fluxSpec({ resolution: '2K' }));
    expect((body['input'] as Record<string, unknown>)['resolution']).toBe('2K');
  });

  it('an unknown rung falls back to 1K rather than passing kie an off-menu value', () => {
    // kie's enum stops at 2K — there is no 4K flux tier — and the cheap rung is what an
    // unpriced ask is charged at, so it is the only safe default.
    const body = buildKieImageBody(fluxSpec({ resolution: '4K' }));
    expect((body['input'] as Record<string, unknown>)['resolution']).toBe('1K');
  });

  it('a single reference uses the i2i slug and sends input_urls as an array of one', () => {
    const body = buildKieImageBody(fluxSpec({ imageUrls: ['https://x/ref.png'] }));
    expect(body['model']).toBe('flux-2/pro-image-to-image');
    expect((body['input'] as Record<string, unknown>)['input_urls']).toEqual(['https://x/ref.png']);
  });

  it('a multi-reference request (2–8 images) serializes the full array, matching the vendor schema (no paid probe confirms runtime acceptance yet)', () => {
    const body = buildKieImageBody(fluxSpec({ imageUrls: ['https://x/a.png', 'https://x/b.png'] }));
    expect(body['model']).toBe('flux-2/pro-image-to-image');
    expect((body['input'] as Record<string, unknown>)['input_urls']).toEqual([
      'https://x/a.png',
      'https://x/b.png',
    ]);
  });

  it('caps at 8 references, matching the vendor maxItems, rather than sending an oversized array', () => {
    const nine = Array.from({ length: 9 }, (_, i) => `https://x/${i}.png`);
    const body = buildKieImageBody(fluxSpec({ imageUrls: nine }));
    expect((body['input'] as Record<string, unknown>)['input_urls']).toHaveLength(8);
  });

  it('always sends the required aspect_ratio, defaulting when the caller omits it', () => {
    expect(
      (buildKieImageBody(fluxSpec())['input'] as Record<string, unknown>)['aspect_ratio'],
    ).toBe('1:1');
  });
});

describe('kie.ai image body — gpt-image-2 (fallback leg)', () => {
  // Coordinator finding (terra adversarial pass, 2026-07-28): GenerateClient sent
  // the tier as `quality`, priced it as `resolution`'s alias, but this branch
  // read ONLY `spec.params['resolution']` — billed a tier the vendor never
  // received. `resolution` is now the primary key (matches /boards +
  // priceSelectorFromParams' preference order); `quality` is a fallback for a
  // stale/third-party caller. Both must actually reach the wire body.
  function gptImage2Spec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...imageSpec(params),
      modelId: 'gpt-image-2',
      providerModelId: 'gpt-image-2',
    };
  }

  it('a Generate-style payload sending `resolution` reaches the body as `quality`', () => {
    const body = buildKieImageBody(gptImage2Spec({ resolution: 'medium' }));
    expect((body['input'] as Record<string, unknown>)['quality']).toBe('medium');
  });

  it('a stale/legacy payload sending `quality` (not `resolution`) still reaches the body', () => {
    const body = buildKieImageBody(gptImage2Spec({ quality: 'high' }));
    expect((body['input'] as Record<string, unknown>)['quality']).toBe('high');
  });

  it('`resolution` wins when a crafted request sends both', () => {
    const body = buildKieImageBody(gptImage2Spec({ resolution: 'low', quality: 'high' }));
    expect((body['input'] as Record<string, unknown>)['quality']).toBe('low');
  });

  it('an i2i request (imageUrls present) still carries the quality field through', () => {
    const body = buildKieImageBody(
      gptImage2Spec({ resolution: 'high', imageUrls: ['https://x/ref.png'] }),
    );
    expect(body['model']).toBe('gpt-image-2-image-to-image');
    expect((body['input'] as Record<string, unknown>)['quality']).toBe('high');
  });

  it('omits `quality` when neither alias is present', () => {
    const body = buildKieImageBody(gptImage2Spec({}));
    expect(body['input']).not.toHaveProperty('quality');
  });
});

describe('kie.ai image body — Seedream 4.5 (fallback leg of the active seedream-4-5 row)', () => {
  // The active catalog row's providerModelId is the BytePlus form; the worker
  // copies it onto the spec verbatim, so that is the key the kie branch matches.
  function seedream45Spec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...imageSpec(params),
      modelId: 'seedream-4-5',
      providerModelId: 'doubao-seedream-4.5',
    };
  }

  it('text-to-image uses the t2i slug and sends no reference field', () => {
    expect(buildKieImageBody(seedream45Spec({ aspect_ratio: '16:9' }))).toEqual({
      model: 'seedream/4.5-text-to-image',
      input: {
        prompt: 'a red cube',
        aspect_ratio: '16:9',
        quality: 'basic',
      },
    });
  });

  it('attaching references switches to the `seedream/4.5-edit` sibling slug', () => {
    const body = buildKieImageBody(seedream45Spec({ imageUrls: ['https://x/a.png'] }));
    expect(body['model']).toBe('seedream/4.5-edit');
    expect((body['input'] as Record<string, unknown>)['image_urls']).toEqual(['https://x/a.png']);
  });

  it('accepts 14 reference images — kie documents image_urls maxItems 14, matching the row maxRefs', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => `https://x/ref${i}.png`);
    const input = buildKieImageBody(seedream45Spec({ imageUrls: sixteen }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['image_urls']).toHaveLength(14);
    expect(input['image_urls']).toEqual(sixteen.slice(0, 14));
  });

  it('maps resolution tiers onto `quality` — basic=2K, high=4K; kie 4.5 has no 1K tier', () => {
    const quality = (params: Record<string, unknown>) =>
      (buildKieImageBody(seedream45Spec(params))['input'] as Record<string, unknown>)['quality'];
    expect(quality({ resolution: '1K' })).toBe('basic'); // 1K → 2K: pure upgrade at kie's flat price
    expect(quality({ resolution: '2K' })).toBe('basic');
    expect(quality({ resolution: '4K' })).toBe('high');
    expect(quality({})).toBe('basic');
    // kie's 4.5 schema documents only {prompt, image_urls?, aspect_ratio, quality} —
    // no `resolution` or `output_format` field, so neither is sent.
    const input = buildKieImageBody(seedream45Spec({ resolution: '4K' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input).not.toHaveProperty('resolution');
    expect(input).not.toHaveProperty('output_format');
  });
});

describe('kie.ai image body — Seedream 5.0 Pro', () => {
  function seedreamSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...imageSpec(params),
      modelId: 'seedream-5-0-pro',
      providerModelId: 'seedream-5-0-pro',
    };
  }

  it('text-to-image uses the t2i slug and sends no reference field', () => {
    expect(buildKieImageBody(seedreamSpec({ aspect_ratio: '16:9' }))).toEqual({
      model: 'seedream/5-pro-text-to-image',
      input: {
        prompt: 'a red cube',
        aspect_ratio: '16:9',
        quality: 'basic',
        output_format: 'png',
      },
    });
  });

  it('attaching references switches to the image-to-image slug', () => {
    const body = buildKieImageBody(seedreamSpec({ imageUrls: ['https://x/a.png'] }));
    expect(body['model']).toBe('seedream/5-pro-image-to-image');
    expect((body['input'] as Record<string, unknown>)['image_urls']).toEqual(['https://x/a.png']);
  });

  it('accepts 10 reference images — Seedream 5.0 Pro doubles the 8 the banana models cap at', () => {
    // kie's documented schema is `image_urls` maxItems: 10.
    const twelve = Array.from({ length: 12 }, (_, i) => `https://x/ref${i}.png`);
    const input = buildKieImageBody(seedreamSpec({ imageUrls: twelve }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['image_urls']).toHaveLength(10);
    expect(input['image_urls']).toEqual(twelve.slice(0, 10));
  });

  it('maps the resolution tier onto `quality` — Seedream has no `resolution` field and no 4K', () => {
    const quality = (params: Record<string, unknown>) =>
      (buildKieImageBody(seedreamSpec(params))['input'] as Record<string, unknown>)['quality'];
    expect(quality({ resolution: '1K' })).toBe('basic');
    expect(quality({ resolution: '2K' })).toBe('high');
    // 4K is not offered by the vendor; ask for the best real tier rather than
    // forwarding an off-enum value.
    expect(quality({ resolution: '4K' })).toBe('high');
    expect(quality({})).toBe('basic');
    for (const params of [{ resolution: '2K' }, {}]) {
      expect(buildKieImageBody(seedreamSpec(params))['input']).not.toHaveProperty('resolution');
    }
  });
});

describe('kie.ai image body — Seedream 5.0 Lite', () => {
  function liteSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...imageSpec(params),
      modelId: 'seedream-5-0-lite',
      providerModelId: 'seedream-5-0-lite',
    };
  }

  it('text-to-image uses the t2i slug and sends no reference field', () => {
    expect(buildKieImageBody(liteSpec({ aspect_ratio: '21:9' }))).toEqual({
      model: 'seedream/5-lite-text-to-image',
      input: {
        prompt: 'a red cube',
        aspect_ratio: '21:9',
        quality: 'basic',
        output_format: 'png',
      },
    });
  });

  it('attaching references switches to the image-to-image slug, capped at 10', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `https://x/ref${i}.png`);
    const body = buildKieImageBody(liteSpec({ imageUrls: twelve }));
    expect(body['model']).toBe('seedream/5-lite-image-to-image');
    expect((body['input'] as Record<string, unknown>)['image_urls']).toEqual(twelve.slice(0, 10));
  });

  it('maps resolution tiers onto `quality` — basic=2K, high=3K, ultra=4K', () => {
    const quality = (params: Record<string, unknown>) =>
      (buildKieImageBody(liteSpec(params))['input'] as Record<string, unknown>)['quality'];
    expect(quality({ resolution: '2K' })).toBe('basic');
    expect(quality({ resolution: '3K' })).toBe('high');
    expect(quality({ resolution: '4K' })).toBe('ultra');
    // No resolution asked → the vendor default (basic = 2K), never an off-enum value.
    expect(quality({})).toBe('basic');
    expect(quality({ resolution: '1K' })).toBe('basic');
    expect(buildKieImageBody(liteSpec({ resolution: '4K' }))['input']).not.toHaveProperty(
      'resolution',
    );
  });
});

describe('kie.ai video body — HappyHorse 1.1', () => {
  function happyHorseSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...videoSpec(params),
      modelId: 'happyhorse-1-1-kie',
      providerModelId: 'happyhorse-1-1-text-to-video',
    };
  }

  it('text-to-video sends the verified schema: numeric duration, resolution, aspect_ratio', () => {
    expect(
      buildKieVideoBody(
        happyHorseSpec({ duration_seconds: 8, resolution: '720p', aspect_ratio: '9:16' }),
      ),
    ).toEqual({
      model: 'happyhorse-1-1/text-to-video',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: 8,
        resolution: '720p',
        aspect_ratio: '9:16',
      },
    });
  });

  it('sends duration as a NUMBER — unlike gemini-omni, HappyHorse declares type:number', () => {
    const input = buildKieVideoBody(happyHorseSpec({ duration_seconds: 8 }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['duration']).toBe(8);
    expect(input['duration']).not.toBe('8');
  });

  it('floors to the 4s min-billable, caps at the ROW max, and ceils fractional seconds', () => {
    const duration = (params: Record<string, unknown>) =>
      (buildKieVideoBody(happyHorseSpec(params))['input'] as Record<string, unknown>)['duration'];
    // Sub-min floors to 4 (min of [4,6,8,10]) — NOT kie's 3s schema floor — so we
    // never deliver fewer seconds than billing charges.
    expect(duration({ duration_seconds: 1 })).toBe(4);
    // Caps at the ROW maxDurationSeconds (10), not kie's raw 15s ceiling (COGS leak).
    expect(duration({ duration_seconds: 60 })).toBe(10);
    // ceil, matching billing's Math.ceil(duration): 6.4 → 7, not 6.
    expect(duration({ duration_seconds: 6.4 })).toBe(7);
    expect(duration({})).toBe(5);
  });

  it('drops an off-enum resolution rather than forwarding it (720p/1080p only)', () => {
    const input = buildKieVideoBody(happyHorseSpec({ resolution: '480p' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input).not.toHaveProperty('resolution');
  });

  it('never sends an audio field — 1.1 emits native audio jointly, kie exposes no toggle', () => {
    const input = buildKieVideoBody(happyHorseSpec({ generate_audio: true, audio: true }))[
      'input'
    ] as Record<string, unknown>;
    expect(input).not.toHaveProperty('generate_audio');
    expect(input).not.toHaveProperty('audio');
  });

  it('an attached image switches to the i2v slug: exactly one image, and no aspect_ratio', () => {
    // kie's image-to-video schema takes exactly one URL and derives the ratio
    // from the source image, so a Board-supplied ratio must be dropped.
    const body = buildKieVideoBody(
      happyHorseSpec({
        aspect_ratio: '9:16',
        imageUrls: ['https://x/first.png', 'https://x/second.png'],
      }),
    );
    expect(body['model']).toBe('happyhorse-1-1/image-to-video');
    expect(body['input']).toEqual({
      prompt: 'a whale breaching at sunset',
      duration: 5,
      image_urls: ['https://x/first.png'],
    });
  });
});

describe('kie.ai video body — Gemini Omni regression pin', () => {
  // buildKieVideoBody became slug-driven on 2026-07-16 (it used to hardcode
  // `model: 'gemini-omni-video'`). This pins the pre-existing body byte-for-byte
  // so the de-hardcoding cannot drift the only route that was already live.
  //
  // 2026-07-17: kie's live 422 ("Aspect ratio only supports [16:9, 9:16]")
  // proved aspect_ratio is actually REQUIRED, and resolution is accepted —
  // this pin was updated to include them (was the P0 bug: omni fell back to
  // Atlas at ~2.7x COGS on every job).
  // The request deliberately ASKS for 1080p and must still come back 720p: omni is a
  // 720p product (owner ruling 2026-08-09) and the reserve leg on Atlas cannot serve
  // anything else, so honouring the ask would make failover change the delivered file.
  it('sends aspect_ratio and pins resolution to 720p even when 1080p is asked', () => {
    expect(
      buildKieVideoBody(
        videoSpec({
          duration_seconds: 6,
          aspect_ratio: '9:16',
          resolution: '1080p',
          generate_audio: false,
        }),
      ),
    ).toEqual({
      model: 'gemini-omni-video',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: '6',
        aspect_ratio: '9:16',
        resolution: '720p',
      },
    });
  });

  it('FORWARDS legacy frameImages through Omni image_urls before generic references', () => {
    expect(
      buildKieVideoBody(
        videoSpec({
          frameImages: [{ role: 'first', url: 'https://x/legacy-frame.png' }],
          imageUrls: ['https://x/a.png', 'https://x/b.png'],
        }),
      ),
    ).toEqual({
      model: 'gemini-omni-video',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: '4',
        aspect_ratio: '16:9',
        resolution: '720p',
        image_urls: ['https://x/legacy-frame.png', 'https://x/a.png', 'https://x/b.png'],
      },
    });
  });

  it('FORWARDS a frameImages-only pre-deploy job instead of silently rendering Omni t2v', () => {
    const body = buildKieVideoBody(
      videoSpec({
        frameImages: [
          { role: 'last', url: 'https://x/legacy-last.png' },
          { role: 'first', url: 'https://x/legacy-first.png' },
        ],
      }),
    );

    expect(body['input']).toMatchObject({
      image_urls: ['https://x/legacy-last.png', 'https://x/legacy-first.png'],
    });
  });

  it('maps a portrait ratio outside the kie enum to the nearer of 16:9/9:16', () => {
    const input = buildKieVideoBody(videoSpec({ aspect_ratio: '3:4' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['aspect_ratio']).toBe('9:16');
  });

  it('maps a landscape ratio outside the kie enum to 16:9', () => {
    const input = buildKieVideoBody(videoSpec({ aspect_ratio: '21:9' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['aspect_ratio']).toBe('16:9');
  });

  it('passes resolution=720p through when the job asked for it', () => {
    const input = buildKieVideoBody(videoSpec({ resolution: '720p' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['resolution']).toBe('720p');
  });

  // Every input lands on 720p now — off-enum, absent, or a legitimate 1080p ask alike.
  // kie bills this route flat per second regardless of rung, so this is a product
  // decision, not a cost one; the assertion is here so a future «free upgrade» has to
  // argue with the ruling instead of slipping through as a default.
  it('pins resolution to 720p for every input — off-enum, absent, or 1080p', () => {
    const of = (params: Record<string, unknown>) =>
      (buildKieVideoBody(videoSpec(params))['input'] as Record<string, unknown>)['resolution'];
    expect(of({ resolution: '480p' })).toBe('720p');
    expect(of({})).toBe('720p');
    expect(of({ resolution: '1080p' })).toBe('720p');
    expect(of({ resolution: '720p' })).toBe('720p');
  });

  it('duration is still a STRING, unlike HappyHorse', () => {
    const input = buildKieVideoBody(videoSpec({ duration_seconds: 6 }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['duration']).toBe('6');
    expect(input['duration']).not.toBe(6);
  });
});

describe('kie.ai adapter — async task flow', () => {
  it('creates a task, polls until success, and downloads the result asset', async () => {
    const pool = agent.get(BASE);
    let createBody: Record<string, unknown> | null = null;
    pool.intercept({ path: '/api/v1/jobs/createTask', method: 'POST' }).reply(200, (req) => {
      createBody = JSON.parse(req.body as string) as Record<string, unknown>;
      return { code: 200, msg: 'success', data: { taskId: 'task_1' } };
    });
    pool
      .intercept({ path: '/api/v1/jobs/recordInfo?taskId=task_1', method: 'GET' })
      .reply(200, { code: 200, data: { taskId: 'task_1', state: 'generating' } });
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=task_1', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'task_1',
        state: 'success',
        creditsConsumed: 8,
        resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.test/out.png'] }),
      },
    });
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/out.png', method: 'GET' })
      .reply(200, png, { headers: { 'content-type': 'image/png' } });

    const adapter = makeAdapter();
    const spec = imageSpec({ aspect_ratio: '16:9', resolution: '4K' });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('task_1');
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.bytes.equals(png)).toBe(true);
    expect(result.meta).toMatchObject({
      providerCostKieCredits: 8,
      providerCostUsd: 0.04,
      providerCostComplete: true,
      providerCostSource: 'kie.creditsConsumed',
    });
    expect(createBody!['model']).toBe('nano-banana-pro');
    expect(createBody!['input']).toEqual({
      prompt: 'a red cube',
      aspect_ratio: '16:9',
      resolution: '4K',
      output_format: 'png',
    });
  });

  it('a "fail" state throws a non-retryable ProviderError with the failMsg', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/jobs/createTask', method: 'POST' })
      .reply(200, { code: 200, data: { taskId: 'task_2' } });
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=task_2', method: 'GET' }).reply(200, {
      code: 200,
      data: { taskId: 'task_2', state: 'fail', failCode: 'CONTENT_POLICY', failMsg: 'blocked' },
    });

    const adapter = makeAdapter();
    const handle = await adapter.generate(imageSpec());
    await expect(adapter.awaitResult(handle, imageSpec())).rejects.toMatchObject({
      code: 'CONTENT_POLICY',
      retryable: false,
      message: 'blocked',
    });
  });

  it('missing taskId in the create response throws NO_TASK_ID with the real msg field', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/jobs/createTask', method: 'POST' })
      .reply(200, { code: 400, msg: 'bad request' });
    await expect(makeAdapter().generate(imageSpec())).rejects.toMatchObject({
      code: 'NO_TASK_ID',
      message: 'bad request',
    });
  });

  it('fans out n into independently pollable tasks and returns every billed asset', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/jobs/createTask', method: 'POST' })
      .reply(200, { code: 200, data: { taskId: 'batch_a' } });
    pool
      .intercept({ path: '/api/v1/jobs/createTask', method: 'POST' })
      .reply(200, { code: 200, data: { taskId: 'batch_b' } });
    for (const [taskId, file] of [
      ['batch_a', 'a.png'],
      ['batch_b', 'b.png'],
    ] as const) {
      pool
        .intercept({ path: `/api/v1/jobs/recordInfo?taskId=${taskId}`, method: 'GET' })
        .reply(200, {
          code: 200,
          data: {
            taskId,
            state: 'success',
            resultJson: JSON.stringify({ resultUrls: [`https://cdn.kie.test/${file}`] }),
          },
        });
      agent
        .get('https://cdn.kie.test')
        .intercept({ path: `/${file}`, method: 'GET' })
        .reply(200, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), {
          headers: { 'content-type': 'image/png' },
        });
    }

    const adapter = makeAdapter();
    const spec = imageSpec({ n: 2, aspect_ratio: '1:1', resolution: '2K' });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toContain('kie-batch:');
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(2);
  });

  it('fails the batch when one billed task completes without an image', async () => {
    const pool = agent.get(BASE);
    for (const taskId of ['partial_a', 'partial_b']) {
      pool
        .intercept({ path: '/api/v1/jobs/createTask', method: 'POST' })
        .reply(200, { code: 200, data: { taskId } });
    }
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=partial_a', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'partial_a',
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.test/a.png'] }),
      },
    });
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=partial_b', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'partial_b',
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: [] }),
      },
    });
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/a.png', method: 'GET' })
      .reply(200, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), {
        headers: { 'content-type': 'image/png' },
      });

    const adapter = makeAdapter();
    const spec = imageSpec({ n: 2 });
    const handle = await adapter.generate(spec);
    await expect(adapter.awaitResult(handle, spec)).rejects.toMatchObject({
      code: 'NO_ASSET',
      retryable: true,
    });
  });
});

describe('kie.ai adapter — video (Gemini Omni Flash)', () => {
  it('creates a video task with the real gemini-omni-video schema and downloads an mp4', async () => {
    const pool = agent.get(BASE);
    let createBody: Record<string, unknown> | null = null;
    pool.intercept({ path: '/api/v1/jobs/createTask', method: 'POST' }).reply(200, (req) => {
      createBody = JSON.parse(req.body as string) as Record<string, unknown>;
      return { code: 200, msg: 'success', data: { taskId: 'vtask_1' } };
    });
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=vtask_1', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'vtask_1',
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.test/out.mp4'] }),
      },
    });
    const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/out.mp4', method: 'GET' })
      .reply(200, mp4, { headers: { 'content-type': 'video/mp4' } });

    const adapter = makeAdapter();
    const spec = videoSpec({
      duration_seconds: 6,
      aspect_ratio: '9:16',
      resolution: '1080p',
      generate_audio: false,
    });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('vtask_1');
    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.extension).toBe('mp4');
    expect(result.assets[0]!.bytes.equals(mp4)).toBe(true);

    expect(createBody!['model']).toBe('gemini-omni-video');
    const input = createBody!['input'] as Record<string, unknown>;
    expect(input['duration']).toBe('6');
    expect(input['aspect_ratio']).toBe('9:16');
    expect(input['resolution']).toBe('720p');
    expect(input).not.toHaveProperty('generate_audio');
  });

  it('attaching a reference image sends image_urls[] in the request', async () => {
    const pool = agent.get(BASE);
    let createBody: Record<string, unknown> | null = null;
    pool.intercept({ path: '/api/v1/jobs/createTask', method: 'POST' }).reply(200, (req) => {
      createBody = JSON.parse(req.body as string) as Record<string, unknown>;
      return { code: 200, data: { taskId: 'vtask_2' } };
    });
    pool.intercept({ path: '/api/v1/jobs/recordInfo?taskId=vtask_2', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'vtask_2',
        state: 'success',
        resultJson: JSON.stringify({ resultUrls: ['https://cdn.kie.test/out2.mp4'] }),
      },
    });
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/out2.mp4', method: 'GET' })
      .reply(200, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), {
        headers: { 'content-type': 'video/mp4' },
      });

    const adapter = makeAdapter();
    const spec = {
      ...videoSpec({
        duration_seconds: 4,
        imageUrls: ['https://x/ref.png'],
      }),
      capabilities: { reference: true },
    };
    await adapter.awaitResult(await adapter.generate(spec), spec);
    expect((createBody!['input'] as Record<string, unknown>)['image_urls']).toEqual([
      'https://x/ref.png',
    ]);
  });

  it('a non-video, non-image kind still throws', () => {
    const adapter = makeAdapter();
    const spec = { ...imageSpec(), kind: 'voice' as const };
    return expect(adapter.generate(spec)).rejects.toThrow(/only supports image and video/);
  });
});

describe('kie.ai video body — Grok Imagine', () => {
  function grokSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...videoSpec(params),
      modelId: 'grok-imagine-video',
      providerModelId: 'x-ai/grok-imagine-video',
    };
  }

  it('text-to-video sends the verified schema: numeric duration, capped resolution, aspect_ratio', () => {
    // Reference paid run: duration 6 (number), resolution 720p, aspect 16:9.
    expect(
      buildKieVideoBody(
        grokSpec({ duration_seconds: 6, resolution: '720p', aspect_ratio: '16:9' }),
      ),
    ).toEqual({
      model: 'grok-imagine/text-to-video',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: 6,
        resolution: '720p',
        aspect_ratio: '16:9',
      },
    });
  });

  it('sends duration as a NUMBER (grok schema), unlike gemini-omni', () => {
    const input = buildKieVideoBody(grokSpec({ duration_seconds: 6 }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['duration']).toBe(6);
    expect(input['duration']).not.toBe('6');
  });

  it('caps resolution at 720p — a 1080p request maps down (kie 422s on 1080p)', () => {
    const resolution = (params: Record<string, unknown>) =>
      (buildKieVideoBody(grokSpec(params))['input'] as Record<string, unknown>)['resolution'];
    expect(resolution({ resolution: '1080p' })).toBe('720p');
    expect(resolution({ resolution: '720p' })).toBe('720p');
    expect(resolution({ resolution: '480p' })).toBe('480p');
    // Unset defaults to the 720p ceiling, not the low tier.
    expect(resolution({})).toBe('720p');
  });

  it('maps an off-enum aspect ratio to the nearer of 16:9 / 9:16', () => {
    const aspect = (params: Record<string, unknown>) =>
      (buildKieVideoBody(grokSpec(params))['input'] as Record<string, unknown>)['aspect_ratio'];
    expect(aspect({ aspect_ratio: '3:4' })).toBe('9:16');
    expect(aspect({ aspect_ratio: '21:9' })).toBe('16:9');
    expect(aspect({})).toBe('16:9');
  });

  it('REJECTS any reference channel — image, video, or audio — grok kie is t2v only', () => {
    // grok is kie-only (frames capability dropped since the 2026-07-19 pin). The kie
    // route can't do i2v, so ANY conditioning input in a crafted request must fail
    // loudly (defense-in-depth), not silently render plain t2v.
    expect(() => buildKieVideoBody(grokSpec({ imageUrls: ['https://x/a.png'] }))).toThrow(
      /text-to-video only/,
    );
    expect(() => buildKieVideoBody(grokSpec({ videoUrls: ['https://x/clip.mp4'] }))).toThrow(
      /text-to-video only/,
    );
    expect(() => buildKieVideoBody(grokSpec({ audioUrls: ['https://x/voice.mp3'] }))).toThrow(
      /text-to-video only/,
    );
    expect(() =>
      buildKieVideoBody({ ...grokSpec(), referenceAssets: ['https://x/ref.mp4'] }),
    ).toThrow(/text-to-video only/);
  });

  it('REJECTS above grok max (6s) but FLOORS a sub-min ask up to 6 (charge parity)', () => {
    const dur = (params: Record<string, unknown>) =>
      (buildKieVideoBody(grokSpec(params))['input'] as Record<string, unknown>)['duration'];
    expect(() => buildKieVideoBody(grokSpec({ duration_seconds: 10 }))).toThrow(
      /exceeds the model maximum 6s/,
    );
    expect(dur({ duration_seconds: 6 })).toBe(6);
    // A crafted sub-min ask floors to 6 — the same value minBillableDurationSeconds
    // bills — so we never deliver fewer seconds than we charged.
    expect(dur({ duration_seconds: 1 })).toBe(6);
    // ceil (billing parity): a fractional 6.4 → 7 > 6 is REJECTED, exactly as the
    // billing selector rejects it — never serve-6-but-bill-nothing or mismatch.
    expect(() => buildKieVideoBody(grokSpec({ duration_seconds: 6.4 }))).toThrow(
      /exceeds the model maximum 6s/,
    );
  });
});

describe('kie.ai video body — Wan 2.7 (kie primary, OpenRouter fallback)', () => {
  function wanSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...videoSpec(params),
      modelId: 'wan-2-7',
      providerModelId: 'alibaba/wan-2.7',
    };
  }

  it('maps to the verified kie slug', () => {
    expect(kieModelSlug('alibaba/wan-2.7')).toBe('wan/2-7-text-to-video');
    // Non-veo route: served through createTask/recordInfo like gemini-omni/grok.
    expect(isKieVeoModel('alibaba/wan-2.7')).toBe(false);
  });

  it('text-to-video sends the verified schema: string duration, resolution, ratio', () => {
    // Reference paid run (route #8, 2026-07-16): 720p, aspect 16:9 → 1280x720. That run
    // could NOT have caught a wrong field name: 16:9 is also what kie renders when the
    // ratio field is absent, so the only aspect we ever paid to observe is the one the
    // bug is invisible at. The spec is the authority here, not the receipt.
    expect(
      buildKieVideoBody(wanSpec({ duration_seconds: 6, resolution: '720p', aspect_ratio: '16:9' })),
    ).toEqual({
      model: 'wan/2-7-text-to-video',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: '6',
        ratio: '16:9',
        resolution: '720p',
      },
    });
  });

  it('names the aspect field `ratio` — this route is the ONE kie spec that does', () => {
    // wan__2-7-text-to-video.md declares `ratio` and marks it REQUIRED; the other 53
    // captured kie specs declare `aspect_ratio`. Sending the common name here means the
    // vendor drops it and serves 16:9, so 9:16 and 1:1 were charged and never delivered.
    const input = buildKieVideoBody(wanSpec({ aspect_ratio: '9:16' }))['input'] as Record<
      string,
      unknown
    >;
    expect(input['ratio']).toBe('9:16');
    expect(input).not.toHaveProperty('aspect_ratio');
  });

  it('defaults resolution to 1080p and only 720p stays 720p (kie serves both)', () => {
    const res = (params: Record<string, unknown>) =>
      (buildKieVideoBody(wanSpec(params))['input'] as Record<string, unknown>)['resolution'];
    expect(res({ resolution: '720p' })).toBe('720p');
    expect(res({ resolution: '1080p' })).toBe('1080p');
    expect(res({})).toBe('1080p');
  });

  it('sends duration as a STRING and clamps to the billable 4–10s window', () => {
    const dur = (params: Record<string, unknown>) =>
      (buildKieVideoBody(wanSpec(params))['input'] as Record<string, unknown>)['duration'];
    expect(dur({ duration_seconds: 5 })).toBe('5');
    // Sub-min floors to 4 — the MIN BILLABLE duration (min of [4,6,8,10]) that
    // minBillableDurationSeconds charges — NOT kie's lower 3s schema floor, else a
    // crafted 1–3s ask would be billed 4s but delivered 3s (charge > deliver).
    expect(dur({ duration_seconds: 1 })).toBe('4');
    expect(dur({ duration_seconds: 3 })).toBe('4');
    // Above the 10s catalog max is rejected, not clamped (no fewer-seconds-than-charged).
    expect(() => buildKieVideoBody(wanSpec({ duration_seconds: 12 }))).toThrow(
      /exceeds the model maximum 10s/,
    );
  });

  it('passes a declared aspect ratio through unchanged — 1:1 is NOT collapsed to 16:9', () => {
    const aspect = (params: Record<string, unknown>) =>
      (buildKieVideoBody(wanSpec(params))['input'] as Record<string, unknown>)['ratio'];
    // Wan advertises {16:9, 9:16, 1:1}; each must survive so square presets aren't faked.
    expect(aspect({ aspect_ratio: '1:1' })).toBe('1:1');
    expect(aspect({ aspect_ratio: '9:16' })).toBe('9:16');
    expect(aspect({ aspect_ratio: '16:9' })).toBe('16:9');
    // Off-enum (UI can't produce) and unset both default to 16:9.
    expect(aspect({ aspect_ratio: '21:9' })).toBe('16:9');
    expect(aspect({})).toBe('16:9');
  });

  it('REJECTS non-frame conditioning so such a job falls back, not silent t2v', () => {
    // Frames now have their own kie slug (see the i2v block below) — and for a
    // frames-capable model `imageUrls` ARE frames, so they are served, not refused.
    // Video and audio channels still throw and the chain re-runs the job on OpenRouter.
    expect(() => buildKieVideoBody(wanSpec({ videoUrls: ['https://x/clip.mp4'] }))).toThrow(
      /text-to-video only/,
    );
    expect(() => buildKieVideoBody(wanSpec({ audioUrls: ['https://x/a.mp3'] }))).toThrow(
      /text-to-video only/,
    );
  });

  /**
   * Keyframed Wan jobs were refused on kie and served by the OpenRouter reserve, because
   * `wan/2-7-image-to-video` had never been wired — so every one of them paid the dearer
   * leg. These pin the three ways the i2v schema differs from its t2v sibling; copying
   * the sibling across would be silent in each case.
   */
  describe('image-to-video: its own slug, its own field names', () => {
    const framed = (params: Record<string, unknown> = {}) =>
      buildKieVideoBody(
        wanSpec({
          frameImages: [{ role: 'first', url: 'https://x/first.png' }],
          ...params,
        }),
      );

    it('sends the i2v slug with a NAMED first frame', () => {
      expect(framed({ duration_seconds: 6, resolution: '720p' })).toEqual({
        model: 'wan/2-7-image-to-video',
        input: {
          prompt: 'a whale breaching at sunset',
          first_frame_url: 'https://x/first.png',
          duration: 6,
          resolution: '720p',
        },
      });
    });

    it('carries a last frame alongside the first', () => {
      const input = framed({
        frameImages: [
          { role: 'first', url: 'https://x/first.png' },
          { role: 'last', url: 'https://x/last.png' },
        ],
      })['input'] as Record<string, unknown>;
      expect(input['first_frame_url']).toBe('https://x/first.png');
      expect(input['last_frame_url']).toBe('https://x/last.png');
    });

    it('sends duration as an INTEGER — t2v sends a string, this route does not', () => {
      expect(
        (framed({ duration_seconds: 8 })['input'] as Record<string, unknown>)['duration'],
      ).toBe(8);
    });

    it('sends NO aspect field — the frame decides the shape', () => {
      const input = framed({ aspect_ratio: '9:16' })['input'] as Record<string, unknown>;
      expect(input).not.toHaveProperty('ratio');
      expect(input).not.toHaveProperty('aspect_ratio');
    });

    it('keeps the 4–10s billing window, not the schema’s wider 2–15', () => {
      // Floor to the MIN BILLABLE 4s so a crafted sub-4s ask is not billed 4s and
      // delivered shorter; above the catalogue max is rejected rather than clamped.
      expect(
        (framed({ duration_seconds: 2 })['input'] as Record<string, unknown>)['duration'],
      ).toBe(4);
      expect(() => framed({ duration_seconds: 12 })).toThrow(/exceeds the model maximum 10s/);
    });

    it('refuses a LAST-frame-only job so the reserve serves it', () => {
      expect(() =>
        buildKieVideoBody(wanSpec({ frameImages: [{ role: 'last', url: 'https://x/last.png' }] })),
      ).toThrow(/last-frame-only/);
    });

    it('takes a keyframe sent as imageUrls — that is how the Board sends one', () => {
      const input = buildKieVideoBody(wanSpec({ imageUrls: ['https://x/kf.png'] }))[
        'input'
      ] as Record<string, unknown>;
      expect(input['first_frame_url']).toBe('https://x/kf.png');
    });

    it('still refuses video/audio conditioning on the framed route', () => {
      expect(() => framed({ videoUrls: ['https://x/clip.mp4'] })).toThrow(/not wired/);
    });

    it('refuses a third image rather than dropping it after charging for it', () => {
      expect(() =>
        buildKieVideoBody(
          wanSpec({ imageUrls: ['https://x/1.png', 'https://x/2.png', 'https://x/3.png'] }),
        ),
      ).toThrow(/frame slot/);
    });
  });
});

describe('kie.ai video body — Seedance 2.0 (OpenRouter primary, kie availability fallback)', () => {
  function seedanceSpec(
    providerModelId: string,
    params: Record<string, unknown> = {},
  ): WorkflowSpec {
    const reference = /reference-to-video/i.test(providerModelId);
    return {
      ...videoSpec(params),
      modelId: 'seedance-2-0',
      providerModelId,
      maxDurationSeconds: 15,
      capabilities: reference
        ? { reference: true, maxRefs: 9, maxVideoRefs: 3, maxAudioRefs: 3 }
        : { frames: ['first', 'last'] },
    };
  }

  it('std t2v sends the verified schema with the seedance-2 slug', () => {
    expect(
      buildKieVideoBody(
        seedanceSpec('seedance-2.0-text-to-video', {
          duration_seconds: 6,
          resolution: '1080p',
          aspect_ratio: '16:9',
        }),
      ),
    ).toEqual({
      model: 'bytedance/seedance-2',
      input: {
        prompt: 'a whale breaching at sunset',
        duration: 6,
        resolution: '1080p',
        aspect_ratio: '16:9',
      },
    });
  });

  it('fast has NO 1080p on kie — a 1080p request maps down to 720p', () => {
    const res = (params: Record<string, unknown>) =>
      (
        buildKieVideoBody(seedanceSpec('seedance-2-0-fast', params))['input'] as Record<
          string,
          unknown
        >
      )['resolution'];
    expect(res({ resolution: '1080p' })).toBe('720p');
    expect(res({ resolution: '720p' })).toBe('720p');
    expect(res({ resolution: '480p' })).toBe('480p');
  });

  it('reference rows attach image, video, and audio references on the shared kie slug', () => {
    const referenceBody = buildKieVideoBody(
      seedanceSpec('seedance-2.0-reference-to-video', {
        imageUrls: ['https://x/reference.png'],
        videoUrls: ['https://x/reference.mp4'],
        audioUrls: ['https://x/reference.mp3'],
      }),
    );
    expect(referenceBody['input']).toMatchObject({
      reference_image_urls: ['https://x/reference.png'],
      reference_video_urls: ['https://x/reference.mp4'],
      reference_audio_urls: ['https://x/reference.mp3'],
    });
  });

  it('REJECTS frame-row imageUrls instead of reinterpreting a first frame as a reference', () => {
    expect(() =>
      buildKieVideoBody(
        seedanceSpec('seedance-2.0-text-to-video', {
          imageUrls: ['https://x/first-frame.png'],
        }),
      ),
    ).toThrow(/advertises positional frames.*refusing to reinterpret or drop conditioning/i);
  });

  it('FORWARDS referenceAssets on reference rows, deduplicated with imageUrls', () => {
    const body = buildKieVideoBody({
      ...seedanceSpec('seedance-2.0-reference-to-video', {
        imageUrls: ['https://x/shared.png', 'https://x/param.png'],
      }),
      referenceAssets: ['https://x/shared.png', 'https://x/public-field.png'],
    });

    expect(body['input']).toMatchObject({
      reference_image_urls: [
        'https://x/shared.png',
        'https://x/param.png',
        'https://x/public-field.png',
      ],
    });
  });

  it('REJECTS referenceAssets on frame-only rows instead of silently dropping them', () => {
    expect(() =>
      buildKieVideoBody({
        ...seedanceSpec('seedance-2.0-text-to-video'),
        referenceAssets: ['https://x/public-field.png'],
      }),
    ).toThrow(/advertises positional frames.*refusing to reinterpret or drop conditioning/i);
  });

  it('REJECTS conditioning above kie caps instead of silently truncating it', () => {
    const ref = (params: Record<string, unknown>) =>
      buildKieVideoBody(seedanceSpec('seedance-2.0-reference-to-video', params));
    expect(() =>
      ref({ imageUrls: Array.from({ length: 10 }, (_, i) => `https://x/image-${i}.png`) }),
    ).toThrow(/received 10\/0\/0.*refusing to silently truncate conditioning/i);
    expect(() =>
      ref({ videoUrls: Array.from({ length: 4 }, (_, i) => `https://x/video-${i}.mp4`) }),
    ).toThrow(/received 0\/4\/0.*refusing to silently truncate conditioning/i);
    expect(() =>
      ref({ audioUrls: Array.from({ length: 4 }, (_, i) => `https://x/audio-${i}.mp3`) }),
    ).toThrow(/received 0\/0\/4.*refusing to silently truncate conditioning/i);
  });

  it('floors duration to the 4s min-billable and caps at maxDurationSeconds', () => {
    const dur = (params: Record<string, unknown>) =>
      (
        buildKieVideoBody(seedanceSpec('seedance-2.0-text-to-video', params))['input'] as Record<
          string,
          unknown
        >
      )['duration'];
    expect(dur({ duration_seconds: 1 })).toBe(4);
    expect(dur({ duration_seconds: 20 })).toBe(15);
    // ceil, matching billing's Math.ceil: 4.1 → 5, never delivered below billed.
    expect(dur({ duration_seconds: 4.1 })).toBe(5);
  });

  it('seedance rows reject explicit frames instead of remapping them as references', () => {
    const t2v = (params: Record<string, unknown>) =>
      buildKieVideoBody(seedanceSpec('seedance-2.0-text-to-video', params));
    expect(() => t2v({ frameImages: [{ role: 'first', url: 'https://x/f.png' }] })).toThrow(
      /advertises positional frames.*refusing to reinterpret or drop conditioning/i,
    );
  });

  it('reference rows reject explicit frames without rejecting other documented references', () => {
    const ref = (params: Record<string, unknown>) =>
      buildKieVideoBody(seedanceSpec('seedance-2.0-reference-to-video', params));
    expect(() => ref({ frameImages: [{ role: 'first', url: 'https://x/f.png' }] })).toThrow(
      /references are supported.*frames are not/i,
    );
  });
});

describe('kie.ai video body — Veo 3.1 (dedicated /veo/generate)', () => {
  function veoSpec(providerModelId: string, params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...videoSpec(params),
      modelId: 'veo-3-1',
      providerModelId,
    };
  }

  it('submits kie veo3 schema per docs.kie.ai: no `input` wrapper, TEXT_2_VIDEO + snake_case aspect_ratio', () => {
    // Field names follow kie's published veo/generate schema: camelCase
    // generationType with the UPPERCASE enum value, but snake_case aspect_ratio (the
    // earlier stub sent generationType:'text-to-video' + camelCase aspectRatio; kie
    // ignored the misspelled key → every clip came out 16:9).
    expect(
      buildKieVeoBody(veoSpec('google/veo-3.1', { duration_seconds: 8, aspect_ratio: '16:9' })),
    ).toEqual({
      model: 'veo3',
      prompt: 'a whale breaching at sunset',
      generationType: 'TEXT_2_VIDEO',
      resolution: '720p',
      duration: 8,
      aspect_ratio: '16:9',
    });
  });

  it('maps each Veo variant to its own model slug', () => {
    expect(buildKieVeoBody(veoSpec('google/veo-3.1'))['model']).toBe('veo3');
    expect(buildKieVeoBody(veoSpec('google/veo-3.1-fast'))['model']).toBe('veo3_fast');
    expect(buildKieVeoBody(veoSpec('google/veo-3.1-lite'))['model']).toBe('veo3_lite');
  });

  it('passes 720p and 1080p through (both delivered INLINE on generate), REJECTS 4K', () => {
    // Both 720p and 1080p are honored inline on /veo/generate (live-verified 2026-07-19),
    // so the body simply carries the requested resolution. 4K is unwired (needs the
    // get-4k-video two-step) AND unpriced → refuse rather than silently downgrade at a
    // 4K charge.
    expect(buildKieVeoBody(veoSpec('google/veo-3.1', { resolution: '720p' }))['resolution']).toBe(
      '720p',
    );
    expect(buildKieVeoBody(veoSpec('google/veo-3.1', { resolution: '1080p' }))['resolution']).toBe(
      '1080p',
    );
    expect(() => buildKieVeoBody(veoSpec('google/veo-3.1', { resolution: '4K' }))).toThrow(
      /4K needs the \/veo\/get-4k-video two-step/,
    );
    expect(() => buildKieVeoBody(veoSpec('google/veo-3.1', { resolution: '4k' }))).toThrow(
      /4K needs the \/veo\/get-4k-video two-step/,
    );
  });

  it('duration: default 8, floors sub-min to 4, REJECTS above the 8s max', () => {
    expect(buildKieVeoBody(veoSpec('google/veo-3.1'))['duration']).toBe(8);
    expect(buildKieVeoBody(veoSpec('google/veo-3.1', { duration_seconds: 6 }))['duration']).toBe(6);
    // Sub-min floors to veo's 4s vendor minimum (charge parity, same as grok).
    expect(buildKieVeoBody(veoSpec('google/veo-3.1', { duration_seconds: 1 }))['duration']).toBe(4);
    // ceil, matching billing's Math.ceil: a fractional 4.2s serializes 5 (as billed),
    // NOT the 4 that Math.round produced — billed == served.
    expect(buildKieVeoBody(veoSpec('google/veo-3.1', { duration_seconds: 4.2 }))['duration']).toBe(
      5,
    );
    expect(() => buildKieVeoBody(veoSpec('google/veo-3.1', { duration_seconds: 10 }))).toThrow(
      /exceeds the model maximum 8s/,
    );
  });

  it('frame image(s) switch to FIRST_AND_LAST_FRAMES_2_VIDEO with an ordered imageUrls array', () => {
    // One image → single seed frame; two → first+last transition. kie's i2v mode.
    const oneFrame = buildKieVeoBody(
      veoSpec('google/veo-3.1', { imageUrls: ['https://x/first.png'] }),
    );
    expect(oneFrame['generationType']).toBe('FIRST_AND_LAST_FRAMES_2_VIDEO');
    expect(oneFrame['imageUrls']).toEqual(['https://x/first.png']);

    const twoFrames = buildKieVeoBody(
      veoSpec('google/veo-3.1', {
        frameImages: [
          { role: 'last', url: 'https://x/last.png' },
          { role: 'first', url: 'https://x/first.png' },
        ],
      }),
    );
    // Ordered first-then-last regardless of input order.
    expect(twoFrames['generationType']).toBe('FIRST_AND_LAST_FRAMES_2_VIDEO');
    expect(twoFrames['imageUrls']).toEqual(['https://x/first.png', 'https://x/last.png']);
  });

  it('REJECTS a last-only frame set (a lone image is taken as the FIRST frame — wrong semantics)', () => {
    // kie's positional one-image form seeds the FIRST frame, so sending only a 'last'
    // would silently condition the START on the intended ENDING — a wrong deliverable
    // at the same charge. Refuse it.
    expect(() =>
      buildKieVeoBody(
        veoSpec('google/veo-3.1', {
          frameImages: [{ role: 'last', url: 'https://x/last.png' }],
        }),
      ),
    ).toThrow(/last-frame-only/);
  });

  it('REJECTS video/audio/referenceAssets channels — veo takes text + frame images only', () => {
    // veo/generate has no video or audio reference channel, and referenceAssets is
    // not forwarded — a crafted request carrying them must fail loudly, not silently
    // render without them. (Image FRAMES are the one allowed conditioning input.)
    expect(() =>
      buildKieVeoBody(veoSpec('google/veo-3.1', { videoUrls: ['https://x/clip.mp4'] })),
    ).toThrow(/only text \+ frame images/);
    expect(() =>
      buildKieVeoBody(veoSpec('google/veo-3.1', { audioUrls: ['https://x/track.mp3'] })),
    ).toThrow(/only text \+ frame images/);
    expect(() =>
      buildKieVeoBody({
        ...veoSpec('google/veo-3.1'),
        referenceAssets: ['https://x/ref.png'],
      }),
    ).toThrow(/only text \+ frame images/);
  });

  it('maps an off-enum aspect ratio to the nearer of 16:9 / 9:16 (snake_case key)', () => {
    expect(
      buildKieVeoBody(veoSpec('google/veo-3.1', { aspect_ratio: '9:16' }))['aspect_ratio'],
    ).toBe('9:16');
    expect(
      buildKieVeoBody(veoSpec('google/veo-3.1', { aspect_ratio: '4:5' }))['aspect_ratio'],
    ).toBe('9:16');
  });
});

describe('kie.ai adapter — Veo async flow (dedicated endpoints)', () => {
  function veoSpec(params: Record<string, unknown> = {}): WorkflowSpec {
    return {
      ...videoSpec(params),
      modelId: 'veo-3-1',
      providerModelId: 'google/veo-3.1',
    };
  }

  it('submits to /veo/generate, polls /veo/record-info on successFlag, and downloads resultUrls', async () => {
    const pool = agent.get(BASE);
    let submitPath: string | null = null;
    let submitBody: Record<string, unknown> | null = null;
    pool.intercept({ path: '/api/v1/veo/generate', method: 'POST' }).reply(200, (req) => {
      submitPath = req.path;
      submitBody = JSON.parse(req.body as string) as Record<string, unknown>;
      return { code: 200, msg: 'success', data: { taskId: 'veo_1' } };
    });
    // First poll: still generating (successFlag 0). Second: done (1).
    pool
      .intercept({ path: '/api/v1/veo/record-info?taskId=veo_1', method: 'GET' })
      .reply(200, { code: 200, data: { taskId: 'veo_1', successFlag: 0 } });
    pool.intercept({ path: '/api/v1/veo/record-info?taskId=veo_1', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'veo_1',
        successFlag: 1,
        response: {
          resultUrls: ['https://cdn.kie.test/veo.mp4'],
          hasAudioList: [true],
        },
      },
    });
    const mp4 = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/veo.mp4', method: 'GET' })
      .reply(200, mp4, { headers: { 'content-type': 'video/mp4' } });

    const adapter = makeAdapter();
    const spec = veoSpec({ duration_seconds: 8, aspect_ratio: '16:9' });
    const handle = await adapter.generate(spec);
    expect(handle.providerJobId).toBe('veo_1');
    expect(handle.gateway).toBe('kie');

    const result = await adapter.awaitResult(handle, spec);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.extension).toBe('mp4');
    expect(result.assets[0]!.bytes.equals(mp4)).toBe(true);

    // Pin the dedicated endpoint + the docs.kie.ai submit body.
    expect(submitPath).toBe('/api/v1/veo/generate');
    expect(submitBody).toEqual({
      model: 'veo3',
      prompt: 'a whale breaching at sunset',
      generationType: 'TEXT_2_VIDEO',
      resolution: '720p',
      duration: 8,
      aspect_ratio: '16:9',
    });
  });

  it('1080p is honored INLINE on generate — the base resultUrl is the deliverable (no get-1080p-video call)', async () => {
    // Live-verified 2026-07-19: resolution:1080p on /veo/generate returns a 1920x1080
    // base file, and GET /veo/get-1080p-video 422s ("already a 1080p video"). So the
    // adapter submits resolution:1080p and delivers the base URL directly.
    const pool = agent.get(BASE);
    let submitBody: Record<string, unknown> | null = null;
    pool.intercept({ path: '/api/v1/veo/generate', method: 'POST' }).reply(200, (req) => {
      submitBody = JSON.parse(req.body as string) as Record<string, unknown>;
      return { code: 200, data: { taskId: 'veo_hd' } };
    });
    pool.intercept({ path: '/api/v1/veo/record-info?taskId=veo_hd', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'veo_hd',
        successFlag: 1,
        response: { resultUrls: ['https://cdn.kie.test/veo-1080.mp4'] },
      },
    });
    const hd = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
    agent
      .get('https://cdn.kie.test')
      .intercept({ path: '/veo-1080.mp4', method: 'GET' })
      .reply(200, hd, { headers: { 'content-type': 'video/mp4' } });

    const adapter = makeAdapter();
    const spec = veoSpec({ resolution: '1080p' });
    const handle = await adapter.generate(spec);
    const result = await adapter.awaitResult(handle, spec);
    // resolution:1080p was submitted, and the base file is delivered as-is.
    expect(submitBody!['resolution']).toBe('1080p');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]!.bytes.equals(hd)).toBe(true);
  });

  it('a failing successFlag (>=2) throws a non-retryable ProviderError with the errorMessage', async () => {
    const pool = agent.get(BASE);
    pool
      .intercept({ path: '/api/v1/veo/generate', method: 'POST' })
      .reply(200, { code: 200, data: { taskId: 'veo_2' } });
    pool.intercept({ path: '/api/v1/veo/record-info?taskId=veo_2', method: 'GET' }).reply(200, {
      code: 200,
      data: {
        taskId: 'veo_2',
        successFlag: 2,
        errorCode: 'CONTENT_POLICY',
        errorMessage: 'blocked',
      },
    });

    const adapter = makeAdapter();
    const spec = veoSpec();
    const handle = await adapter.generate(spec);
    await expect(adapter.awaitResult(handle, spec)).rejects.toMatchObject({
      code: 'CONTENT_POLICY',
      retryable: false,
      message: 'blocked',
    });
  });

  it('a missing taskId from /veo/generate throws NO_TASK_ID with the real msg', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/api/v1/veo/generate', method: 'POST' })
      .reply(200, { code: 400, msg: 'bad veo request' });
    await expect(makeAdapter().generate(veoSpec())).rejects.toMatchObject({
      code: 'NO_TASK_ID',
      message: 'bad veo request',
    });
  });
});

describe('kie.ai fetchAsset — media validity (never commit a charge for garbage bytes)', () => {
  const client = () => new KieClient({ baseUrl: BASE, apiKey: 'sk-kie-test' });

  it('rejects a 200 text/html error page as NON_MEDIA (retryable → refund, not a success)', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/asset.mp4', method: 'GET' })
      .reply(200, '<html>upstream error</html>', { headers: { 'content-type': 'text/html' } });
    await expect(client().fetchAsset(`${BASE}/asset.mp4`)).rejects.toMatchObject({
      code: 'NON_MEDIA_ASSET',
      retryable: true,
    });
  });

  it('rejects a 200 JSON error body as NON_MEDIA', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/asset2.mp4', method: 'GET' })
      .reply(200, '{"error":"nope"}', { headers: { 'content-type': 'application/json' } });
    await expect(client().fetchAsset(`${BASE}/asset2.mp4`)).rejects.toMatchObject({
      code: 'NON_MEDIA_ASSET',
    });
  });

  it('rejects an empty 200 body as EMPTY_ASSET even with a media content-type', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/empty.mp4', method: 'GET' })
      .reply(200, '', { headers: { 'content-type': 'video/mp4' } });
    await expect(client().fetchAsset(`${BASE}/empty.mp4`)).rejects.toMatchObject({
      code: 'EMPTY_ASSET',
    });
  });

  it('accepts real non-empty media bytes (mp4 magic present)', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/good.mp4', method: 'GET' })
      .reply(200, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
        headers: { 'content-type': 'video/mp4' },
      });
    const r = await client().fetchAsset(`${BASE}/good.mp4`);
    expect(r.contentType).toBe('video/mp4');
    expect(r.bytes.length).toBeGreaterThan(0);
  });

  it('REJECTS an HTML error page even when FORGED as content-type video/mp4 (bytes win)', async () => {
    // The gap the content-type trust left open: a mislabeled error body.
    agent
      .get(BASE)
      .intercept({ path: '/forged.mp4', method: 'GET' })
      .reply(200, '<!DOCTYPE html><html>upstream 500 error page here</html>', {
        headers: { 'content-type': 'video/mp4' },
      });
    await expect(client().fetchAsset(`${BASE}/forged.mp4`)).rejects.toMatchObject({
      code: 'NON_MEDIA_ASSET',
    });
  });

  it('REJECTS an HTML error page served as application/octet-stream (magic sniff catches it)', async () => {
    // The gap the content-type check alone missed: a mislabeled/unlabeled error body.
    agent
      .get(BASE)
      .intercept({ path: '/mislabeled', method: 'GET' })
      .reply(200, '<!DOCTYPE html><html>gateway error</html>', {
        headers: { 'content-type': 'application/octet-stream' },
      });
    await expect(client().fetchAsset(`${BASE}/mislabeled`)).rejects.toMatchObject({
      code: 'NON_MEDIA_ASSET',
    });
  });

  it('accepts real mp4 bytes even when the type is generic octet-stream (magic passes)', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/octet.mp4', method: 'GET' })
      .reply(200, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]), {
        headers: { 'content-type': 'application/octet-stream' },
      });
    const r = await client().fetchAsset(`${BASE}/octet.mp4`);
    expect(r.bytes.length).toBeGreaterThan(0);
  });

  it('REJECTS a body with a missing content-type and non-media bytes', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/notype', method: 'GET' })
      .reply(200, '{"error":"nope, not media at all here"}');
    await expect(client().fetchAsset(`${BASE}/notype`)).rejects.toMatchObject({
      code: 'NON_MEDIA_ASSET',
    });
  });

  it('ACCEPTS PNG bytes served as octet-stream (magic passes without an image/* type)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    agent
      .get(BASE)
      .intercept({ path: '/octet.png', method: 'GET' })
      .reply(200, png, { headers: { 'content-type': 'application/octet-stream' } });
    const r = await client().fetchAsset(`${BASE}/octet.png`);
    expect(r.bytes.length).toBeGreaterThan(0);
  });

  it('ACCEPTS real mp4 bytes with a MISSING content-type header (defaults octet, magic passes)', async () => {
    agent
      .get(BASE)
      .intercept({ path: '/noheader.mp4', method: 'GET' })
      .reply(200, Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]));
    const r = await client().fetchAsset(`${BASE}/noheader.mp4`);
    expect(r.bytes.length).toBeGreaterThan(0);
    // Defaulted content-type when the header is absent.
    expect(r.contentType).toBe('application/octet-stream');
  });
});
