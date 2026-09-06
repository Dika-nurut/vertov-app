import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { watermarkImage, watermarkVideo } from './watermark';

function ffprobeDims(path: string): { width: number; height: number } {
  const r = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      path,
    ],
    { encoding: 'utf8' },
  );
  const [width, height] = r.stdout.trim().split(',').map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

describe('watermark (free-tier branding)', () => {
  it('image: keeps format + dimensions, changes the bytes', async () => {
    const src = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const out = await watermarkImage(src);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(240);
    expect(meta.format).toBe('png');
    expect(out.equals(src)).toBe(false);
  });

  it('video: overlays the mark and preserves the frame geometry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'seed-wm-test-'));
    try {
      const src = join(dir, 'src.mp4');
      const gen = spawnSync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1:size=320x240:rate=8',
        '-pix_fmt',
        'yuv420p',
        src,
      ]);
      expect(gen.status).toBe(0);
      const bytes = await readFile(src);
      const out = await watermarkVideo(bytes, 'mp4');
      expect(out.length).toBeGreaterThan(0);
      expect(out.equals(bytes)).toBe(false);
      const outPath = join(dir, 'out.mp4');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(outPath, out);
      expect(ffprobeDims(outPath)).toEqual({ width: 320, height: 240 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
