import { describe, expect, it } from 'vitest';
import {
  acceptsImageRefs,
  acceptsVideoRefs,
  capabilityLabels,
  controlDisabledReason,
  refsDroppedOnSwitch,
  supportsWebSearch,
  videoMode,
  videoDurations,
  videoResolutions,
  imageResolutions,
  videoAspectRatios,
  supportsAudio,
  supportsLastFrame,
  supportsFirstFrame,
  snapDuration,
  videoMediaCaps,
  capabilitySigns,
  supportsAudioControl,
  type ModelCaps,
} from './model-capabilities';

const t2v: ModelCaps = { kind: 'video', capabilities: { mode: 'text' }, maxDurationSeconds: 10 };
const i2v: ModelCaps = { kind: 'video', capabilities: { mode: 'image' } };
const refV: ModelCaps = {
  kind: 'video',
  capabilities: { mode: 'reference', audioRef: true },
  maxDurationSeconds: 5,
};
const img: ModelCaps = { kind: 'image', capabilities: {}, maxResolution: '2K' };
const edit: ModelCaps = { kind: 'image', capabilities: { edit: true } };

describe('capability predicates', () => {
  it('reads the video sub-mode', () => {
    expect(videoMode(t2v)).toBe('text');
    expect(videoMode(img)).toBeUndefined();
  });
  it('image refs: i2v + reference video + edit images; not text-to-video or plain image', () => {
    expect(acceptsImageRefs(i2v)).toBe(true);
    expect(acceptsImageRefs(refV)).toBe(true);
    expect(acceptsImageRefs(edit)).toBe(true);
    expect(acceptsImageRefs(t2v)).toBe(false);
    expect(acceptsImageRefs(img)).toBe(false);
  });
  it('video/audio refs only in reference mode', () => {
    expect(acceptsVideoRefs(refV)).toBe(true);
    expect(acceptsVideoRefs(i2v)).toBe(false);
  });
  it('web search for text-to-video or websearch-flagged models', () => {
    expect(supportsWebSearch(t2v)).toBe(true);
    expect(supportsWebSearch(i2v)).toBe(false);
  });
});

describe('capabilityLabels', () => {
  it('describes a reference-video model', () => {
    const labels = capabilityLabels(refV);
    expect(labels).toContain('Видео по референсам');
    expect(labels).toContain('Видео-референс');
    expect(labels).toContain('Аудио-референс');
    expect(labels).toContain('До 5с');
  });
  it('describes an edit model', () => {
    expect(capabilityLabels(edit)).toContain('Редактирование');
  });
});

describe('refsDroppedOnSwitch — never silently hides a ref', () => {
  it('warns when switching to a model that ignores existing refs', () => {
    // Have image+video refs, switch to text-to-video → both dropped.
    expect(refsDroppedOnSwitch(t2v, { images: 2, videos: 1, audios: 0 })).toEqual([
      'Эта модель не использует реф-изображения.',
      'Эта модель не принимает видео-референсы.',
    ]);
  });
  it('is silent when the target model uses the refs', () => {
    expect(refsDroppedOnSwitch(refV, { images: 2, videos: 1, audios: 1 })).toEqual([]);
  });
  it('only warns about refs that are actually set', () => {
    expect(refsDroppedOnSwitch(t2v, { images: 0, videos: 0, audios: 0 })).toEqual([]);
  });
});

describe('controlDisabledReason', () => {
  it('explains a disabled control and clears when available', () => {
    expect(controlDisabledReason(t2v, 'videoRef')).toMatch(/референс/);
    expect(controlDisabledReason(refV, 'videoRef')).toBeNull();
    expect(controlDisabledReason(img, 'edit')).toMatch(/редактирован/i);
  });
});

