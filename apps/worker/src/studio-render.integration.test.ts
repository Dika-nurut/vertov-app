import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import IORedis from 'ioredis';
import type { StudioClip, StudioRenderSpec } from '@seed/db';
import { and, eq } from 'drizzle-orm';
import { db, galleryItems, nid, pool, projectAssets, projects, studioRenders } from '@seed/db';
import { runStudioRender } from './studio-render';
import { startRenderReaper } from './render-reaper';
import { oldestRunningRenderAge, reaperReapedTotal, refreshAgeGauges } from './metrics';
import { corpusPath } from './test-support/corpus';
import { seedUser, seedStudioRender, cleanupIntegrationData } from './test-support/seed';

/**
 * Editor render lifecycle over the T2 corpus (T3, half B). Drives the REAL
 * runStudioRender (local ffmpeg — FREE) for every instrument family E1–E9 and
 * asserts the output actually renders with the expected dims/duration. No
 * provider, no credit spend.
 */
const log = pino({ level: 'silent' });
let userId: string;

// Small output keeps renders fast; corpus clips are the inputs.
const W = 640;
const H = 360;
const BARS = () => corpusPath('bars-720p'); // 2s
const TONE = () => corpusPath('tone-720p-audio'); // 3s, has audio
const MOTION = () => corpusPath('motion-portrait'); // 1s, 9:16

function baseSpec(clips: StudioClip[], over: Partial<StudioRenderSpec> = {}): StudioRenderSpec {
  return { clips, width: W, height: H, fps: 24, ...over };
}

function ffprobe(url: string, entries: string): string {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', entries, '-of', 'csv=p=0', url],
    { encoding: 'utf8' },
  );
  return (r.stdout ?? '').trim();
}

function probeDuration(url: string): number {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url],
    { encoding: 'utf8' },
  );
  return Number((r.stdout ?? '').trim());
}

async function render(spec: StudioRenderSpec): Promise<{ url: string; status: string }> {
  const id = await seedStudioRender(userId, spec);
  const outcome = await runStudioRender({ renderId: id, log });
  const row = (await db.select().from(studioRenders).where(eq(studioRenders.id, id)).limit(1))[0]!;
  expect(outcome, row.errorMessage ?? 'render failed').toBe('succeeded');
  const [asset] = await db
    .select()
    .from(galleryItems)
    .where(and(eq(galleryItems.userId, userId), eq(galleryItems.assetUrl, row.resultUrl!)))
    .limit(1);
  expect(asset?.sourceKind).toBe('studio_render');
  return { url: row.resultUrl!, status: row.status };
}

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser();
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

