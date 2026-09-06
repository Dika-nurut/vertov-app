import { describe, expect, it } from 'vitest';
import { seedModels } from '../../../db/seed/models';
import {
  buildAtlasRequest,
  buildKieVideoBody,
  buildOpenRouterVideoBody,
  openRouterVideoSlug,
  type WorkflowSpec,
} from '../src/index';

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is string => typeof candidate === 'string')
    : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is number => typeof candidate === 'number')
    : [];
}

describe('BRD-3 active video catalog → provider-body conformance', () => {
  const activeVideos = seedModels.filter((model) => model.isActive && model.kind === 'video');

  it('pins the current free vendor-schema corrections that prevent invalid controls', () => {
    const byId = new Map(activeVideos.map((model) => [model.id, model]));
    for (const id of ['seedance-2-0-fast', 'seedance-2-0-fast-reference-to-video']) {
      expect(byId.get(id)?.maxResolution, id).toBe('720p');
      expect((byId.get(id)?.capabilities as Record<string, unknown>)['resolutions'], id).toEqual([
        '480p',
        '720p',
      ]);
    }
    // happyhorse-1-0 no longer walked here: withdrawn, so it is not in the ACTIVE
    // catalogue. Its schema correction is unchanged and returns with the model.
    for (const id of ['happyhorse-1-1']) {
      expect((byId.get(id)?.capabilities as Record<string, unknown>)['frames'], id).toEqual([
        'first',
      ]);
    }
    // veo delivers first/last-frame conditioning on kie via generationType
    // FIRST_AND_LAST_FRAMES_2_VIDEO (buildKieVeoBody, wired 2026-07-19), so its frames
    // capability is ['first','last']. grok is wired text-to-video only (no i2v route
    // yet) → frames:[].
    for (const id of ['veo-3-1-fast', 'veo-3-1', 'veo-3-1-lite']) {
      expect((byId.get(id)?.capabilities as Record<string, unknown>)['frames'], id).toEqual([
        'first',
        'last',
      ]);
    }
    expect(
      (byId.get('grok-imagine-video')?.capabilities as Record<string, unknown>)['frames'],
    ).toEqual([]);
  });

  it('maps every OpenRouter row from its declared duration/control/input contract', () => {
    const rows = activeVideos.filter((model) => {
      const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
      // A gatewayOverride pins the row's LIVE primary route away from OpenRouter
      // (veo/grok → kie, 2026-07-19), so exclude those even though their id is
      // slash-form — their body mapping is covered by kie-adapter.test.ts. EXCEPTION:
      // Wan is kie-PRIMARY but keeps fallbackGateway='openrouter' (2026-07-20), so
      // OpenRouter is still a live route for it (the fallback leg) and its OpenRouter
      // body mapping must stay covered here. Only exclude a row when OpenRouter is not
      // one of its routes at all — i.e. kie-ONLY (no OpenRouter fallback).
      const override = (model as { gatewayOverride?: string | null }).gatewayOverride;
      const orFallback =
        (model as { fallbackGateway?: string | null }).fallbackGateway === 'openrouter';
      if (override && !orFallback) return false;
      return capabilities['forceGateway'] === 'openrouter' || model.providerModelId?.includes('/');
    });
    // 12 since 2026-08-04: happyhorse-1-0 withdrawn (finance ruling Q8).
    expect(activeVideos).toHaveLength(12);
    expect(rows).toHaveLength(7);

    for (const model of rows) {
      if (!model.providerModelId) throw new Error(`${model.id}: missing providerModelId`);
      const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
      const durations = numbers(capabilities['durations']);
      const resolutions = strings(capabilities['resolutions']);
      const aspects = strings(capabilities['aspect_ratios']);
      const frameRoles = strings(capabilities['frames']);
      const isReference = /reference-to-video/i.test(model.providerModelId);
      const params: Record<string, unknown> = {
        duration_seconds: durations.at(-1),
        return_last_frame: true,
        ...(resolutions.length ? { resolution: resolutions.at(-1) } : {}),
        ...(aspects.length ? { aspect_ratio: aspects.at(-1) } : {}),
        ...(capabilities['audio'] === true ? { generate_audio: true } : {}),
      };
      if (isReference) {
        params['imageUrls'] = ['https://assets.test/reference.png'];
        params['videoUrls'] = ['https://assets.test/reference.mp4'];
        params['audioUrls'] = ['https://assets.test/reference.mp3'];
      } else if (frameRoles.length > 0) {
        params['frameImages'] = frameRoles.map((role) => ({
          role,
          url: `https://assets.test/${role}.png`,
        }));
      }

      const spec: WorkflowSpec = {
        modelId: model.id,
        providerModelId: model.providerModelId,
        providerEndpoint: model.providerEndpoint ?? '/videos',
        kind: 'video',
        prompt: 'catalog conformance',
        params,
        referenceAssets: [],
        maxDurationSeconds: model.maxDurationSeconds,
        capabilities,
      };
      const body = buildOpenRouterVideoBody(spec);
      expect(body['model'], `${model.id}: model`).toBe(openRouterVideoSlug(model.providerModelId));
      expect(body['duration'], `${model.id}: duration`).toBe(durations.at(-1));
      expect(body['resolution'], `${model.id}: resolution`).toBe(resolutions.at(-1));
      expect(body['aspect_ratio'], `${model.id}: aspect`).toBe(aspects.at(-1));
      expect(body['generate_audio'], `${model.id}: audio`).toBe(
        capabilities['audio'] === true ? true : undefined,
      );

      if (isReference) {
        expect(body['input_references'], `${model.id}: references`).toEqual([
          { type: 'image_url', image_url: { url: 'https://assets.test/reference.png' } },
          { type: 'video_url', video_url: { url: 'https://assets.test/reference.mp4' } },
          { type: 'audio_url', audio_url: { url: 'https://assets.test/reference.mp3' } },
        ]);
        expect(body).not.toHaveProperty('frame_images');
      } else if (frameRoles.length > 0) {
        expect(body['frame_images'], `${model.id}: frames`).toEqual(
          frameRoles.map((role) => ({
            type: 'image_url',
            image_url: { url: `https://assets.test/${role}.png` },
            frame_type: `${role}_frame`,
          })),
        );
      } else {
        expect(body).not.toHaveProperty('frame_images');
      }
    }
  });

  it('sends Gemini Omni aspect_ratio/resolution on kie (required by kie, live 2026-07-17) and stays compatible on Atlas fallback', () => {
    const model = activeVideos.find((candidate) => candidate.id === 'gemini-omni-flash');
    if (!model?.providerModelId) throw new Error('gemini-omni-flash catalog row is missing');
    const capabilities = (model.capabilities ?? {}) as Record<string, unknown>;
    // O-1 (2026-09-02): routing left the capabilities bag — the row now carries
    // gatewayOverride:'kie' + fallbackGateway:'atlascloud' at ROW level. The
    // capability contract itself is unchanged.
    expect((model as Record<string, unknown>)['gatewayOverride']).toBe('kie');
    expect((model as Record<string, unknown>)['fallbackGateway']).toBe('atlascloud');
    expect(capabilities).toMatchObject({
      audio: true,
      audioControl: false,
      // Stays EMPTY, and that is the contract: one fixed output, no customer lever. It is
      // also what pins the price key to the 'default' band finance signs — naming '720p'
      // here makes `priceSelectorFromParams` read the request and omni stops billing.
      // The owner's «у нас только 720» ruling is enforced by `maxResolution` plus the
      // capability contract's 720p enum, and the 480p/1080p the customer used to be
      // offered was a GenerateClient bug, fixed there.
      resolutions: [],
      aspect_ratios: ['16:9', '9:16'],
    });
    const spec: WorkflowSpec = {
      modelId: model.id,
      providerModelId: model.providerModelId,
      providerEndpoint: model.providerEndpoint ?? '/videos',
      kind: 'video',
      prompt: 'catalog conformance',
      params: {
        duration_seconds: 10,
        return_last_frame: true,
        imageUrls: ['https://assets.test/first.png'],
      },
      referenceAssets: [],
      maxDurationSeconds: model.maxDurationSeconds,
      capabilities,
    };

    const kie = buildKieVideoBody(spec);
    expect(kie).toEqual({
      model: 'gemini-omni-video',
      input: {
        prompt: 'catalog conformance',
        duration: '10',
        aspect_ratio: '16:9',
        // 720p on BOTH legs. This assertion used to read 1080p here and 720p on the
        // Atlas body below — the same job delivered at two resolutions depending on
        // which leg answered. Owner ruling 2026-08-09 settles it at 720p everywhere.
        resolution: '720p',
        image_urls: ['https://assets.test/first.png'],
      },
    });

    const atlas = buildAtlasRequest(spec);
    expect(atlas.path).toBe('/model/generateVideo');
    expect(atlas.body).toMatchObject({
      model: 'google/gemini-omni-flash/image-to-video-developer',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
      images: ['https://assets.test/first.png'],
    });
    expect(atlas.body).not.toHaveProperty('generate_audio');
  });
});
