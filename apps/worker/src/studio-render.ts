import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  galleryItems,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
  nid,
  projectAssets,
  projects,
  studioRenders,
  type StudioRenderSpec,
} from '@seed/db';
import { AssetStorage } from './storage';
import { makeThumbnail } from './thumbnails';
import { publishJobEvent } from './events';
import {
  buildAssemblyGraph,
  buildNormalizeArgs,
  fitRenderDimensions,
  type OverlayFontPaths,
} from './studio-graph';

const storage = new AssetStorage();

const MAX_CLIPS = 20;
const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;

// Title fonts. Sans/display/mono are the app's OWN self-hosted OFL faces
// (Onest / Unbounded / Martian Mono), vendored as TTF in apps/worker/assets/fonts
// (converted from the web woff2) so the ffmpeg render matches the CSS preview
// family. Serif falls back to DejaVu (no serif web face is loaded). All have full
// Cyrillic + extended Latin (incl. Uzbek oʻ/gʻ). Override per-host via env.
// `../assets/fonts` resolves the same from src (tsx) and dist (node).
const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONTS: OverlayFontPaths = {
  sans: process.env.STUDIO_FONT_SANS ?? join(FONT_DIR, 'Onest-var.ttf'),
  serif: process.env.STUDIO_FONT_SERIF ?? '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
  display: process.env.STUDIO_FONT_DISPLAY ?? join(FONT_DIR, 'Unbounded-Black.ttf'),
  mono: process.env.STUDIO_FONT_MONO ?? join(FONT_DIR, 'MartianMono-var.ttf'),
};

export interface RunStudioRenderInput {
  renderId: string;
  log: Logger;
}

export type StudioRenderOutcome = 'succeeded' | 'failed' | 'skipped' | 'canceled';

async function renderStatus(renderId: string): Promise<string | null> {
  const rows = await db
    .select({ status: studioRenders.status })
    .from(studioRenders)
    .where(eq(studioRenders.id, renderId))
    .limit(1);
  return rows[0]?.status ?? null;
}

async function isCanceled(renderId: string): Promise<boolean> {
  return (await renderStatus(renderId)) === 'canceled';
}

