import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import type { StudioRenderSpec } from '@seed/db';
import { db, pool, studioRenders } from '@seed/db';
import { runStudioRender } from './studio-render';
import { cleanupIntegrationData, seedStudioRender, seedUser } from './test-support/seed';

/**
 * Adversarial media compatibility gate. These fixtures are generated locally
 * with ffmpeg so the test is deterministic, license-free, and never calls a
 * paid provider. It covers container/codec/timestamp/audio/rotation/path edges
 * that the tiny committed happy-path corpus deliberately does not.
 */
const log = pino({ level: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'studio-media-compat-'));
let userId: string;

function ffmpeg(output: string, args: string[]): void {
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, output], {
    encoding: 'utf8',
    timeout: 45_000,
  });
  if (result.status !== 0) throw new Error(`fixture generation failed: ${result.stderr}`);
}

function spec(url: string): StudioRenderSpec {
  return {
    clips: [{ url }],
    width: 320,
    height: 180,
    fps: 24,
  };
}

async function run(url: string) {
  const id = await seedStudioRender(userId, spec(url));
  const outcome = await runStudioRender({ renderId: id, log });
  const row = (await db.select().from(studioRenders).where(eq(studioRenders.id, id)).limit(1))[0]!;
  return { outcome, row };
}

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser();
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe('Studio adversarial media compatibility (zero spend)', () => {
  it.each([
    {
      name: 'video without an audio stream',
      file: 'silent.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=321x241:rate=24',
        '-t',
        '0.6',
        '-pix_fmt',
        'yuv420p',
      ],
    },
    {
      name: 'portrait source carrying rotation metadata',
      file: 'rotated.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=240x320:rate=24',
        '-t',
        '0.6',
        '-metadata:s:v:0',
        'rotate=90',
        '-pix_fmt',
        'yuv420p',
      ],
    },
    {
      name: 'WebM VP9 with Opus audio',
      file: 'vp9-opus.webm',
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '0.6',
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-c:a',
        'libopus',
      ],
    },
    {
      name: 'variable-frame-rate MP4',
      file: 'vfr.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30',
        '-t',
        '1',
        '-vf',
        "select='not(mod(n,3))'",
        '-fps_mode',
        'vfr',
        '-pix_fmt',
        'yuv420p',
      ],
    },
    {
      name: 'Unicode and whitespace in the source path',
      file: 'клип с пробелом.mp4',
      args: [
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24',
        '-t',
        '0.6',
        '-pix_fmt',
        'yuv420p',
      ],
    },
  ])('normalizes $name', async ({ file, args }) => {
    const path = join(dir, file);
    ffmpeg(path, args);
    const { outcome, row } = await run(path);
    expect(outcome, row.errorMessage ?? 'render failed').toBe('succeeded');
    expect(row.status).toBe('succeeded');
    expect(row.resultUrl).toBeTruthy();
  });

  it('fails malformed/truncated media cleanly without publishing output', async () => {
    const path = join(dir, 'truncated.mp4');
    writeFileSync(path, Buffer.from('not an mp4'));
    const { outcome, row } = await run(path);
    expect(outcome).toBe('failed');
    expect(row.status).toBe('failed');
    expect(row.resultUrl).toBeNull();
    expect(row.errorMessage).toBeTruthy();
  });
});
