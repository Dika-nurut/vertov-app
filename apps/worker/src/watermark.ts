import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MARK_RECTS } from '@seed/shared/pixel-mark';

/**
 * Free-tier output branding (owner 2026-07-25): jobs by users without the
 * paid-media-storage entitlement (hasPaidMediaStorage === false — tier 'free'
 * and no active subscription) get every asset stamped before upload, so the
 * stored bytes — and every surface that serves them (gallery, showcase, user
 * downloads) — carry the mark. One enforcement point, no leak-around paths.
 *
 * The mark is the brand lockup: the SPEC 11-04 pixel-star plate (geometry
 * from @seed/shared/pixel-mark — scaled, never redrawn) + the wordmark text,
 * tucked into the bottom-right corner and sized relative to the frame. Video
 * is re-encoded (libx264 crf 18) with the lockup PNG scaled to 18% of the
 * frame width via scale2ref; images are a sharp composite that keeps the
 * source format and dimensions.
 */

const MARK_TEXT = 'vertov.space';
const FFMPEG_TIMEOUT_MS = 180_000;

interface Lockup {
  svg: Buffer;
  width: number;
  height: number;
}

/** Pixel-star plate + wordmark as one tight horizontal lockup. */
function lockupSvg(fontSize: number): Lockup {
  const markPx = Math.round(fontSize * 1.5);
  const gap = Math.round(fontSize * 0.5);
  const textW = Math.round(fontSize * 0.62 * MARK_TEXT.length);
  const height = markPx;
  const width = markPx + gap + textW;
  const textY = Math.round(markPx / 2 + fontSize * 0.38);
  const rects = MARK_RECTS.map(
    (r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.fill}"/>`,
  ).join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<g opacity="0.85">` +
    `<svg x="0" y="0" width="${markPx}" height="${markPx}" viewBox="0 0 12 12" ` +
    `shape-rendering="crispEdges">${rects}</svg>` +
    `<text x="${markPx + gap}" y="${textY}" font-family="DejaVu Sans" ` +
    `font-size="${fontSize}" font-weight="bold" textLength="${textW}" ` +
    `lengthAdjust="spacingAndGlyphs" fill="#ffffff" fill-opacity="0.6" ` +
    `stroke="#000000" stroke-opacity="0.35" ` +
    `stroke-width="${Math.max(1, Math.round(fontSize * 0.06))}">${MARK_TEXT}</text>` +
    `</g></svg>`;
  return { svg: Buffer.from(svg), width, height };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg watermark timed out after ${FFMPEG_TIMEOUT_MS}ms`));
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

/** Image still: corner lockup, source format + dimensions preserved. */
export async function watermarkImage(bytes: Buffer): Promise<Buffer> {
  const img = sharp(bytes);
  const meta = await img.metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1024;
  const fontSize = Math.max(14, Math.round(width * 0.028));
  const lockup = lockupSvg(fontSize);
  const pad = Math.round(fontSize * 0.8);
  return img
    .composite([
      {
        input: lockup.svg,
        left: Math.max(0, width - pad - lockup.width),
        top: Math.max(0, height - pad - lockup.height),
      },
    ])
    .toBuffer();
}

/** Video clip: the lockup PNG is scaled to 22% of the frame width (scale2ref),
 * overlaid bottom-right, re-encoded h264/yuv420p with audio copied through. */
export async function watermarkVideo(bytes: Buffer, extension: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-wm-'));
  try {
    const ext = extension || 'mp4';
    const src = join(dir, `src.${ext}`);
    const mark = join(dir, 'mark.png');
    const out = join(dir, `out.${ext}`);
    await writeFile(src, bytes);
    await writeFile(mark, await sharp(lockupSvg(46).svg).png().toBuffer());
    await runFfmpeg([
      '-y',
      '-i',
      src,
      '-i',
      mark,
      '-filter_complex',
      '[1:v][0:v]scale2ref=iw*0.18:-1[wm][main];[main][wm]overlay=W-w-24:H-h-24',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'copy',
      out,
    ]);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One asset, dispatching on the model kind (video vs image/image-edit). */
export async function watermarkAsset(
  bytes: Buffer,
  kind: string,
  extension: string,
): Promise<Buffer> {
  return kind === 'video' ? watermarkVideo(bytes, extension) : watermarkImage(bytes);
}
