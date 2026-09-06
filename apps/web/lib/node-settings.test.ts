import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  buildJobParams,
  imageAspectsFor,
  imageQualitiesFor,
  defaultModelForMode,
  modelsForMode,
  nodeEstimateRequest,
  resolveImageSettings,
  resolveModel,
  resolveVideoSettings,
  unlockedModelsForMode,
  videoAspectsFor,
  videoResolutionsFor,
  videoDurationsFor,
  type ModelLike,
  type NodeSettings,
} from './node-settings';

const mk = (
  id: string,
  kind: ModelLike['kind'],
  minUnitCredits: number,
  maxDurationSeconds: number | null,
  tierMin: ModelLike['tierMin'] = 'free',
): ModelLike => ({
  id,
  family: id.split('-')[0]!,
  variant: id,
  kind,
  minUnitCredits,
  maxDurationSeconds,
  tierMin,
  capabilities:
    kind === 'video'
      ? {
          audio: true,
          frames: ['first', 'last'],
          durations: Array.from(
            { length: Math.max(1, (maxDurationSeconds ?? 15) - 3) },
            (_, index) => index + 4,
          ),
          resolutions: ['480p', '720p', '1080p'],
          aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        }
      : {
          reference: true,
          maxRefs: 14,
          resolutions: ['1K', '2K', '4K'],
          aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
        },
});

const M = {
  seedance: mk('seedance-2-0-fast', 'video', 180, 15, 'start'),
  seedancePro: mk('seedance-1-0-pro-fast', 'video', 60, 15, 'start'),
  seedance2: mk('seedance-2-0', 'video', 320, 15, 'creator'),
  seedream: mk('seedream-4-5', 'image', 15, null, 'free'),
  seedreamEdit: mk('seedream-edit', 'image-edit', 18, null, 'free'),
} satisfies Record<string, ModelLike>;
const ALL: ModelLike[] = Object.values(M);

describe('resolveVideoSettings', () => {
  it('fills missing fields with the legacy hardcoded defaults', () => {
    expect(resolveVideoSettings(undefined)).toEqual({
      durationSeconds: DEFAULTS.durationSeconds,
      videoResolution: DEFAULTS.videoResolution,
      videoAspect: DEFAULTS.videoAspect,
      generateAudio: DEFAULTS.generateAudio,
    });
  });

  it('honours user-set values', () => {
    const s: NodeSettings = {
      durationSeconds: 8,
      videoResolution: '1080p',
      videoAspect: '16:9',
      generateAudio: false,
    };
    expect(resolveVideoSettings(s)).toEqual({
      durationSeconds: 8,
      videoResolution: '1080p',
      videoAspect: '16:9',
      generateAudio: false,
    });
  });

  it('clamps duration to 4..15 and rounds', () => {
    expect(resolveVideoSettings({ durationSeconds: 2 }).durationSeconds).toBe(4);
    expect(resolveVideoSettings({ durationSeconds: 99 }).durationSeconds).toBe(15);
    expect(resolveVideoSettings({ durationSeconds: 6.7 }).durationSeconds).toBe(7);
  });

  it('rejects out-of-enum resolution / aspect and falls back', () => {
    const s = { videoResolution: '4320p', videoAspect: 'square' } as unknown as NodeSettings;
    const r = resolveVideoSettings(s);
    expect(r.videoResolution).toBe(DEFAULTS.videoResolution);
    expect(r.videoAspect).toBe(DEFAULTS.videoAspect);
  });

  it('preserves generateAudio:false (not coerced to the default true)', () => {
    expect(resolveVideoSettings({ generateAudio: false }).generateAudio).toBe(false);
  });

  it('treats an explicit empty option space as model-managed controls', () => {
    const fixed: ModelLike = {
      ...M.seedance,
      id: 'model-managed-video',
      capabilities: {
        audio: true,
        audioControl: false,
        frames: ['first'],
        durations: [4, 6, 8, 10],
        resolutions: [],
        aspect_ratios: [],
      },
    };
    expect(videoAspectsFor(fixed)).toEqual([]);
    expect(videoResolutionsFor(fixed)).toEqual([]);
    expect(resolveVideoSettings(undefined, fixed).generateAudio).toBe(false);
    expect(
      buildJobParams({ mode: 'video', settings: undefined, images: [], model: fixed }),
    ).toEqual({
      duration_seconds: 4,
      return_last_frame: true,
    });
  });
});