function run(bin: string, args: string[], log: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      log.error({ bin, code, stderr: stderr.slice(-1200) }, 'ffmpeg failed');
      reject(new Error(`${bin} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Probe a media file's duration in seconds via ffprobe. */
function probeDuration(src: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      src,
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const v = Number(out.trim());
      resolve(Number.isFinite(v) && v > 0 ? v : 0);
    });
  });
}

/** Probe whether a media URL/file carries an audio stream. */
function hasAudio(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      src,
    ]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(out.includes('audio')));
  });
}

/**
 * Assemble a multi-clip timeline into a single MP4 with ffmpeg:
 *  1. normalize each (trimmed) clip to identical codec/size/fps + guaranteed audio
 *  2. concat-demux (stream copy) into one track
 *  3. optionally mix an added audio line over the original audio
 * Sources are read straight from their public proxy URLs.
 */
export async function runStudioRender(input: RunStudioRenderInput): Promise<StudioRenderOutcome> {
  const { renderId, log } = input;
  const rows = await db.select().from(studioRenders).where(eq(studioRenders.id, renderId)).limit(1);
  const render = rows[0];
  if (!render) {
    log.warn({ renderId }, 'render not found, skipping');
    return 'skipped';
  }
  if (render.status !== 'queued') {
    log.info({ renderId, status: render.status }, 'render not queued, skipping');
    return 'skipped';
  }

  const rawSpec = render.spec as StudioRenderSpec;
  // API admission caps output at one UHD frame (3840×2160 in either
  // orientation). Preserve aspect while keeping a per-side defense for rows
  // inserted outside the API. Override the spec dimensions as well so text and
  // upper tracks are laid out against the real output canvas.
  const { width, height } = fitRenderDimensions(rawSpec.width, rawSpec.height, 3840);
  const spec: StudioRenderSpec = { ...rawSpec, width, height };
  const fps = Math.max(1, Math.min(spec.fps || 30, 60));
  const clips = (spec.clips ?? []).slice(0, MAX_CLIPS);

  if (clips.length === 0) {
    await db
      .update(studioRenders)
      .set({ status: 'failed', errorMessage: 'no clips', finishedAt: new Date() })
      .where(and(eq(studioRenders.id, renderId), eq(studioRenders.status, 'queued')));
    return 'failed';
  }

  // Atomic queued→running so a cancel that lands in this window isn't lost:
  // if the row is no longer 'queued' (e.g. already flipped to 'canceled'),
  // nothing moves and we bail without rendering.
  const claimed = await db
    .update(studioRenders)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(studioRenders.id, renderId), eq(studioRenders.status, 'queued')))
    .returning({ id: studioRenders.id });
  if (claimed.length === 0) {
    log.info({ renderId }, 'render no longer queued (canceled?), skipping');
    return 'skipped';
  }
  publishJobEvent({ userId: render.userId, jobId: renderId, status: 'running', source: 'studio' });

  const emitStage = (stage: string): void =>
    publishJobEvent({
      userId: render.userId,
      jobId: renderId,
      status: 'running',
      source: 'studio',
      stage,
    });

  const dir = await mkdtemp(join(tmpdir(), `seed-render-${renderId}-`));
  try {
    // 1) normalize each clip (trim / scale-pad / fps / speed / per-clip volume).
    // Re-check cancellation before each clip so a cancel of a running render
    // aborts within one clip's render time and never reaches gallery output.
    emitStage('normalizing');
    const normalized: string[] = [];
    let hasAudibleAudio = false;
    for (let i = 0; i < clips.length; i++) {
      if (await isCanceled(renderId)) {
        log.info({ renderId, clip: i }, 'render canceled mid-normalize, aborting');
        return 'canceled';
      }
      const clip = clips[i]!;
      const out = join(dir, `n${i}.mp4`);
      const clipHasAudio = await hasAudio(clip.url);
      if (clipHasAudio && !clip.muted && !clip.freeze) hasAudibleAudio = true;
      await run(
        'ffmpeg',
        buildNormalizeArgs({
          clip,
          hasAudio: clipHasAudio,
          width,
          height,
          fps,
          outFile: out,
          ...(spec.background?.type === 'color' && spec.background.color
            ? { bgColor: spec.background.color }
            : {}),
        }),
        log,
      );
      normalized.push(out);
      log.info({ renderId, clip: i }, 'clip normalized');
    }

    // Transitions need exact post-normalization durations for xfade offsets.
    emitStage('probing');
    const durations: number[] = [];
    for (const file of normalized) {
      const d = await probeDuration(file);
      durations.push(d > 0 ? d : 1);
    }

    // 2) single assembly pass: xfade/concat + drawtext overlays + audio mix.
    const music =
      spec.music ??
      (spec.audio
        ? {
            url: spec.audio.url,
            ...(spec.audio.gainDb !== undefined ? { gainDb: spec.audio.gainDb } : {}),
          }
        : null);
    const voiceover = spec.voiceover ?? null;
    const inputs: string[] = [...normalized];
    let musicInput: number | null = null;
    let voiceoverInput: number | null = null;
    if (music?.url) {
      hasAudibleAudio = true;
      musicInput = inputs.length;
      inputs.push(music.url);
    }
    if (voiceover?.url) {
      hasAudibleAudio = true;
      voiceoverInput = inputs.length;
      inputs.push(voiceover.url);
    }

    // Timed SFX — short hits placed at absolute times, mixed under the video.
    // Cap to bound the extra inputs (drop the tail loudly, like trackLayers), and
    // probe each so an unreadable URL is skipped with a warning rather than
    // failing the whole render.
    const SFX_CAP = 10;
    const specSfx = spec.sfx ?? [];
    if (specSfx.length > SFX_CAP) {
      log.warn({ renderId, dropped: specSfx.length - SFX_CAP }, 'sfx over cap, dropping tail');
    }
    const sfxInputs: NonNullable<Parameters<typeof buildAssemblyGraph>[0]['sfxInputs']> = [];
    for (const sx of specSfx.slice(0, SFX_CAP)) {
      const sourceDur = await probeDuration(sx.url);
      if (sourceDur <= 0) {
        log.warn({ renderId, url: sx.url }, 'sfx source unreadable, skipping');
        continue;
      }
      sfxInputs.push({
        inputIdx: inputs.length,
        atSec: Math.max(0, sx.atSec),
        ...(sx.gainDb !== undefined ? { gainDb: sx.gainDb } : {}),
      });
      inputs.push(sx.url);
    }

    // E8: PiP overlay sources — raw inputs; trim/scale/shift happen in-graph
    const overlays: NonNullable<Parameters<typeof buildAssemblyGraph>[0]['overlays']> = [];
    for (const ov of (spec.overlays ?? []).slice(0, 6)) {
      const sourceDur = await probeDuration(ov.url);
      if (sourceDur <= 0) {
        log.warn({ renderId, url: ov.url }, 'overlay source unreadable, skipping');
        continue;
      }
      overlays.push({
        inputIdx: inputs.length,
        clip: ov,
        sourceDur,
        hasAudio: await hasAudio(ov.url),
      });
      if (overlays.at(-1)!.hasAudio && !ov.muted) hasAudibleAudio = true;
      inputs.push(ov.url);
    }

    // Phase II: upper-track clips — normalize each to a frame-sized ProRes-4444
    // alpha intermediate carrying its full instrument set (color/transform/trim/
    // speed/anim/opacity), then alpha-composite it in the assembly pass. Capped
    // to bound the extra normalize passes (drop the tail loudly, never silently).
    const TRACK_LAYER_CAP = 12;
    const trackClips = (spec.tracks ?? []).flat();
    if (trackClips.length > TRACK_LAYER_CAP) {
      log.warn(
        { renderId, dropped: trackClips.length - TRACK_LAYER_CAP },
        'upper-track clips over cap, dropping tail',
      );
    }
    const trackLayers: NonNullable<Parameters<typeof buildAssemblyGraph>[0]['trackLayers']> = [];
    let tlSeq = 0;
    for (const tc of trackClips.slice(0, TRACK_LAYER_CAP)) {
      if (await isCanceled(renderId)) {
        log.info({ renderId }, 'render canceled mid-track-normalize, aborting');
        return 'canceled';
      }
      const tcHasAudio = await hasAudio(tc.url);
      const outFile = join(dir, `tl${tlSeq++}.mov`);
      await run(
        'ffmpeg',
        buildNormalizeArgs({
          clip: tc,
          hasAudio: tcHasAudio,
          width,
          height,
          fps,
          outFile,
          alpha: true,
        }),
        log,
      );
      const outDuration = await probeDuration(outFile);
      if (outDuration <= 0) {
        log.warn({ renderId, url: tc.url }, 'upper-track layer unrenderable, skipping');
        continue;
      }
      trackLayers.push({
        inputIdx: inputs.length,
        startSec: Math.max(0, tc.startSec ?? 0),
        outDuration,
        hasAudio: tcHasAudio,
        ...(tc.muted ? { muted: true } : {}),
      });
      if (tcHasAudio && !tc.muted) hasAudibleAudio = true;
      inputs.push(outFile);
    }

    if (await isCanceled(renderId)) {
      log.info({ renderId }, 'render canceled before assembly, aborting');
      return 'canceled';
    }
    emitStage('composing');

    const graph = buildAssemblyGraph({
      durations,
      clips,
      spec,
      fonts: FONTS,
      musicInput,
      voiceoverInput,
      sfxInputs,
      overlays,
      trackLayers,
      applyLoudnessNormalization: hasAudibleAudio,
    });
    log.info(
      { renderId, clips: clips.length, totalSec: graph.totalDuration },
      'assembling timeline',
    );

    // E9: container choice — MOV shares the H.264/AAC codecs (container-only
    // swap); everything else about the pipeline is identical.
    const container = spec.format === 'mov' ? 'mov' : 'mp4';
    const finalOut = join(dir, `final.${container}`);
    await run(
      'ffmpeg',
      [
        '-y',
        ...inputs.flatMap((src) => ['-i', src]),
        '-filter_complex',
        graph.filterComplex,
        '-map',
        graph.videoLabel,
        '-map',
        graph.audioLabel,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        finalOut,
      ],
      log,
    );

    // Last cancel checkpoint: the assembly pass can run minutes, so a cancel
    // may have landed while it ran. Bailing here guarantees a canceled render
    // produces NO uploaded object and NO gallery item.
    if (await isCanceled(renderId)) {
      log.info({ renderId }, 'render canceled before upload, aborting (no gallery output)');
      return 'canceled';
    }
    emitStage('uploading');

    const bytes = await readFile(finalOut);
    const uploaded = await storage.put({
      userId: render.userId,
      jobId: render.id, // render id namespaces the object path
      index: 0,
      bytes,
      contentType: container === 'mov' ? 'video/quicktime' : 'video/mp4',
      extension: container,
    });
    const thumb = await makeThumbnail({
      bytes,
      kind: 'video',
      extension: 'mp4',
      ...(typeof spec.coverSec === 'number' ? { atSec: spec.coverSec } : {}),
    });
    const thumbUpload = thumb
      ? await storage
          .put({
            userId: render.userId,
            jobId: render.id,
            index: 0,
            bytes: thumb.bytes,
            contentType: thumb.contentType,
            extension: `thumb.${thumb.extension}`,
          })
          .catch(() => null)
      : null;

    await db.transaction(async (tx) => {
      await lockMediaStorageUser(tx, render.userId);
      const expiresAt = mediaExpiresAt(await hasPaidMediaStorage(tx, render.userId));
      const updated = await tx
        .update(studioRenders)
        .set({ status: 'succeeded', resultUrl: uploaded.url, finishedAt: new Date() })
        .where(and(eq(studioRenders.id, renderId), eq(studioRenders.status, 'running')))
        .returning({ id: studioRenders.id });
      if (updated.length === 0) {
        const keys = [uploaded.key, ...(thumbUpload?.key ? [thumbUpload.key] : [])];
        await storage.removeObjects(keys).catch((err) => {
          log.warn({ renderId, err }, 'failed to clean canceled render upload');
        });
        return;
      }
      // The API validated ownership when it persisted projectId. Re-lock the
      // same live, user-scoped project here because soft-delete is an UPDATE
      // (so an FK cascade cannot protect completion from racing deletion).
      let liveProjectId: string | null = null;
      if (render.projectId) {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, render.projectId),
              eq(projects.userId, render.userId),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1)
          .for('update');
        liveProjectId = project?.id ?? null;
      }
      const assetId = nid();
      await tx.insert(galleryItems).values({
        id: assetId,
        userId: render.userId,
        originProjectId: liveProjectId,
        jobId: null,
        assetUrl: uploaded.url,
        thumbnailUrl: thumbUpload?.url ?? null,
        kind: 'video',
        sourceKind: 'studio_render',
        tags: ['studio'],
        expiresAt,
      });
      if (liveProjectId) {
        await tx
          .insert(projectAssets)
          .values({ projectId: liveProjectId, assetId, userId: render.userId })
          .onConflictDoNothing();
      }
    });
    if ((await renderStatus(renderId)) !== 'succeeded') {
      log.info({ renderId }, 'render finished after terminal state changed, suppressing output');
      return 'skipped';
    }

    log.info({ renderId, url: uploaded.url, bytes: bytes.length }, 'studio render succeeded');
    publishJobEvent({
      userId: render.userId,
      jobId: renderId,
      status: 'succeeded',
      source: 'studio',
    });
    return 'succeeded';
  } catch (err) {
    const message = (err as Error).message ?? 'render failed';
    log.error({ renderId, err }, 'studio render failed');
    const failed = await db
      .update(studioRenders)
      .set({ status: 'failed', errorMessage: message.slice(0, 1000), finishedAt: new Date() })
      .where(and(eq(studioRenders.id, renderId), eq(studioRenders.status, 'running')))
      .returning({ id: studioRenders.id });
    if (failed.length === 0) {
      const status = await renderStatus(renderId);
      if (status === 'canceled') return 'canceled';
      return 'skipped';
    }
    publishJobEvent({ userId: render.userId, jobId: renderId, status: 'failed', source: 'studio' });
    return 'failed';
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
