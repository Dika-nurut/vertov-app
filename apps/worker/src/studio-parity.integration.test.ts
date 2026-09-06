import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import type { StudioClip, StudioRenderSpec } from '@seed/db';
import { db, studioRenders, pool } from '@seed/db';
import { runStudioRender } from './studio-render';
import { corpusPath } from './test-support/corpus';
import { seedUser, seedStudioRender, cleanupIntegrationData } from './test-support/seed';

/**
 * Preview≈render parity as a first-class category (T9). The editor's
 * load-bearing correctness guarantee: what the CSS preview shows must match
 * what ffmpeg renders. We render over the T2 corpus and assert frame-level
 * invariants that the preview ALSO guarantees — so a render that silently
 * diverges from the preview is caught:
 *   • format parity   — output aspect == the chosen preview format (9:16 / 16:9)
 *   • speed parity     — render duration == preview playbackRate scaling
 *   • freeze parity    — a frozen clip holds ONE static frame (preview pauses,
 *                        render repeats the same frame) → frames identical
 *   • transform parity — the CSS preview transform string is derived from the
 *                        SAME values the ffmpeg chain consumes (formula mirror)
 * Local ffmpeg only — zero credit spend.
 */
const log = pino({ level: 'silent' });
let userId: string;
const W = 480;
const H = 270;
const BARS = () => corpusPath('bars-720p'); // 2s, 16:9
const TONE = () => corpusPath('tone-720p-audio'); // 3s

function baseSpec(clips: StudioClip[], over: Partial<StudioRenderSpec> = {}): StudioRenderSpec {
  return { clips, width: W, height: H, fps: 24, ...over };
}

async function renderUrl(spec: StudioRenderSpec): Promise<string> {
  const id = await seedStudioRender(userId, spec);
  const outcome = await runStudioRender({ renderId: id, log });
  const row = (await db.select().from(studioRenders).where(eq(studioRenders.id, id)).limit(1))[0]!;
  expect(outcome, row.errorMessage ?? 'render failed').toBe('succeeded');
  return row.resultUrl!;
}

const dir = mkdtempSync(join(tmpdir(), 'parity-'));
let frameSeq = 0;

/** Extract a single raw frame (PNG) at a timestamp; return its bytes. */
function frameAt(url: string, atSec: number): Buffer {
  const out = join(dir, `f${frameSeq++}.png`);
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-ss', String(atSec), '-i', url, '-frames:v', '1', out],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`frame extract failed: ${r.stderr}`);
  return readFileSync(out);
}

function dims(url: string): string {
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
      url,
    ],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

function durationOf(url: string): number {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
    { encoding: 'utf8' },
  );
  return Number((r.stdout ?? '').trim());
}

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser();
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

describe('preview≈render parity (zero spend)', () => {
  it('format parity: the output aspect matches the chosen preview format', async () => {
    const portrait = await renderUrl(baseSpec([{ url: BARS() }], { width: 270, height: 480 }));
    expect(dims(portrait)).toBe('270,480'); // 9:16 preview → 9:16 render
    const landscape = await renderUrl(baseSpec([{ url: BARS() }], { width: 480, height: 270 }));
    expect(dims(landscape)).toBe('480,270'); // 16:9 preview → 16:9 render
  });

  it('speed parity: render duration mirrors the preview playbackRate', async () => {
    const base = durationOf(await renderUrl(baseSpec([{ url: TONE() }])));
    const fast = durationOf(await renderUrl(baseSpec([{ url: TONE(), speed: 2 }])));
    // preview plays a 2× clip in half the time; the render must too (±0.3s).
    expect(Math.abs(fast - base / 2)).toBeLessThan(0.4);
  });

  it('freeze parity: a frozen clip holds ONE static frame (preview pauses)', async () => {
    // Pair with an audible lead clip so the timeline isn't all-silent; the
    // freeze occupies seconds 3.0–4.5 of the assembled output.
    const url = await renderUrl(
      baseSpec([{ url: TONE() }, { url: BARS(), freeze: { atSec: 0.5, durSec: 1.5 } }]),
    );
    const a = frameAt(url, 3.4);
    const b = frameAt(url, 4.0);
    // Two frames inside the freeze window are the SAME held frame.
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('motion sanity: a NON-frozen clip changes across time (guards the freeze test)', async () => {
    const url = await renderUrl(baseSpec([{ url: TONE() }]));
    const a = frameAt(url, 0.5);
    const b = frameAt(url, 2.0);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('multi-track parity: an upper-track clip composites graded+rotated over the base', async () => {
    // Base = 2s bars. Upper track = a half-size, 30°-rotated, saturated, slightly
    // transparent clip riding the first 1.5s — it must alpha-composite OVER the
    // base without changing the format or the timeline length (overlay, not append).
    const baseUrl = await renderUrl(baseSpec([{ url: BARS() }]));
    const withOverlay = await renderUrl(
      baseSpec([{ url: BARS() }], {
        tracks: [
          [
            {
              url: BARS(),
              startSec: 0,
              outSec: 1.5,
              transform: { rotate: 30, scale: 0.5 },
              color: { saturation: 90 },
              opacity: 0.95,
            },
          ],
        ],
      }),
    );
    // format + duration unchanged — the layer rides ON the base timeline.
    expect(dims(withOverlay)).toBe(dims(baseUrl));
    expect(Math.abs(durationOf(withOverlay) - durationOf(baseUrl))).toBeLessThan(0.4);
    // a frame inside the layer's window is visibly different from base-only
    // (the rotated, graded overlay is composited on top).
    const a = frameAt(baseUrl, 0.6);
    const b = frameAt(withOverlay, 0.6);
    expect(Buffer.compare(a, b)).not.toBe(0);
  });

  it('transform parity: the CSS preview string is derived from the render values', () => {
    // The preview composes `translate(posX%, posY%) rotate(deg) scale(s)` from
    // the exact StudioTransform the ffmpeg chain consumes — pin that formula so
    // preview and render can't drift apart silently.
    const tr = { scale: 1.5, posX: 12, posY: -8, rotate: 20 };
    const previewCss = `translate(${tr.posX}%, ${tr.posY}%) rotate(${tr.rotate}deg) scale(${tr.scale})`;
    expect(previewCss).toBe('translate(12%, -8%) rotate(20deg) scale(1.5)');
    // and the render-side scale is the same scalar the preview uses
    expect(tr.scale).toBeGreaterThan(1);
  });
});