describe('capability-driven option space (S4)', () => {
  const veo: ModelCaps = {
    kind: 'video',
    maxDurationSeconds: 8,
    capabilities: {
      audio: true,
      frames: ['first', 'last'],
      durations: [4, 6, 8],
      resolutions: ['720p', '1080p'],
      aspect_ratios: ['16:9', '9:16'],
    },
  };
  const sora: ModelCaps = {
    kind: 'video',
    maxDurationSeconds: 20,
    capabilities: { audio: true, frames: [], durations: [4, 8, 12, 16, 20] },
  };
  // Legacy Seedance row: declares only `audio`, no option lists.
  const seedance: ModelCaps = {
    kind: 'video',
    maxDurationSeconds: 15,
    capabilities: { audio: true },
  };

  it('reads declared option lists; null for models that omit them', () => {
    expect(videoDurations(veo)).toEqual([4, 6, 8]);
    expect(videoResolutions(veo)).toEqual(['720p', '1080p']);
    expect(videoAspectRatios(veo)).toEqual(['16:9', '9:16']);
    // Seedance declares none → callers fall back to the static constants.
    expect(videoDurations(seedance)).toBeNull();
    expect(videoResolutions(seedance)).toBeNull();
    expect(videoAspectRatios(seedance)).toBeNull();
  });

  it('exposes image resolution tiers independently from video tiers', () => {
    const seedream: ModelCaps = {
      kind: 'image',
      capabilities: { resolutions: ['1K', '2K', '4K'] },
    };
    expect(imageResolutions(seedream)).toEqual(['1K', '2K', '4K']);
    expect(imageResolutions(veo)).toBeNull();
    expect(imageResolutions(img)).toBeNull();
  });

  it('audio + frame anchors: Veo first+last, Sora none (t2v-only), Seedance legacy default', () => {
    expect(supportsAudio(veo)).toBe(true);
    expect(supportsAudioControl(veo)).toBe(true);
    expect(
      supportsAudioControl({ kind: 'video', capabilities: { audio: true, audioControl: false } }),
    ).toBe(false);
    expect(supportsFirstFrame(veo)).toBe(true);
    expect(supportsLastFrame(veo)).toBe(true);
    // Sora: explicit empty frames → t2v-only.
    expect(supportsFirstFrame(sora)).toBe(false);
    expect(supportsLastFrame(sora)).toBe(false);
    // Seedance: frames absent → legacy first+last allowed.
    expect(supportsFirstFrame(seedance)).toBe(true);
    expect(supportsLastFrame(seedance)).toBe(true);
  });

  it('snapDuration picks the largest supported ≤ request, else the minimum', () => {
    expect(snapDuration(7, [4, 6, 8])).toBe(6);
    expect(snapDuration(8, [4, 6, 8])).toBe(8);
    expect(snapDuration(3, [4, 6, 8])).toBe(4); // below floor → min
    expect(snapDuration(20, [4, 8, 12, 16, 20])).toBe(20);
  });
});

/**
 * `videoMediaCaps` is the /generate half of a two-surface invariant: it must
 * derive the SAME input shape that `resolveBoardModelContract`
 * (packages/shared/src/board-contract.ts) derives for the board node's ports.
 * If these drift, one model grows two different sets of inputs depending on
 * which screen you opened it from.
 */
describe('videoMediaCaps mirrors the board port derivation', () => {
  it('declared frames win: first+last is a 2-slot keyframe model, no ref capacity', () => {
    expect(
      videoMediaCaps({
        id: 'seedance-2-0',
        kind: 'video',
        capabilities: { frames: ['first', 'last'] },
      }),
    ).toEqual({ role: 'frame', image: 2, video: 0, audio: 0, frames: ['first', 'last'] });
  });

  it('an explicit empty frames array means text-to-video only', () => {
    expect(
      videoMediaCaps({ id: 'sora-2-pro', kind: 'video', capabilities: { frames: [] } }),
    ).toEqual({ role: 'none', image: 0, video: 0, audio: 0, frames: [] });
  });

  it('can hide video references while retaining image references', () => {
    expect(
      videoMediaCaps({
        id: 'seedance-2-0-reference-to-video',
        kind: 'video',
        capabilities: { reference: true, maxRefs: 9, maxVideoRefs: 0, maxAudioRefs: 3 },
      }),
    ).toEqual({ role: 'reference', image: 9, video: 0, audio: 3, frames: [] });
  });

  it('uses the frame channel when a synthetic row declares both channels', () => {
    expect(
      videoMediaCaps({
        id: 'mixed-video',
        kind: 'video',
        capabilities: { reference: true, frames: ['first'] },
      }),
    ).toEqual({ role: 'frame', image: 1, video: 0, audio: 0, frames: ['first'] });
  });

  it('a legacy row with neither keeps the historical first+last behaviour', () => {
    expect(videoMediaCaps({ id: 'seedance-1-0-pro', kind: 'video', capabilities: {} })).toEqual({
      role: 'frame',
      image: 2,
      video: 0,
      audio: 0,
      frames: ['first', 'last'],
    });
  });
});

describe('capabilitySigns describe THIS row, not its twin', () => {
  it('the base row signs its keyframes; the twin signs references', () => {
    expect(
      capabilitySigns({
        id: 'seedance-2-0',
        kind: 'video',
        capabilities: { audio: true, frames: ['first', 'last'] },
      }),
    ).toEqual(['AUDIO', 'FIRST/LAST']);
    expect(
      capabilitySigns({
        id: 'seedance-2-0-reference-to-video',
        kind: 'video',
        capabilities: { audio: true, reference: true, maxRefs: 9 },
      }),
    ).toEqual(['AUDIO', 'REF']);
  });

  it('a first-frame-only engine does not claim a last-frame anchor', () => {
    expect(
      capabilitySigns({ id: 'happyhorse-1-1', kind: 'video', capabilities: { frames: ['first'] } }),
    ).toEqual(['FIRST']);
  });

  it('a text-to-video engine signs nothing', () => {
    expect(
      capabilitySigns({ id: 'grok-imagine-video', kind: 'video', capabilities: { frames: [] } }),
    ).toEqual([]);
  });

  it('image models sign REF from their own reference/edit capability', () => {
    expect(
      capabilitySigns({ id: 'seedream-4-0', kind: 'image', capabilities: { reference: true } }),
    ).toEqual(['REF']);
  });
});