describe('resolveImageSettings', () => {
  it('defaults to 1:1 / 2K for an unconfigured node', () => {
    expect(resolveImageSettings(undefined)).toEqual({ imageAspect: '1:1', imageQuality: '2K' });
  });
  it('honours user values and rejects garbage', () => {
    expect(resolveImageSettings({ imageAspect: '9:16', imageQuality: '4K' })).toEqual({
      imageAspect: '9:16',
      imageQuality: '4K',
    });
    const bad = { imageAspect: '7:3', imageQuality: '8K' } as unknown as NodeSettings;
    expect(resolveImageSettings(bad)).toEqual({ imageAspect: '1:1', imageQuality: '2K' });
  });

  it('uses the selected model option space and exposes fixed controls as empty', () => {
    const fixed: ModelLike = {
      ...M.seedream,
      id: 'fixed-image',
      capabilities: { maxRefs: 0, resolutions: [], aspect_ratios: [] },
    };
    expect(imageAspectsFor(fixed)).toEqual([]);
    expect(imageQualitiesFor(fixed)).toEqual([]);
    expect(
      resolveImageSettings(
        { imageAspect: '9:16', imageQuality: '4K' },
        {
          ...M.seedream,
          capabilities: { maxRefs: 1, resolutions: ['1K'], aspect_ratios: ['1:1'] },
        },
      ),
    ).toEqual({ imageAspect: '1:1', imageQuality: '1K' });
    expect(
      buildJobParams({ mode: 'image', settings: undefined, images: [], model: fixed }),
    ).toEqual({
      n: 1,
    });
  });
});

describe('buildJobParams', () => {
  it('video defaults use a vendor-safe aspect ratio', () => {
    expect(buildJobParams({ mode: 'video', settings: undefined, images: [] })).toEqual({
      duration_seconds: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: true,
      return_last_frame: true,
    });
  });

  it('image defaults reproduce the legacy hardcoded body', () => {
    expect(buildJobParams({ mode: 'image', settings: undefined, images: [], count: 1 })).toEqual({
      aspect_ratio: '1:1',
      resolution: '2K',
      n: 1,
    });
  });

  it('threads user settings into the video body', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: {
        durationSeconds: 12,
        videoResolution: '1080p',
        videoAspect: '21:9',
        generateAudio: false,
      },
      images: ['a', 'b', 'c'],
    });
    expect(params).toEqual({
      duration_seconds: 12,
      resolution: '1080p',
      aspect_ratio: '21:9',
      generate_audio: false,
      return_last_frame: true,
      imageUrls: ['a', 'b'], // video caps refs at 2 (first/last frame)
    });
  });

  it('does not truncate generic references to the frame-slot count on a mixed model', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: undefined,
      images: ['reference-1', 'reference-2'],
      model: {
        ...M.seedance,
        id: 'mixed-video',
        capabilities: { reference: true, frames: ['first'], maxRefs: 9 },
      },
    });
    expect(params['imageUrls']).toEqual(['reference-1', 'reference-2']);
    expect(params['frameImages']).toBeUndefined();
  });

  it('threads user settings into the image body and caps refs at 14', () => {
    const images = Array.from({ length: 20 }, (_, i) => `u${i}`);
    const params = buildJobParams({
      mode: 'image',
      settings: { imageAspect: '3:4', imageQuality: '4K' },
      images,
      count: 3,
    });
    expect(params['aspect_ratio']).toBe('3:4');
    expect(params['resolution']).toBe('4K');
    expect(params['n']).toBe(3);
    expect((params['imageUrls'] as string[]).length).toBe(14);
  });

  it('omits imageUrls when there are no inputs', () => {
    expect('imageUrls' in buildJobParams({ mode: 'video', settings: {}, images: [] })).toBe(false);
    expect(
      'imageUrls' in buildJobParams({ mode: 'image', settings: {}, images: [], count: 2 }),
    ).toBe(false);
  });

  it('reference mode lifts the still cap to 9 and adds video/audio ref arrays', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: undefined,
      reference: true,
      images: Array.from({ length: 12 }, (_, i) => `i${i}`),
      videos: ['v0', 'v1', 'v2', 'v3'],
      audios: ['a0'],
    });
    expect((params['imageUrls'] as string[]).length).toBe(9);
    expect(params['videoUrls']).toEqual(['v0', 'v1', 'v2']);
    expect(params['audioUrls']).toEqual(['a0']);
    expect(params['duration_seconds']).toBe(5); // clip settings still apply
  });

  it('reference mode omits empty ref arrays (params stay minimal)', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: {},
      reference: true,
      images: ['cast.jpg'],
    });
    expect(params['imageUrls']).toEqual(['cast.jpg']);
    expect('videoUrls' in params).toBe(false);
    expect('audioUrls' in params).toBe(false);
  });

  it('preserves a selected catalog row that withdraws video references', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: {},
      reference: true,
      model: {
        ...M.seedance,
        id: 'seedance-2-0-reference-to-video',
        capabilities: { reference: true, maxRefs: 9, maxVideoRefs: 0, maxAudioRefs: 3 },
      },
      images: ['cast.jpg'],
      videos: ['unpriced-input.mp4'],
      audios: ['voice.mp3'],
    });
    expect(params['imageUrls']).toEqual(['cast.jpg']);
    expect('videoUrls' in params).toBe(false);
    expect(params['audioUrls']).toEqual(['voice.mp3']);
  });

  it('non-reference video ignores videos/audios and keeps the 2-frame cap', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: {},
      images: ['a', 'b', 'c'],
      videos: ['v0'],
      audios: ['a0'],
    });
    expect(params['imageUrls']).toEqual(['a', 'b']);
    expect('videoUrls' in params).toBe(false);
    expect('audioUrls' in params).toBe(false);
  });
});

