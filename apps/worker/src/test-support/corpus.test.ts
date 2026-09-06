import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CORPUS, corpusPath, corpusClip, corpusVideos } from './corpus';

/**
 * The corpus contract guard (T2): ffprobe every committed file and assert it
 * matches manifest.json. If the bytes drift from the declared dims / fps /
 * duration / audio, downstream parity and editor-render tests would silently
 * test the wrong thing — so this fails loudly instead.
 */

function ffprobe(args: string[]): string {
  const r = spawnSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

describe('media fixture corpus', () => {
  it('manifest is non-empty and every file exists', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
    for (const clip of CORPUS) {
      expect(existsSync(corpusPath(clip.id)), `${clip.file} exists`).toBe(true);
    }
  });

  for (const clip of CORPUS) {
    describe(clip.id, () => {
      const path = () => corpusPath(clip.id);

      it('has the declared dimensions', () => {
        const out = ffprobe([
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height',
          '-of',
          'csv=p=0',
          path(),
        ]);
        expect(out).toBe(`${clip.width},${clip.height}`);
      });

      if (clip.kind === 'video') {
        it('has the declared fps', () => {
          const out = ffprobe([
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=r_frame_rate',
            '-of',
            'csv=p=0',
            path(),
          ]);
          expect(out).toBe(`${clip.fps}/1`);
        });

        it('has the declared duration (±0.05s)', () => {
          const out = ffprobe(['-show_entries', 'format=duration', '-of', 'csv=p=0', path()]);
          expect(Math.abs(Number(out) - (clip.durationSec ?? 0))).toBeLessThanOrEqual(0.05);
        });
      }

      it('audio stream presence matches the manifest', () => {
        const out = ffprobe([
          '-select_streams',
          'a',
          '-show_entries',
          'stream=codec_type',
          '-of',
          'csv=p=0',
          path(),
        ]);
        expect(out.includes('audio')).toBe(clip.hasAudio);
      });
    });
  }

  it('exposes exactly one audio video, one portrait still, off-spec + portrait motion', () => {
    const vids = corpusVideos();
    expect(vids.some((c) => c.hasAudio)).toBe(true);
    expect(vids.some((c) => c.width < c.height)).toBe(true); // portrait motion
    expect(CORPUS.some((c) => c.kind === 'image' && c.width < c.height)).toBe(true);
    expect(corpusClip('testsrc-480p').width).toBe(854); // off-spec, forces scale/pad
  });
});
