import { describe, expect, it } from 'vitest';
import { buildOpenRouterVideoBody, buildAtlasRequest, type WorkflowSpec } from '../src/index';

/**
 * Contract-drift guard (T4). The other adapter tests assert INDIVIDUAL fields
 * with toMatchObject — which silently tolerates an ADDED or RENAMED field. This
 * file pins the ENTIRE wire body for both live gateways as a golden snapshot,
 * so ANY change to buildOpenRouterVideoBody / buildAtlasRequest (or the params
 * the board sends) fails loudly and must be reviewed. Spending nothing keeps
 * the real contract honest; when an AtlasCloud key lands, one authorized live
 * micro-probe re-confirms these snapshots (same discipline as previz S0).
 *
 * Update intentionally: `pnpm --filter @seed/provider-byteplus test -- -u`.
 */

function videoSpec(
  providerModelId: string,
  params: Record<string, unknown>,
  referenceAssets: string[] = [],
): WorkflowSpec {
  return {
    modelId: 'seedance-2-0',
    providerModelId,
    providerEndpoint: '/api/v3/videos/generations',
    kind: 'video',
    prompt: 'a whale breaching at dawn',
    params,
    referenceAssets,
    maxDurationSeconds: 15,
  };
}

describe('OpenRouter video body — full golden snapshot', () => {
  it('text-to-video', () => {
    expect(
      buildOpenRouterVideoBody(
        videoSpec('seedance-2-0-text-to-video', {
          duration_seconds: 8,
          resolution: '720p',
          aspect_ratio: '16:9',
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "aspect_ratio": "16:9",
        "duration": 8,
        "generate_audio": true,
        "model": "bytedance/seedance-2.0",
        "prompt": "a whale breaching at dawn",
        "resolution": "720p",
      }
    `);
  });

  it('image-to-video (typed frame_images first/last)', () => {
    expect(
      buildOpenRouterVideoBody(
        videoSpec('seedance-2-0-image-to-video', {
          duration_seconds: 5,
          frameImages: [
            { role: 'first', url: 'https://x/first.png' },
            { role: 'last', url: 'https://x/last.png' },
          ],
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "aspect_ratio": "16:9",
        "duration": 5,
        "frame_images": [
          {
            "frame_type": "first_frame",
            "image_url": {
              "url": "https://x/first.png",
            },
            "type": "image_url",
          },
          {
            "frame_type": "last_frame",
            "image_url": {
              "url": "https://x/last.png",
            },
            "type": "image_url",
          },
        ],
        "generate_audio": true,
        "model": "bytedance/seedance-2.0",
        "prompt": "a whale breaching at dawn",
        "resolution": "720p",
      }
    `);
  });

  it('reference-to-video sends typed image / video / audio input_references', () => {
    expect(
      buildOpenRouterVideoBody(
        videoSpec('seedance-2-0-reference-to-video', {
          duration_seconds: 6,
          imageUrls: ['https://x/cast.png'],
          videoUrls: ['https://x/v.mp4'],
          audioUrls: ['https://x/a.mp3'],
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "aspect_ratio": "16:9",
        "duration": 6,
        "generate_audio": true,
        "input_references": [
          {
            "image_url": {
              "url": "https://x/cast.png",
            },
            "type": "image_url",
          },
          {
            "type": "video_url",
            "video_url": {
              "url": "https://x/v.mp4",
            },
          },
          {
            "audio_url": {
              "url": "https://x/a.mp3",
            },
            "type": "audio_url",
          },
        ],
        "model": "bytedance/seedance-2.0",
        "prompt": "a whale breaching at dawn",
        "resolution": "720p",
      }
    `);
  });
});

describe('AtlasCloud request — full golden snapshot (path + body)', () => {
  function imageSpec(params: Record<string, unknown>): WorkflowSpec {
    return {
      modelId: 'seedream-4-5',
      providerModelId: 'doubao-seedream-4.5',
      providerEndpoint: '/api/v3/images/generations',
      kind: 'image',
      prompt: 'a cat',
      params,
      referenceAssets: [],
      maxDurationSeconds: null,
    };
  }

  it('image — single', () => {
    expect(buildAtlasRequest(imageSpec({ size: '1:1', n: 1 }))).toMatchInlineSnapshot(`
      {
        "body": {
          "model": "bytedance/seedream-v4.5",
          "prompt": "a cat",
          "size": "2048*2048",
        },
        "path": "/model/generateImage",
      }
    `);
  });

  it('image — batch n>1', () => {
    expect(buildAtlasRequest(imageSpec({ size: '16:9', n: 3 }))).toMatchInlineSnapshot(`
      {
        "body": {
          "max_images": 3,
          "model": "bytedance/seedream-v4.5/sequential",
          "prompt": "a cat",
          "size": "2848*1600",
        },
        "path": "/model/generateImage",
      }
    `);
  });

  it('video — text-to-video (ratio rename, clamped duration)', () => {
    expect(
      buildAtlasRequest(
        videoSpec('seedance-2.0-text-to-video', {
          duration_seconds: 8,
          resolution: '1080p',
          aspect_ratio: '9:16',
          generate_audio: true,
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "duration": 8,
          "generate_audio": true,
          "model": "bytedance/seedance-2.0/text-to-video",
          "prompt": "a whale breaching at dawn",
          "ratio": "9:16",
          "resolution": "1080p",
        },
        "path": "/model/generateVideo",
      }
    `);
  });

  it('video — reference-to-video (reference_images/videos/audios split)', () => {
    expect(
      buildAtlasRequest(
        videoSpec('seedance-2.0-reference-to-video', {
          duration_seconds: 6,
          imageUrls: ['https://x/i.png'],
          videoUrls: ['https://x/v.mp4'],
          audioUrls: ['https://x/a.mp3'],
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "duration": 6,
          "generate_audio": true,
          "model": "bytedance/seedance-2.0/reference-to-video",
          "prompt": "a whale breaching at dawn",
          "ratio": "16:9",
          "reference_audios": [
            "https://x/a.mp3",
          ],
          "reference_images": [
            "https://x/i.png",
          ],
          "reference_videos": [
            "https://x/v.mp4",
          ],
          "resolution": "720p",
        },
        "path": "/model/generateVideo",
      }
    `);
  });
});