describe('nodeEstimateRequest', () => {
  it('includes reference images in the same compiled params as a board submit', () => {
    const estimate = nodeEstimateRequest({
      mode: 'image',
      model: M.seedream,
      settings: { modelId: M.seedream.id },
      imageUrls: ['first.png', 'second.png'],
      count: 1,
    });

    expect(estimate?.params).toMatchObject({
      imageUrls: ['first.png', 'second.png'],
      n: 1,
    });
  });

  it('keeps typed frame inputs in frameImages for a board estimate', () => {
    const estimate = nodeEstimateRequest({
      mode: 'video',
      model: M.seedance,
      settings: { modelId: M.seedance.id },
      imageUrls: ['first.png'],
    });

    expect(estimate?.params['frameImages']).toEqual([{ role: 'first', url: 'first.png' }]);
    expect(estimate?.params['imageUrls']).toBeUndefined();
  });
});

describe('modelsForMode', () => {
  it('video mode lists only video models, cheapest-first', () => {
    expect(modelsForMode(ALL, 'video').map((m) => m.id)).toEqual([
      'seedance-1-0-pro-fast',
      'seedance-2-0-fast',
      'seedance-2-0',
    ]);
  });
  it('image mode drops the deprioritised image-edit kind (owner 2026-07-25)', () => {
    expect(modelsForMode(ALL, 'image').map((m) => m.id)).toEqual(['seedream-4-5']);
  });
  it('keeps out-of-plan models visible — the picker renders them locked, not hidden', () => {
    expect(modelsForMode(ALL, 'video').map((m) => m.id)).toContain('seedance-2-0');
  });
});

describe('resolveModel', () => {
  it('uses the persisted modelId when it is eligible', () => {
    expect(resolveModel(ALL, 'video', 'seedance-2-0', M.seedance)?.id).toBe('seedance-2-0');
  });
  it('ignores a modelId from the wrong mode and falls back', () => {
    expect(resolveModel(ALL, 'video', 'seedream-4-5', M.seedance)?.id).toBe('seedance-2-0-fast');
  });
  it('ignores an unknown modelId and falls back', () => {
    expect(resolveModel(ALL, 'image', 'ghost-model', M.seedream)?.id).toBe('seedream-4-5');
  });
  it('uses the first eligible model when no id and no valid fallback', () => {
    expect(resolveModel(ALL, 'video', undefined, undefined)?.id).toBe('seedance-1-0-pro-fast');
  });
  it('never returns an incomplete fallback that Boards hides', () => {
    const incomplete = { ...M.seedance, id: 'incomplete', capabilities: { audio: true } };
    expect(resolveModel(ALL, 'video', undefined, incomplete)?.id).toBe('seedance-1-0-pro-fast');
  });
});