describe('editor render — instrument families over the corpus (zero spend)', () => {
  it('baseline single clip renders at the requested dims', async () => {
    const { url } = await render(baseSpec([{ url: BARS() }]));
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
    expect(probeDuration(url)).toBeGreaterThan(1.5); // ~2s source
  });

  it('muted clip: mute one clip while another keeps its audio (real mute action)', async () => {
    const { url } = await render(
      baseSpec([
        { url: BARS(), muted: true },
        { url: TONE(), volumeDb: -6 },
      ]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E1/E2 transform: scale/position/rotate/crop holds output dims', async () => {
    const { url } = await render(
      baseSpec([
        {
          url: BARS(),
          transform: { scale: 1.4, posX: 10, posY: -8, rotate: 12, crop: { left: 0.1, top: 0.05 } },
        },
      ]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E3 colour grade: 8-slider grade renders', async () => {
    const { url } = await render(
      baseSpec([
        {
          url: BARS(),
          color: { brightness: 20, contrast: 15, saturation: 25, temperature: 10 },
        },
      ]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E4 reverse + flip + freeze-frame renders with expected hold duration', async () => {
    const { url: flipped } = await render(
      baseSpec([{ url: BARS(), reversed: true, flipH: true, flipV: true }]),
    );
    expect(ffprobe(flipped, 'stream=width,height')).toBe(`${W},${H}`);
    // Freeze forces a silent audio line for that clip, so pair it with an
    // audible clip (a director's freeze sits inside a timeline that has sound).
    const { url: frozen } = await render(
      baseSpec([{ url: TONE() }, { url: BARS(), freeze: { atSec: 0.5, durSec: 1.5 } }]),
    );
    expect(probeDuration(frozen)).toBeGreaterThan(3.5); // 3s tone + 1.5s freeze
  });

  it('E5 speed: 2× halves duration; ramp preset renders', async () => {
    const { url: fast } = await render(baseSpec([{ url: TONE(), speed: 2 }]));
    expect(probeDuration(fast)).toBeLessThan(2.2); // 3s / 2 ≈ 1.5s
    const { url: ramp } = await render(baseSpec([{ url: TONE(), speedCurve: 'hero' }]));
    expect(probeDuration(ramp)).toBeGreaterThan(0.5);
  });

  it('E6 animation in/out: fade/slide/zoom presets render', async () => {
    const { url } = await render(
      baseSpec([
        {
          url: BARS(),
          animIn: { kind: 'fade', durSec: 0.4 },
          animOut: { kind: 'zoom', durSec: 0.4 },
        },
      ]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E7 keyframes: opacity + transform over time render', async () => {
    const { url } = await render(
      baseSpec([
        {
          url: BARS(),
          keyframes: {
            opacity: [
              { t: 0, v: 0.2 },
              { t: 1.5, v: 1 },
            ],
            scale: [
              { t: 0, v: 1 },
              { t: 1.5, v: 1.5 },
            ],
          },
        },
      ]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E8 PiP overlay: a second clip composited as picture-in-picture', async () => {
    const { url } = await render(
      baseSpec([{ url: BARS() }], {
        overlays: [{ url: MOTION(), atSec: 0, scale: 0.35, posX: 60, posY: 60 }],
      }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('E9 export: MOV container at a different resolution/fps', async () => {
    const { url } = await render(
      baseSpec([{ url: BARS() }], { width: 854, height: 480, fps: 30, format: 'mov' }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe('854,480');
  });

  it.skipIf(process.env.STUDIO_UHD_INTEGRATION !== '1')(
    'E9 UHD contract: portrait 4K is not silently clamped to a square',
    async () => {
      const { url } = await render(
        baseSpec([{ url: MOTION(), outSec: 0.25 }], {
          width: 2160,
          height: 3840,
          fps: 24,
        }),
      );
      expect(ffprobe(url, 'stream=width,height')).toBe('2160,3840');
    },
  );

  it('multi-clip with crossfade transition + audio mix renders one track', async () => {
    const { url } = await render(
      baseSpec([{ url: BARS(), transition: 'crossfade', transitionSec: 0.5 }, { url: TONE() }]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
    expect(probeDuration(url)).toBeGreaterThan(3); // 2s + 3s - 0.5 xfade
  });

  it('timed SFX mixes under the video without extending its duration', async () => {
    // A 2s BARS video with a timed SFX at 1s (the TONE clip supplies the audio
    // stream). The SFX is trimmed to the video length, so the output stays ~2s —
    // proving it rides UNDER the video and never governs amix duration.
    const { url } = await render(
      baseSpec([{ url: BARS() }], { sfx: [{ url: TONE(), atSec: 1, gainDb: -6 }] }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
    const d = probeDuration(url);
    expect(d).toBeGreaterThan(1.5);
    expect(d).toBeLessThan(2.6); // ~2s BARS, NOT extended toward the 3s TONE
  });

  // Geometric transitions: one render per family proves the xfade mode the
  // CSS preview mirrors actually assembles into a valid mp4 (preview==export).
  it.each(['slideleft', 'wipeup', 'circleopen', 'zoomin'] as const)(
    'geometric transition %s renders a valid mp4',
    async (transition) => {
      const { url } = await render(
        baseSpec([{ url: BARS(), transition, transitionSec: 0.5 }, { url: TONE() }]),
      );
      expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
      expect(probeDuration(url)).toBeGreaterThan(3); // 2s + 3s - 0.5 overlap
    },
  );

  it('text overlay (drawtext) renders without breaking the pipeline', async () => {
    const { url } = await render(
      baseSpec([{ url: BARS() }], {
        texts: [{ text: 'Сид', fromSec: 0, toSec: 2, position: 'bottom', fade: true }],
      }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('S3 background fill: letterbox bars take the chosen colour (preview==export)', async () => {
    // A 16:9 source into a 9:16 frame letterboxes top/bottom; that bar must be
    // the background colour, not black. Sample the top-centre pixel.
    const { url } = await render(
      baseSpec([{ url: BARS() }], {
        width: 360,
        height: 640,
        background: { type: 'color', color: '#ff0000' },
      }),
    );
    const r = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        url,
        '-vf',
        'crop=2:2:iw/2:0,scale=1:1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 1 << 20 },
    );
    const px = r.stdout as Buffer;
    expect(px.length).toBeGreaterThanOrEqual(3);
    const [red, green, blue] = [px[0]!, px[1]!, px[2]!];
    // Red-dominant letterbox (allow yuv round-trip slack), clearly not black.
    expect(red).toBeGreaterThan(green + 40);
    expect(red).toBeGreaterThan(blue + 40);
    expect(red).toBeGreaterThan(110);
  });

  it('S3 blend mode: multiply over a red background zeroes the green/blue channels', async () => {
    // out = clip·bg/255; with bg pure red, every pixel keeps red, loses G+B.
    const { url } = await render(
      baseSpec([{ url: BARS(), blendMode: 'multiply' }], {
        background: { type: 'color', color: '#ff0000' },
      }),
    );
    const r = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        url,
        '-vf',
        'crop=2:2:iw/2:ih/2,scale=1:1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 1 << 20 },
    );
    const px = r.stdout as Buffer;
    expect(px[1]!).toBeLessThan(70); // green ~0
    expect(px[2]!).toBeLessThan(70); // blue ~0
  });

  it('S3 HSL: per-colour-range huesaturation renders (ffmpeg huesaturation)', async () => {
    const { url } = await render(
      baseSpec([{ url: BARS(), color: { hsl: { b: { h: 40, s: 60 }, r: { s: -100 } } } }]),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
  });

  it('S3 curves: lighten preset renders brighter than darken (real tone curve)', async () => {
    const center = (url: string): number => {
      const r = spawnSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          url,
          '-vf',
          'crop=2:2:iw/2:ih/2,scale=1:1',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          '-',
        ],
        { maxBuffer: 1 << 20 },
      );
      return (r.stdout as Buffer)[0] ?? 0;
    };
    const { url: light } = await render(baseSpec([{ url: BARS(), color: { curve: 'lighten' } }]));
    const { url: dark } = await render(baseSpec([{ url: BARS(), color: { curve: 'darken' } }]));
    expect(center(light)).toBeGreaterThan(center(dark) + 8);
  });

  it('S3 mask: a circle mask reveals the centre; corners fall to the background', async () => {
    // 640×360, circle radius = min/2 = 180 centred → corner (0,0) is outside →
    // it must show the red background, proving the geq mask renders.
    const { url } = await render(
      baseSpec([{ url: BARS(), mask: { shape: 'circle' } }], {
        background: { type: 'color', color: '#ff0000' },
      }),
    );
    const r = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        url,
        '-vf',
        'crop=2:2:0:0,scale=1:1',
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { maxBuffer: 1 << 20 },
    );
    const px = r.stdout as Buffer;
    expect(px.length).toBeGreaterThanOrEqual(3);
    expect(px[0]!).toBeGreaterThan(px[1]! + 40); // red-dominant corner
    expect(px[0]!).toBeGreaterThan(px[2]! + 40);
  });

  // B-2b: auto-captions render as a sequence of timed bottom drawtext clips
  // (the ASR transcript → caption overlays → this render path).
  it('B-2b captions: multiple timed caption overlays render', async () => {
    const { url } = await render(
      baseSpec([{ url: TONE() }], {
        texts: [
          { text: 'Первый субтитр', fromSec: 0, toSec: 1.5, position: 'bottom', fade: true },
          { text: 'Второй субтитр', fromSec: 1.5, toSec: 3, position: 'bottom', fade: true },
        ],
      }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
    expect(probeDuration(url)).toBeGreaterThan(2.5); // ~3s tone, captions over it
  });

  // Fonts: each title font maps to a bundled TTF the worker must resolve + render
  // (Onest/Unbounded/Martian, converted from the app's own woff2). A bad font path
  // makes drawtext fail → render fails. Includes the Uzbek oʻ glyph.
  it('renders titles with each bundled font (sans/display/mono), incl. Uzbek glyphs', async () => {
    const { url } = await render(
      baseSpec([{ url: TONE() }], {
        texts: [
          { text: 'Salom oʻzbek', fromSec: 0, toSec: 1, position: 'top', font: 'display' },
          { text: 'Привет', fromSec: 1, toSec: 2, position: 'center', font: 'mono' },
          { text: 'Hello', fromSec: 2, toSec: 3, position: 'bottom', font: 'sans' },
        ],
      }),
    );
    expect(ffprobe(url, 'stream=width,height')).toBe(`${W},${H}`);
    expect(probeDuration(url)).toBeGreaterThan(2.5);
  });
});

/**
 * Render lifecycle: recovery + cancellation (B-0). A render must never strand
 * the user — a hung one is reaped to `failed`, and a user can cancel a queued
 * or running render, which leaves a clean terminal state and NO gallery output.
 */
describe('render lifecycle — reaper + cancel (zero spend)', () => {
  it('stores a free standalone Studio render for 30 days', async () => {
    const freeUserId = await seedUser({ tier: 'free' });
    const renderId = await seedStudioRender(freeUserId, baseSpec([{ url: BARS() }]));
    const before = Date.now();
    expect(await runStudioRender({ renderId, log })).toBe('succeeded');
    const [renderRow] = await db.select().from(studioRenders).where(eq(studioRenders.id, renderId));
    const [asset] = await db
      .select({ expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, renderRow!.resultUrl!));
    expect(asset?.expiresAt).toBeInstanceOf(Date);
    expect(asset!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
    expect(asset!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
  });

  it('sets studio-render origin + membership only while its enqueue-validated project is live', async () => {
    const liveProjectId = `it-project-${nid()}`;
    const deletedProjectId = `it-project-${nid()}`;
    await db.insert(projects).values([
      { id: liveProjectId, userId, title: 'Live render' },
      { id: deletedProjectId, userId, title: 'Deleted render' },
    ]);
    const spec = baseSpec([{ url: BARS() }]);
    const liveId = await seedStudioRender(userId, spec, liveProjectId);
    const deletedId = await seedStudioRender(userId, spec, deletedProjectId);
    await db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deletedProjectId));

    expect(await runStudioRender({ renderId: liveId, log })).toBe('succeeded');
    expect(await runStudioRender({ renderId: deletedId, log })).toBe('succeeded');
    const [liveRender] = await db.select().from(studioRenders).where(eq(studioRenders.id, liveId));
    const [deletedRender] = await db
      .select()
      .from(studioRenders)
      .where(eq(studioRenders.id, deletedId));
    const [liveAsset] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, liveRender!.resultUrl!));
    const [deletedAsset] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, deletedRender!.resultUrl!));
    expect(liveAsset?.originProjectId).toBe(liveProjectId);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, liveAsset!.id)),
    ).toEqual([expect.objectContaining({ projectId: liveProjectId, userId })]);
    expect(deletedAsset?.originProjectId).toBeNull();
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, deletedAsset!.id)),
    ).toHaveLength(0);
  });

  async function renderRow(id: string) {
    return (await db.select().from(studioRenders).where(eq(studioRenders.id, id)).limit(1))[0]!;
  }
  async function galleryCount(uid: string): Promise<number> {
    const rows = await db.select().from(galleryItems).where(eq(galleryItems.userId, uid));
    return rows.length;
  }
  async function gaugeValue(g: typeof oldestRunningRenderAge): Promise<number> {
    return (await g.get()).values[0]?.value ?? 0;
  }
  async function reaperCount(kind: string): Promise<number> {
    return (
      (await reaperReapedTotal.get()).values.find((v) => v.labels['kind'] === kind)?.value ?? 0
    );
  }

  it('reaper flips a hung running render to failed with a timeout message', async () => {
    const id = await seedStudioRender(userId, baseSpec([{ url: BARS() }]));
    // Simulate a render that went running long ago and never finished.
    await db
      .update(studioRenders)
      .set({ status: 'running', startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(studioRenders.id, id));

    const redis = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', {
      maxRetriesPerRequest: null,
    });
    const reaper = startRenderReaper({
      log,
      redis,
      timeoutMs: 500,
      intervalMs: 600_000,
      leaderKey: `test:render-reaper:${id}`,
    });
    const reapedBefore = await reaperCount('render');
    try {
      await reaper.tick();
      let row = await renderRow(id);
      for (let i = 0; i < 40 && row.status !== 'failed'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        row = await renderRow(id);
      }
      expect(row.status).toBe('failed');
      expect(row.errorMessage ?? '').toMatch(/timeout/i);
      expect(row.finishedAt).not.toBeNull();
      // B-9: the reap is visible in metrics.
      expect(await reaperCount('render')).toBeGreaterThan(reapedBefore);
    } finally {
      reaper.stop();
      await redis.quit();
    }
  });

  it('B-9: oldest-running-render age gauge reflects a stuck render', async () => {
    const id = await seedStudioRender(userId, baseSpec([{ url: BARS() }]));
    await db
      .update(studioRenders)
      .set({ status: 'running', startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(studioRenders.id, id));
    await refreshAgeGauges();
    // ~1h old → gauge well above zero (and above the reaper's test timeout).
    expect(await gaugeValue(oldestRunningRenderAge)).toBeGreaterThan(1000);
    // Clean up so it doesn't skew later age reads.
    await db
      .update(studioRenders)
      .set({ status: 'failed', finishedAt: new Date() })
      .where(eq(studioRenders.id, id));
  });

  it('cancel before pickup: a canceled queued render is skipped, no output', async () => {
    const uid = await seedUser();
    const id = await seedStudioRender(uid, baseSpec([{ url: BARS() }]));
    // The cancel endpoint flips queued→canceled before the worker claims it.
    await db
      .update(studioRenders)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where(eq(studioRenders.id, id));

    expect(await runStudioRender({ renderId: id, log })).toBe('skipped');
    const row = await renderRow(id);
    expect(row.status).toBe('canceled'); // worker did not overwrite it to running
    expect(row.resultUrl).toBeNull();
    expect(await galleryCount(uid)).toBe(0);
  });

  it('cancel during render: worker aborts cleanly with no gallery output', async () => {
    const uid = await seedUser();
    // Several clips → cancellation checkpoints between normalize passes.
    const id = await seedStudioRender(
      uid,
      baseSpec([{ url: BARS() }, { url: TONE() }, { url: MOTION() }]),
    );
    const runP = runStudioRender({ renderId: id, log });
    // Cancel while the first clip is normalizing (well under one clip's time).
    await new Promise((r) => setTimeout(r, 50));
    await db
      .update(studioRenders)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where(and(eq(studioRenders.id, id), eq(studioRenders.status, 'running')));

    expect(await runP).toBe('canceled');
    const row = await renderRow(id);
    expect(row.status).toBe('canceled');
    expect(row.resultUrl).toBeNull();
    expect(await galleryCount(uid)).toBe(0);
  });
});
