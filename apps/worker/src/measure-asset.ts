import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Measure a delivered asset's frame size.
 *
 * Cheap by construction: the bytes are already in memory at this point in the run — the
 * worker holds them to stamp a watermark — so this adds one temp file and one ffprobe,
 * on a path that has just spent tens of seconds waiting on a vendor.
 *
 * FAIL-OPEN, and that direction matters. A measurement is an input to a REFUND decision
 * (finance rev. 20 §2), so a prober that errors must answer "unknown" and let the job
 * settle normally. Answering "small" on a broken probe would hand money back on every
 * job we cannot read.
 *
 * A temp file rather than a pipe: ffprobe needs to seek for most container formats, and a
 * non-seekable stdin silently yields nothing for exactly the inputs we care about.
 */
/**
 * Above this we do not spend the disk. The provider paths accept assets into the hundreds
 * of megabytes, and several concurrent long videos copied to `/tmp` can exhaust the
 * container's temporary storage — which would not merely lose a measurement, it would
 * break the upload and settle work that runs after it. A frame size is not worth that.
 */
export const MAX_PROBE_BYTES = 256 * 1024 * 1024;

export async function measureAssetFrame(
  bytes: Buffer,
  extension: string,
  // Overridable so the cap itself is testable without allocating a quarter of a gigabyte
  // of real, probeable video.
  maxBytes = MAX_PROBE_BYTES,
): Promise<{ width: number; height: number } | null> {
  if (bytes.length > maxBytes) return null;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'seed-measure-'));
    const path = join(dir, `asset.${extension.replace(/[^a-z0-9]/gi, '') || 'bin'}`);
    writeFileSync(path, bytes);
    return await probeFrame(path);
  } catch {
    return null;
  } finally {
    // A throw from `finally` escapes the catch above and would fail an already-PAID job.
    // Cleanup is best-effort by construction: the directory is under the OS temp root.
    try {
      if (dir) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* leave the temp dir to the OS rather than lose a paid generation */
    }
  }
}

/**
 * A probe that never settles is worse than a probe that fails.
 *
 * This runs AFTER the provider has been paid and BEFORE the job settles, so a hung
 * ffprobe does not merely lose a measurement — it holds the job in `running` until the
 * reaper reclaims and refunds it, handing the customer a free generation we already
 * bought. Reading a container header is sub-second work; ten times that is a hang.
 */
const PROBE_TIMEOUT_MS = 10_000;

function probeFrame(path: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { width: number; height: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      path,
    ]);
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk.toString()));
    child.on('error', () => finish(null));
    child.on('close', () => {
      const [width, height] = out.trim().split('x').map(Number);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width! <= 0 || height! <= 0) {
        finish(null);
        return;
      }
      finish({ width: width!, height: height! });
    });
  });
}
