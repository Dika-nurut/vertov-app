import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

const THUMB_MAX_EDGE = 512;
const FFMPEG_TIMEOUT_MS = 30_000;

export interface Thumbnail {
  bytes: Buffer;
  contentType: string;
  extension: string;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg thumbnail timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

async function imageThumbnail(bytes: Buffer): Promise<Thumbnail> {
  const out = await sharp(bytes)
    .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  return { bytes: out, contentType: 'image/webp', extension: 'webp' };
}

/** Grab a poster frame at `atSec` (default ~0.5s, skipping black/blank first
 * frames), downscale, webp. S7: the editor passes a chosen cover time. */
async function videoThumbnail(bytes: Buffer, extension: string, atSec = 0.5): Promise<Thumbnail> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-thumb-'));
  try {
    const src = join(dir, `src.${extension || 'mp4'}`);
    const frame = join(dir, 'frame.png');
    await writeFile(src, bytes);
    try {
      await runFfmpeg([
        '-y',
        '-ss',
        String(Math.max(0, atSec)),
        '-i',
        src,
        '-frames:v',
        '1',
        frame,
      ]);
    } catch {
      // clips shorter than 0.5s: fall back to the very first frame
      await runFfmpeg(['-y', '-i', src, '-frames:v', '1', frame]);
    }
    return await imageThumbnail(await readFile(frame));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extract the final frame of a video at full resolution (jpg). Used to
 * synthesize `return_last_frame` for gateways that don't support it
 * (OpenRouter) so «Продолжить» works uniformly. Returns null on failure —
 * a missing frame must never fail a paid generation.
 */
export async function extractLastFrame(
  bytes: Buffer,
  extension: string,
): Promise<Thumbnail | null> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-lastframe-'));
  try {
    const src = join(dir, `src.${extension || 'mp4'}`);
    const frame = join(dir, 'last.jpg');
    await writeFile(src, bytes);
    try {
      // Seek to 0.25s before EOF and take the next frame ≈ the last frame.
      await runFfmpeg(['-y', '-sseof', '-0.25', '-i', src, '-frames:v', '1', '-q:v', '2', frame]);
    } catch {
      // Some containers reject -sseof; decode-and-keep-last instead.
      await runFfmpeg(['-y', '-i', src, '-vf', 'select=1', '-vsync', 'vfr', '-update', '1', frame]);
    }
    return { bytes: await readFile(frame), contentType: 'image/jpeg', extension: 'jpg' };
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Best-effort thumbnail for a generated asset. Returns null instead of
 * throwing — a missing thumbnail must never fail a paid generation.
 */
export async function makeThumbnail(input: {
  bytes: Buffer;
  kind: 'image' | 'video';
  extension: string;
  /** S7: cover-frame time for video thumbnails (default ~0.5s). */
  atSec?: number;
}): Promise<Thumbnail | null> {
  try {
    return input.kind === 'video'
      ? await videoThumbnail(input.bytes, input.extension, input.atSec)
      : await imageThumbnail(input.bytes);
  } catch {
    return null;
  }
}
