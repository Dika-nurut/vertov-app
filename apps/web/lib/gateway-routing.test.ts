import { describe, expect, it } from 'vitest';
import {
  isReferenceModel,
  providerForShot,
  resolveProvider,
  willDropVideoRefs,
  REFERENCE_CAPS,
} from './gateway-routing';

describe('providerForShot (previz S1 gateway selection)', () => {
  it('image-only shots stay on the default gateway', () => {
    expect(providerForShot({})).toBeUndefined();
    expect(providerForShot({ videoUrls: [], audioUrls: [] })).toBeUndefined();
  });

  it('a video reference forces atlascloud (OpenRouter has no field for it)', () => {
    expect(providerForShot({ videoUrls: ['http://a/loc-motion.mp4'] })).toBe('atlascloud');
  });

  it('an audio reference forces atlascloud too', () => {
    expect(providerForShot({ audioUrls: ['http://a/voice.mp3'] })).toBe('atlascloud');
  });

  it('empty strings do not count as references', () => {
    expect(providerForShot({ videoUrls: [''], audioUrls: [''] })).toBeUndefined();
  });
});

describe('isReferenceModel', () => {
  it('matches the catalog reference-to-video rows', () => {
    expect(isReferenceModel('seedance-2-0-reference-to-video')).toBe(true);
    expect(isReferenceModel('seedance-2-0-fast-reference-to-video')).toBe(true);
  });
  it('rejects plain video/image models and undefined', () => {
    expect(isReferenceModel('seedance-2-0')).toBe(false);
    expect(isReferenceModel('seedream-4-5')).toBe(false);
    expect(isReferenceModel(undefined)).toBe(false);
  });
});

describe('REFERENCE_CAPS', () => {
  it('matches the seedance reference-to-video wire caps (9/3/3)', () => {
    expect(REFERENCE_CAPS).toEqual({ images: 9, videos: 3, audios: 3 });
  });
});

describe('resolveProvider (operator gateway policy widget)', () => {
  const video = { videoUrls: ['http://a/m.mp4'] };
  const plain = { videoUrls: [], audioUrls: [] };

  it('auto: video/audio ref → atlascloud, else → openrouter (cheapest)', () => {
    expect(resolveProvider('auto', plain)).toBe('openrouter');
    expect(resolveProvider('auto', video)).toBe('atlascloud');
    expect(resolveProvider('auto', { audioUrls: ['http://a/v.mp3'] })).toBe('atlascloud');
  });

  it('force modes override the refs entirely (always explicit)', () => {
    expect(resolveProvider('openrouter', video)).toBe('openrouter');
    expect(resolveProvider('atlascloud', plain)).toBe('atlascloud');
  });
});

describe('willDropVideoRefs', () => {
  it('warns only for force-openrouter + video/audio refs', () => {
    expect(willDropVideoRefs('openrouter', { videoUrls: ['http://a/m.mp4'] })).toBe(true);
    expect(willDropVideoRefs('openrouter', {})).toBe(false);
    expect(willDropVideoRefs('auto', { videoUrls: ['http://a/m.mp4'] })).toBe(false);
    expect(willDropVideoRefs('atlascloud', { videoUrls: ['http://a/m.mp4'] })).toBe(false);
  });
});