describe('capability-driven board settings (S4)', () => {
  const veo: ModelLike = {
    id: 'veo-3-1-fast',
    family: 'Veo',
    variant: '3.1 Fast',
    kind: 'video',
    minUnitCredits: 90,
    maxDurationSeconds: 8,
    capabilities: {
      audio: true,
      frames: ['first', 'last'],
      durations: [4, 6, 8],
      resolutions: ['720p', '1080p'],
      aspect_ratios: ['16:9', '9:16'],
    },
  };
  const sora: ModelLike = {
    id: 'sora-2-pro',
    family: 'Sora',
    variant: '2 Pro',
    kind: 'video',
    minUnitCredits: 200,
    maxDurationSeconds: 20,
    capabilities: {
      audio: true,
      frames: [],
      durations: [4, 8, 12, 16, 20],
      resolutions: ['720p', '1080p'],
    },
  };

  it('Veo: option lists come from capabilities (2 ratios, [4,6,8], 720p/1080p)', () => {
    expect(videoAspectsFor(veo)).toEqual(['16:9', '9:16']);
    expect(videoResolutionsFor(veo)).toEqual(['720p', '1080p']);
    expect(videoDurationsFor(veo)).toEqual([4, 6, 8]);
  });

  it('Seedance exposes the explicit catalog option lists', () => {
    expect(videoDurationsFor(M.seedance)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(videoResolutionsFor(M.seedance)).toEqual(['480p', '720p', '1080p']);
  });

  it('resolveVideoSettings snaps the saved duration to a supported Veo value', () => {
    // A board saved 15s on a model that now caps at 8 with discrete [4,6,8].
    expect(resolveVideoSettings({ durationSeconds: 15 }, veo).durationSeconds).toBe(8);
    expect(resolveVideoSettings({ durationSeconds: 7 }, veo).durationSeconds).toBe(6);
  });

  it('resolveVideoSettings drops an unsupported saved aspect to the model default', () => {
    // 21:9 isn't in Veo's set → falls back to its first declared vendor ratio.
    expect(resolveVideoSettings({ videoAspect: '21:9' }, veo).videoAspect).toBe('16:9');
  });

  it('Sora (t2v-only) takes no frame images even when refs are attached', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: { durationSeconds: 20 },
      images: ['first.jpg', 'last.jpg'],
      model: sora,
    });
    expect('imageUrls' in params).toBe(false);
    expect(params['duration_seconds']).toBe(20);
  });

  it('Veo keeps the first+last 2-frame cap', () => {
    const params = buildJobParams({
      mode: 'video',
      settings: {},
      images: ['a', 'b', 'c'],
      model: veo,
    });
    expect(params['imageUrls']).toEqual(['a', 'b']);
  });
});

/* Plan entitlement on /boards (P-B2 / DEC-3). /generate has always locked
 * out-of-plan models with an upsell; the board picker used to offer everything
 * and let the user hit a 403 at submit. These pin the two rules that keep the
 * board honest: an out-of-plan model is never DEFAULTED to, and a saved pick is
 * never silently rewritten. */
describe('plan-tier gating on boards', () => {
  it('unlockedModelsForMode hides what the plan cannot run', () => {
    expect(unlockedModelsForMode(ALL, 'video', 'start').map((m) => m.id)).toEqual([
      'seedance-1-0-pro-fast',
      'seedance-2-0-fast',
    ]);
    expect(unlockedModelsForMode(ALL, 'video', 'creator').map((m) => m.id)).toEqual([
      'seedance-1-0-pro-fast',
      'seedance-2-0-fast',
      'seedance-2-0',
    ]);
  });

  it('a free user has no video model they can run', () => {
    expect(unlockedModelsForMode(ALL, 'video', null)).toEqual([]);
  });

  it('defaultModelForMode keeps the preferred model when the plan allows it', () => {
    expect(defaultModelForMode(ALL, 'video', 'seedance-2-0-fast', 'start')?.id).toBe(
      'seedance-2-0-fast',
    );
  });

  it('defaultModelForMode drops an out-of-plan preference to the cheapest in-plan model', () => {
    // seedance-2-0 is creator-only; a Старт board must not default onto it.
    expect(defaultModelForMode(ALL, 'video', 'seedance-2-0', 'start')?.id).toBe(
      'seedance-1-0-pro-fast',
    );
  });

  it('defaultModelForMode falls back to the lowest-tier cheapest when nothing is in plan', () => {
    // Free + video: every row is locked, so the board shows the cheapest
    // lowest-tier one LOCKED with an upsell — same as /generate does.
    expect(defaultModelForMode(ALL, 'video', 'seedance-2-0-fast', 'free')?.id).toBe(
      'seedance-1-0-pro-fast',
    );
  });

  it('defaultModelForMode ignores tier when the whole mode is free', () => {
    expect(defaultModelForMode(ALL, 'image', 'seedream-4-5', 'free')?.id).toBe('seedream-4-5');
  });

  it('resolveModel keeps a saved out-of-plan pick — a downgrade must not rewrite the board', () => {
    const startDefault = defaultModelForMode(ALL, 'video', 'seedance-2-0-fast', 'start');
    expect(resolveModel(ALL, 'video', 'seedance-2-0', startDefault)?.id).toBe('seedance-2-0');
  });
});
