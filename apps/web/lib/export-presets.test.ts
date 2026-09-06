import { describe, expect, it } from 'vitest';
import { EXPORT_PRESETS, presetById, presetDimensions } from './export-presets';

const RENDER_MAX = 3840;

describe('EXPORT_PRESETS', () => {
  it('covers the social + review targets', () => {
    const ids = EXPORT_PRESETS.map((p) => p.id);
    for (const id of ['tiktok', 'reels', 'shorts', 'youtube', 'storyboard']) {
      expect(ids).toContain(id);
    }
  });

  it('every preset stays within the render schema bounds', () => {
    for (const p of EXPORT_PRESETS) {
      expect(p.width).toBeGreaterThanOrEqual(64);
      expect(p.width).toBeLessThanOrEqual(RENDER_MAX);
      expect(p.height).toBeGreaterThanOrEqual(64);
      expect(p.height).toBeLessThanOrEqual(RENDER_MAX);
      expect(p.fps).toBeGreaterThanOrEqual(1);
      expect(p.fps).toBeLessThanOrEqual(60);
      expect(['mp4', 'mov']).toContain(p.format);
    }
  });

  it('dimensions match the declared aspect', () => {
    const ratio = (a: string) => {
      const [w, h] = a.split(':').map(Number);
      return w! / h!;
    };
    for (const p of EXPORT_PRESETS) {
      expect(p.width / p.height).toBeCloseTo(ratio(p.aspect), 2);
    }
  });

  it('vertical presets are portrait, YouTube is landscape', () => {
    expect(presetById('tiktok')!.height).toBeGreaterThan(presetById('tiktok')!.width);
    expect(presetById('youtube')!.width).toBeGreaterThan(presetById('youtube')!.height);
  });

  it('presetById returns undefined for an unknown id', () => {
    expect(presetById('nope')).toBeUndefined();
  });

  it('presetDimensions projects only the render fields', () => {
    expect(presetDimensions(presetById('youtube')!)).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
    });
  });
});
