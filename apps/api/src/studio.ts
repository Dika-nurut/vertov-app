import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { Client as MinioClient, CopySourceOptions, CopyDestinationOptions } from 'minio';
import { z } from 'zod';
import {
  db,
  galleryItems,
  nid,
  projectAssets,
  studioProjects,
  studioRenders,
  type StudioClip,
  type StudioOverlayClip,
  type StudioRenderSpec,
  type StudioSfx,
} from '@seed/db';
import { STUDIO_RENDER_QUEUE, enqueueViaOutbox } from '@seed/credits';
import { checkPerUserRateLimit } from './prompt-enhancer';
import { egressFetch } from './egress-fetch';
import { createAsrFactory } from '@seed/provider-asr';
import {
  anonymousBucketPolicyEnabled,
  resolveS3ClientOptions,
  tempPartKey,
  tempUploadPrefix,
} from './s3-config';
import { validateOwnedLiveProject, workspaceProjectIdSchema } from './project-context';
import {
  availableOwnedAssetCondition,
  resolveAvailableOwnedAssets,
  studioTimelineAssetReferences,
  syncAssetReferences,
} from './asset-references';
import {
  decodeProjectListCursor,
  encodeProjectListCursor,
  projectListContext,
} from './project-list-cursor';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

// ── Resumable multipart upload (raw 4K footage runs to multiple GB) ──
// The browser splits the file into PART_SIZE chunks and PUTs each one; the API
// streams every chunk to a temp object, then `composeObject` assembles them
// server-side into the final asset. Chunks are deliberately ≤ ~100 MB so each
// request clears the Cloudflare edge body cap, and the storage backend (MinIO)
// is never exposed to the browser — the bytes only ever flow through the API.
const PART_SIZE = 32 * 1024 * 1024; // 32 MiB — under the edge cap, over MinIO's 5 MiB compose minimum
const MAX_PARTS = 10_000; // MinIO compose ceiling
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB hard cap
const PART_CONTENT_TYPE = 'application/x-seed-upload-part';
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm']);
const VIDEO_CT: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/i;
const partKey = tempPartKey;
const mpPrefix = tempUploadPrefix;
function sanitizeExt(raw: string): string {
  return raw
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 5)
    .toLowerCase();
}

function hasFtypBox(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp';
}

function matchesDeclaredMediaType(ext: string, buf: Buffer): boolean {
  switch (ext) {
    case 'png':
      return buf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg':
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'webp':
      return (
        buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WEBP'
      );
    case 'mp4':
    case 'mov':
    case 'm4a':
      return hasFtypBox(buf);
    case 'webm':
      return (
        buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
      );
    case 'mp3':
      return (
        buf.toString('ascii', 0, 3) === 'ID3' ||
        (buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0)
      );
    case 'aac':
      return buf.length >= 2 && buf[0] === 0xff && (buf[1] === 0xf1 || buf[1] === 0xf9);
    case 'wav':
      return (
        buf.length >= 12 &&
        buf.toString('ascii', 0, 4) === 'RIFF' &&
        buf.toString('ascii', 8, 12) === 'WAVE'
      );
    case 'ogg':
      return buf.toString('ascii', 0, 4) === 'OggS';
    default:
      return false;
  }
}

// Captions runs real ASR (Deepgram) on a clip — uncapped it's unmetered provider
// spend (audit LOW). Cap per-user submits per minute.
const CAPTIONS_RATE_LIMIT_MAX = 10;
// Upload abuse hardening: these endpoints can push large byte volume through the
// API even before a render/generation spend guard applies.
const UPLOAD_RATE_LIMIT_MAX = 30; // generic/audio/init/complete/abort per user per minute
const UPLOAD_PART_RATE_LIMIT_MAX = 600; // 32 MiB chunks; high enough for fast resumable uploads
// BL-2: studio render is an unmetered ffmpeg farm (worker pool concurrency 2).
// Cap submit rate, simultaneous in-flight renders, and declared output length
// per user so one caller can't flood the slots or queue a multi-hour render.
const RENDER_RATE_LIMIT_MAX = 10; // submits per user per minute
const RENDER_INFLIGHT_DEFAULT = 3; // simultaneous queued/running renders per user
const RENDER_MAX_SECONDS_DEFAULT = 1800; // declared output ceiling (30 min)

const cropFracSchema = z.number().min(0).max(0.45);
// Per-clip transform (editor E2) — ranges mirror the inspector sliders.
const transformSchema = z.object({
  scale: z.number().min(0.2).max(3).optional(),
  posX: z.number().min(-100).max(100).optional(),
  posY: z.number().min(-100).max(100).optional(),
  rotate: z.number().min(-180).max(180).optional(),
  crop: z
    .object({
      left: cropFracSchema.optional(),
      top: cropFracSchema.optional(),
      right: cropFracSchema.optional(),
      bottom: cropFracSchema.optional(),
    })
    .optional(),
});

const pm100 = z.number().min(-100).max(100);
// S3 HSL: one colour range's hue (−180..180) / saturation / lightness (±100).
const hslAdjustSchema = z
  .object({
    h: z.number().min(-180).max(180).optional(),
    s: pm100.optional(),
    l: pm100.optional(),
  })
  .optional();
// Per-clip colour grade (editor E3) — centered sliders ±100; vignette/grain 0–100.
const colorSchema = z.object({
  brightness: pm100.optional(),
  contrast: pm100.optional(),
  saturation: pm100.optional(),
  temperature: pm100.optional(),
  highlight: pm100.optional(),
  shadow: pm100.optional(),
  vignette: z.number().min(0).max(100).optional(),
  grain: z.number().min(0).max(100).optional(),
  // S3 subsystem D: tone-curve preset.
  curve: z
    .enum([
      'lighten',
      'darken',
      'fade',
      'contrast',
      'cool',
      'warm',
      'vintage',
      'warm-film',
      'cool-film',
      'noir',
      'teal-orange',
      'bleach-bypass',
      'faded-polaroid',
    ])
    .optional(),
  // S3 subsystem D (HSL): per-colour-range hue/sat/lum.
  hsl: z
    .object({
      r: hslAdjustSchema,
      y: hslAdjustSchema,
      g: hslAdjustSchema,
      c: hslAdjustSchema,
      b: hslAdjustSchema,
      m: hslAdjustSchema,
    })
    .partial()
    .optional(),
});

const clipSchemaBase = z.object({
  url: z.string().url(),
  assetId: z.string().min(1).max(160).optional(),
  inSec: z.number().min(0).max(3600).optional(),
  outSec: z.number().min(0).max(3600).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  speedCurve: z.enum(['montage', 'hero', 'flash']).optional(),
  animIn: z
    .object({ kind: z.enum(['fade', 'slide', 'zoom']), durSec: z.number().min(0.2).max(2) })
    .optional(),
  animOut: z
    .object({ kind: z.enum(['fade', 'slide', 'zoom']), durSec: z.number().min(0.2).max(2) })
    .optional(),
  // E7 phase 1 — keyframed opacity + transform, ≤24 keys per prop
  keyframes: z
    .object({
      opacity: z
        .array(z.object({ t: z.number().min(0).max(120), v: z.number().min(0).max(1) }))
        .max(24)
        .optional(),
      posX: z
        .array(z.object({ t: z.number().min(0).max(120), v: z.number().min(-100).max(100) }))
        .max(24)
        .optional(),
      posY: z
        .array(z.object({ t: z.number().min(0).max(120), v: z.number().min(-100).max(100) }))
        .max(24)
        .optional(),
      scale: z
        .array(z.object({ t: z.number().min(0).max(120), v: z.number().min(1).max(3) }))
        .max(24)
        .optional(),
      rotate: z
        .array(z.object({ t: z.number().min(0).max(120), v: z.number().min(-180).max(180) }))
        .max(24)
        .optional(),
    })
    .optional(),
  muted: z.boolean().optional(),
  volumeDb: z.number().min(-40).max(20).optional(),
  transition: z
    .enum([
      'cut',
      'crossfade',
      'dip',
      'flash',
      'slideleft',
      'slideright',
      'slideup',
      'slidedown',
      'wipeleft',
      'wiperight',
      'wipeup',
      'wipedown',
      'circleopen',
      'circleclose',
      'zoomin',
    ])
    .optional(),
  transitionSec: z.number().min(0.2).max(1.5).optional(),
  filter: z.enum(['none', 'warm', 'cool', 'mono', 'punch']).optional(),
  transform: transformSchema.optional(),
  color: colorSchema.optional(),
  reversed: z.boolean().optional(),
  flipH: z.boolean().optional(),
  flipV: z.boolean().optional(),
  freeze: z
    .object({ atSec: z.number().min(0).max(3600), durSec: z.number().min(0.5).max(10) })
    .optional(),
  // S3 subsystem C: mask shape + soft edge. `points` carries the freeform
  // polygon (normalized 0–1 vertices, ≤16); worker/CSS ignore it unless
  // shape==='freeform', and a freeform mask with <3 points renders nothing.
  mask: z
    .object({
      shape: z.enum([
        'none',
        'circle',
        'rect',
        'linear',
        'heart',
        'star',
        'diamond',
        'cinematic-bars',
        'freeform',
      ]),
      feather: z.number().min(0).max(100).optional(),
      invert: z.boolean().optional(),
      points: z
        .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
        .max(16)
        .optional(),
    })
    .optional(),
  // S3 subsystem D (Blend): static layer opacity + blend mode.
  opacity: z.number().min(0).max(1).optional(),
  blendMode: z.enum(['normal', 'multiply', 'screen', 'overlay']).optional(),
  // Multi-track (Phase II): absolute start for a clip on an upper video track.
  startSec: z.number().min(0).max(3600).optional(),
});

/** Cross-field validity a flat object schema can't express — reject specs the
 * worker would silently no-op rather than honour. */
const clipSchema = clipSchemaBase.superRefine((c, ctx) => {
  const trimmed = typeof c.outSec === 'number' && c.outSec > (c.inSec ?? 0);
  // A speed-ramp preset needs explicit trim bounds; without them the worker
  // falls back to uniform speed and the curve is silently lost. (A freeze clip
  // legitimately ignores speed/curve, so don't demand bounds there.)
  if (c.speedCurve && !c.freeze && !trimmed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'speedCurve requires outSec > inSec',
      path: ['speedCurve'],
    });
  }
  // An exit animation needs a known output duration (trim bounds, or a freeze
  // hold); otherwise buildAnimChain drops it.
  if (c.animOut && !trimmed && !c.freeze) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'animOut requires outSec > inSec or a freeze',
      path: ['animOut'],
    });
  }
  // A freeform mask under 3 points draws nothing (worker treats it as no mask) —
  // reject it instead of silently rendering the whole clip.
  if (c.mask?.shape === 'freeform' && (c.mask.points?.length ?? 0) < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'freeform mask needs at least 3 points',
      path: ['mask', 'points'],
    });
  }
});

const textSchema = z.object({
  text: z.string().min(1).max(200),
  fromSec: z.number().min(0).max(3600),
  toSec: z.number().min(0).max(3600),
  position: z.enum(['top', 'center', 'bottom']),
  sizeFrac: z.number().min(0.02).max(0.25).optional(),
  font: z.enum(['sans', 'serif', 'display', 'mono']).optional(),
  fade: z.boolean().optional(),
  plate: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
});

// Word-pop captions («по словам»): ONE shared style + up to 400 word windows.
// A separate lane from `texts` (capped at 12) because a clip of speech produces
// far more words than that, and each rides its own drawtext in the worker.
const popTextSchema = z.object({
  font: z.enum(['sans', 'serif', 'display', 'mono']).optional(),
  sizeFrac: z.number().min(0.02).max(0.25).optional(),
  position: z.enum(['top', 'center', 'bottom']).optional(),
  plate: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
  words: z
    .array(
      z.object({
        text: z.string().min(1).max(40),
        fromSec: z.number().min(0).max(3600),
        toSec: z.number().min(0).max(3600),
      }),
    )
    .min(1)
    .max(400),
});

const audioTrackSchema = z.object({
  url: z.string().url(),
  gainDb: z.number().min(-40).max(20).optional(),
  fromSec: z.number().min(0).max(3600).optional(),
  fadeIn: z.boolean().optional(),
  fadeOut: z.boolean().optional(),
  // Auto-ducking (music line): hold windows during which the music dips to `db`.
  duck: z
    .object({
      db: z.number().min(-40).max(0),
      segments: z
        .array(
          z.object({
            fromSec: z.number().min(0).max(3600),
            toSec: z.number().min(0).max(3600),
          }),
        )
        .max(120),
      // `${voiceover.url}@${voiceover.fromSec}` at analysis time — lets the
      // client detect a stale duck after the voiceover changes. Optional so
      // older specs without it stay valid.
      sourceKey: z.string().max(300).optional(),
    })
    .optional(),
});

// Timed sound-effect clip — a short hit placed at an absolute timeline time,
// mixed under the video (never extends the render duration).
const sfxSchema = z.object({
  url: z.string().url(),
  atSec: z.number().min(0).max(3600),
  gainDb: z.number().min(-40).max(20).optional(),
});

// E8: PiP overlay items over the assembled main track
const overlaySchema = z.object({
  url: z.string().url(),
  atSec: z.number().min(0).max(3600),
  inSec: z.number().min(0).max(3600).optional(),
  outSec: z.number().min(0).max(3600).optional(),
  scale: z.number().min(0.1).max(1).optional(),
  posX: z.number().min(-100).max(100).optional(),
  posY: z.number().min(-100).max(100).optional(),
  opacity: z.number().min(0).max(1).optional(),
  muted: z.boolean().optional(),
  gainDb: z.number().min(-40).max(20).optional(),
});

const MAX_RENDER_PIXELS = 3840 * 2160;
const renderSchema = z
  .object({
    projectId: z.string().min(1).max(160).optional(),
    clips: z.array(clipSchema).min(1).max(20),
    overlays: z.array(overlaySchema).max(6).optional(),
    // Multi-track (Phase II): upper video tracks of full clips. The worker enforces
    // the per-render upper-clip compositing cap; these bounds are abuse guards.
    tracks: z.array(z.array(clipSchema).max(50)).max(8).optional(),
    // Legacy single audio line — still accepted, treated as `music` by the worker.
    audio: z
      .object({ url: z.string().url(), gainDb: z.number().min(-40).max(20).optional() })
      .nullish(),
    music: audioTrackSchema.nullish(),
    voiceover: audioTrackSchema.nullish(),
    sfx: z.array(sfxSchema).max(10).optional(),
    texts: z.array(textSchema).max(12).optional(),
    // Word-pop captions lane (dedicated; exceeds the 12-`texts` cap by design).
    popText: popTextSchema.optional(),
    // E9: true UHD in either orientation. The pixel-area refinement rejects
    // pathological 3840×3840 requests while allowing 3840×2160 / 2160×3840.
    width: z.number().int().min(64).max(3840).default(1280),
    height: z.number().int().min(64).max(3840).default(720),
    fps: z.number().int().min(1).max(60).default(30),
    format: z.enum(['mp4', 'mov']).optional(),
    // S3 subsystem G: composition background fill for letterbox bars.
    background: z
      .object({
        // Blur is intentionally not accepted until the worker implements it.
        type: z.literal('color'),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .optional(),
    // S7: cover-frame time for the render thumbnail.
    coverSec: z.number().min(0).max(3600).optional(),
  })
  .refine((value) => value.width * value.height <= MAX_RENDER_PIXELS, {
    message: 'render pixel area exceeds UHD',
    path: ['width'],
  });

/**
 * BL-2: a pre-enqueue bound on the DECLARED output duration of a render.
 *
 * We can't know an untrimmed clip's source length without probing, but the
 * documented DoS — "20 clips × outSec≤3600" — *declares* its duration, and a
 * slow speed-ramp (`speed` < 1) amplifies it. Both are summed here so an
 * oversized spec is rejected before it ever reaches the 2-slot ffmpeg pool.
 * Untrimmed clips are the user's OWN assets (BL-4) and stay bounded by the
 * worker. Freeze clips contribute their hold duration.
 */
// Duration expansion of each speed-CURVE preset — Σ(frac/rate) over its
// segments. MUST mirror apps/worker/src/studio-graph.ts SPEED_CURVES (the worker
// computes the real ramp duration from that table and IGNORES `speed` when a
// curve is set). A slow curve segment (rate < 1) makes the output LONGER than
// the trim, so the guard must count the curve, not `speed` — otherwise
// `{outSec:3600, speed:4, speedCurve:'flash'}` declares 900s but renders ~4650s.
const SPEED_CURVE_EXPANSION: Record<'montage' | 'hero' | 'flash', number> = {
  montage: 0.4 / 0.6 + 0.6 / 1.6, // ≈ 1.042
  hero: 0.3 / 1.8 + 0.4 / 0.45 + 0.3 / 1.8, // ≈ 1.222
  flash: 0.7 / 0.6 + 0.3 / 2.4, // ≈ 1.292
};

interface GuardClip {
  inSec?: number | undefined;
  outSec?: number | undefined;
  speed?: number | undefined;
  speedCurve?: 'montage' | 'hero' | 'flash' | undefined;
  freeze?: { durSec: number } | undefined;
}

/** Declared (normalized) output seconds a single clip costs the worker. */
function clipDeclaredSeconds(c: GuardClip): number {
  if (c.freeze) return Math.max(0, c.freeze.durSec);
  if (c.outSec === undefined) return 0;
  const span = Math.max(0, c.outSec - (c.inSec ?? 0));
  // A speed CURVE overrides plain `speed` in the worker — bound by its own
  // (possibly >1) duration expansion, never by the attacker-controlled speed.
  if (c.speedCurve && SPEED_CURVE_EXPANSION[c.speedCurve]) {
    return span * SPEED_CURVE_EXPANSION[c.speedCurve];
  }
  const speed = c.speed && c.speed > 0 ? c.speed : 1;
  return span / speed;
}

// Mirror of the worker's TRACK_LAYER_CAP (apps/worker/src/studio-render.ts): only
// the first 12 flattened upper-track clips are normalized, so only those cost time.
const GUARD_TRACK_LAYER_CAP = 12;

function declaredRenderSeconds(d: {
  clips: GuardClip[];
  tracks?: GuardClip[][] | undefined;
}): number {
  let total = 0;
  for (const c of d.clips) total += clipDeclaredSeconds(c);
  // Upper-track clips are normalized (ProRes-4444) too — an amplified upper clip
  // (e.g. {outSec:3600, speed:4, speedCurve:'flash'}) is just as expensive as a
  // base clip, so it MUST count against the ceiling. Cap at the same 12 the worker
  // renders so a legit multi-track project isn't over-counted.
  for (const c of (d.tracks ?? []).flat().slice(0, GUARD_TRACK_LAYER_CAP)) {
    total += clipDeclaredSeconds(c);
  }
  return total;
}

function compactJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Fixed waveform resolution for the server-computed peaks sidecar. The client
 * slices this per-clip by time, so one decode serves every trim of a source. */
export const PEAK_BUCKETS = 1600;

/** Downsample mono PCM (Float32, any sample rate) to `buckets` normalized 0–1
 * peak magnitudes. Pure + deterministic so it's unit-testable without ffmpeg.
 * Peaks round to 3 dp to keep the cached JSON small. Returns [] only for an
 * empty buffer; digital silence yields all-zero peaks (a flat line, correctly). */
export function bucketPeaks(samples: Float32Array, buckets = PEAK_BUCKETS): number[] {
  if (samples.length === 0 || buckets <= 0) return [];
  const block = Math.max(1, Math.floor(samples.length / buckets));
  const out: number[] = [];
  let max = 0;
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * block;
    const end = Math.min(samples.length, start + block);
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j] ?? 0);
      if (v > peak) peak = v;
    }
    out.push(peak);
    if (peak > max) max = peak;
  }
  return max > 0 ? out.map((v) => Math.round((v / max) * 1000) / 1000) : out;
}

/** Read a Node readable (a MinIO object stream) fully into a Buffer. */
function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** ffmpeg stderr signatures for "the input is fine, it just has no audio stream"
 * (a muted screen-capture, a silent export). Distinct from a demux/decode error
 * on a corrupt or unsupported file, which must NOT be cached as "no waveform". */
const NO_AUDIO_RE = /does not contain any stream|matches no streams|Output file is empty/i;

/** Decode an asset's audio to normalized timeline peaks via a single ffmpeg pass
 * (mono 8 kHz f32le → stdout). Streams the object to a temp file first so seeky
 * containers (mp4 with a trailing moov) decode correctly.
 *
 * Exit code is honoured (review follow-up): empty stdout is only treated as a
 * legitimate "no audio track" → [] when ffmpeg exits 0 or fails with a no-stream
 * signature. A genuine decode failure (corrupt/unsupported input → non-zero exit
 * with a different error) THROWS, so the route returns 502 and the client falls
 * back to its in-browser decode instead of caching a wrong empty waveform. */
async function decodePeaks(minio: MinioClient, bucket: string, key: string): Promise<number[]> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-peaks-'));
  const file = join(dir, 'src');
  try {
    await pipeline(await minio.getObject(bucket, key), createWriteStream(file));
    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: Buffer;
      stderr: string;
    }>((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const ff = spawn(
        'ffmpeg',
        ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      (ff.stdout as unknown as EventEmitter).on('data', (c: Buffer) => out.push(c));
      (ff.stderr as unknown as EventEmitter).on('data', (c: Buffer) => err.push(c));
      ff.on('error', reject); // ffmpeg missing / spawn failure → 502
      ff.on('close', (c) =>
        resolve({
          code: c,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
    });
    const n = Math.floor(stdout.length / 4);
    if (n > 0) {
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = stdout.readFloatLE(i * 4);
      return bucketPeaks(samples);
    }
    // Empty stdout: a clean run with no audio (code 0) or a no-stream failure is
    // a real "no waveform"; anything else is a decode error worth surfacing.
    if (code === 0 || NO_AUDIO_RE.test(stderr)) return [];
    throw new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Filmstrip sprite geometry — a fixed grid sampled evenly across the asset.
// The client renders N display cells, each picking the nearest sprite frame to
// the cell's time, so one cached image serves any trim/width (review #1: stop
// opening many <video> elements per clip on the timeline).
const FILMSTRIP_COLS = 5;
const FILMSTRIP_ROWS = 4;
const FILMSTRIP_COUNT = FILMSTRIP_COLS * FILMSTRIP_ROWS;

/** ffprobe an asset's duration (seconds); 0 if it can't be determined. */
function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve) => {
    let out = '';
    const ff = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    (ff.stdout as unknown as EventEmitter).on('data', (c: Buffer) => (out += c.toString()));
    ff.on('error', () => resolve(0));
    ff.on('close', () => {
      const d = Number.parseFloat(out.trim());
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    });
  });
}

/** Render a tiled JPEG filmstrip sprite (FILMSTRIP_COUNT frames sampled evenly
 * across the asset) via one ffmpeg pass. Oversamples slightly so the grid always
 * fills (no black trailing cells). Throws on probe/decode failure so the route
 * returns 502 and the client falls back to its in-browser seeked frames. */
async function renderFilmstrip(minio: MinioClient, bucket: string, key: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'seed-strip-'));
  const src = join(dir, 'src');
  const out = join(dir, 'strip.jpg');
  try {
    await pipeline(await minio.getObject(bucket, key), createWriteStream(src));
    const dur = await ffprobeDuration(src);
    if (dur <= 0) throw new Error('filmstrip: could not probe duration');
    const fps = (FILMSTRIP_COUNT + 1) / dur; // +1 → never under-fill the grid
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
      (resolve, reject) => {
        const err: Buffer[] = [];
        const ff = spawn(
          'ffmpeg',
          [
            '-v',
            'error',
            '-i',
            src,
            '-frames:v',
            '1',
            '-vf',
            `fps=${fps.toFixed(6)},scale=160:-1,tile=${FILMSTRIP_COLS}x${FILMSTRIP_ROWS}`,
            '-q:v',
            '5',
            out,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        (ff.stderr as unknown as EventEmitter).on('data', (c: Buffer) => err.push(c));
        ff.on('error', reject);
        ff.on('close', (c) => resolve({ code: c, stderr: Buffer.concat(err).toString('utf8') }));
      },
    );
    if (code !== 0)
      throw new Error(`ffmpeg filmstrip exit ${code}: ${stderr.trim().slice(0, 200)}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function setupStudioRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  opts: { redis?: IORedis } = {},
): void {
  const minioEndpoint = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
  const bucket = process.env.MINIO_BUCKET ?? 'seed-assets';
  // Browser-reachable origin for minted asset URLs (the API proxies
  // /<bucket>/*). Footgun guard: a freshly-uploaded clip is loaded by the
  // browser immediately for preview, so the origin MUST be loadable from the
  // app's page. If the app is served over https (API_PUBLIC_URL) but
  // ASSET_PUBLIC_URL is a plain-http origin (e.g. a bare MinIO IP), the browser
  // blocks it as mixed content — so fall back to the app's own https origin,
  // which serves the same bytes through the proxy. A proper https
  // ASSET_PUBLIC_URL (CDN / asset domain) is always honoured.
  const apiPublic = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
  const assetPublic = process.env.ASSET_PUBLIC_URL?.replace(/\/$/, '');
  const mixedContentBlocked =
    !!assetPublic && assetPublic.startsWith('http://') && !!apiPublic?.startsWith('https://');
  const publicBase = (
    (assetPublic && !mixedContentBlocked ? assetPublic : undefined) ??
    apiPublic ??
    process.env.MINIO_PUBLIC_URL ??
    minioEndpoint
  ).replace(/\/$/, '');
  const minio = new MinioClient(resolveS3ClientOptions(process.env));
  const checkUploadRate = async (
    reply: FastifyReply,
    userId: string,
    rateBucket = 'studio-upload',
    max = UPLOAD_RATE_LIMIT_MAX,
  ): Promise<boolean> => {
    if (!opts.redis) return true;
    const rl = await checkPerUserRateLimit(opts.redis, userId, rateBucket, max);
    reply.header('x-ratelimit-limit', String(max));
    reply.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) {
      reply.status(429).send({ error: 'rate_limit_exceeded' });
      return false;
    }
    return true;
  };

  // Dedicated parser for upload chunks: a buffer bounded to one part, kept
  // separate from the generic octet-stream parser so the part ceiling can't
  // widen (or narrow) the other upload routes. One part in memory at a time.
  app.addContentTypeParser(
    PART_CONTENT_TYPE,
    { parseAs: 'buffer', bodyLimit: PART_SIZE + 4 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // List the temp chunk keys already stored for an upload (resume + assemble).
  const listPartKeys = (prefix: string): Promise<string[]> =>
    new Promise((resolve, reject) => {
      const keys: string[] = [];
      const stream = minio.listObjectsV2(bucket, prefix, true);
      stream.on('data', (o) => {
        if (o.name) keys.push(o.name);
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  const listPartIndices = async (prefix: string): Promise<number[]> =>
    (await listPartKeys(prefix))
      .map((k) => Number.parseInt(k.slice(prefix.length), 10))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);

  // Self-heal the anonymous-read policy the browser relies on to load assets by
  // URL. The worker sets this too, but only lazily on its first put() and with a
  // swallowed error — so a rebuilt MinIO (as happened on the rescue host) leaves
  // every asset 403ing until a render runs. The API mints upload URLs that
  // depend on this, so ensure it on boot. Idempotent; keys stay unguessable.
  //
  // On managed S3 (PORT-3) the bucket stays PRIVATE — the CDN/edge serves it
  // with origin credentials — so S3_ANONYMOUS_BUCKET_POLICY=false makes this a
  // no-op rather than a refused public-access call.
  if (anonymousBucketPolicyEnabled(process.env)) {
    void (async () => {
      try {
        await minio.setBucketPolicy(
          bucket,
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: ['*'] },
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${bucket}/*`],
              },
            ],
          }),
        );
      } catch (err) {
        app.log.error({ err }, 'studio: failed to ensure asset bucket read policy');
      }
    })();
  }

  // Source bin: the caller's generated assets, newest first. ?kind=image|video
  // (default video) so the studio and the generate source pickers can reuse it.
  const clipsQuerySchema = z
    .object({
      // Keep the legacy fallback: only the exact `image` value switches bins;
      // every other/missing kind still means video.
      kind: z.string().max(32).optional(),
      projectId: workspaceProjectIdSchema.optional(),
    })
    .passthrough();
  app.get<{ Querystring: { kind?: string; projectId?: string } }>(
    '/v1/studio/clips',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = clipsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
      const kind = parsed.data.kind === 'image' ? 'image' : 'video';
      const projectId = parsed.data.projectId;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const projection = {
        id: galleryItems.id,
        assetUrl: galleryItems.assetUrl,
        createdAt: galleryItems.createdAt,
      };
      const now = new Date();
      const where = and(
        availableOwnedAssetCondition(session.user.id, now),
        eq(galleryItems.kind, kind),
      );
      const rows = projectId
        ? await db
            .select(projection)
            .from(galleryItems)
            .innerJoin(
              projectAssets,
              and(
                eq(projectAssets.assetId, galleryItems.id),
                eq(projectAssets.projectId, projectId),
                eq(projectAssets.userId, session.user.id),
              ),
            )
            .where(where)
            .orderBy(desc(galleryItems.createdAt))
            .limit(100)
        : await db
            .select(projection)
            .from(galleryItems)
            .where(where)
            .orderBy(desc(galleryItems.createdAt))
            .limit(100);
      return { clips: rows };
    },
  );

  // Generic media upload (image/video/audio) for reference inputs. Raw bytes in,
  // proxy URL out. Reuses the octet-stream body parser registered in server.ts.
  const CT: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
  };
  app.post<{ Querystring: { ext?: string } }>(
    '/v1/studio/upload',
    { bodyLimit: 64 * 1024 * 1024 },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (!(await checkUploadRate(reply, session.user.id))) return;
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_body' });
      }
      const ext = (req.query.ext ?? 'png')
        .replace(/[^a-z0-9]/gi, '')
        .slice(0, 5)
        .toLowerCase();
      if (!CT[ext]) return reply.status(415).send({ error: 'unsupported_ext' });
      const kind = CT[ext].startsWith('image')
        ? 'image'
        : CT[ext].startsWith('video')
          ? 'video'
          : 'audio';
      if (!matchesDeclaredMediaType(ext, body)) {
        return reply.status(415).send({ error: 'invalid_media_type' });
      }
      const key = `${session.user.id}/${kind}/${randomUUID()}.${ext}`;
      await minio.putObject(bucket, key, body, body.length, { 'Content-Type': CT[ext]! });
      return { url: `${publicBase}/${bucket}/${key}`, kind };
    },
  );

  // Timeline waveform peaks (review #1: stop downloading whole media in the
  // browser just to draw a waveform — a 4-min 1080p clip is hundreds of MB, and
  // a real project has many). The API decodes the asset's audio ONCE with ffmpeg
  // and caches a tiny peaks JSON next to it in MinIO; every later load (reload,
  // re-select, another trim of the same source) is an O(1) object fetch. Only
  // the caller's own MinIO assets qualify; anything else (dev statics, blob:
  // URLs, a foreign key) 4xx's and the client falls back to its in-browser
  // decode — so this is a pure performance upgrade with a safety net. Pure
  // timeline chrome: no render path touched, preview==export untouched.
  app.get<{ Querystring: { url?: string } }>('/v1/studio/peaks', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const url = (req.query.url ?? '').trim();
    const marker = `/${bucket}/`;
    const at = url.indexOf(marker);
    if (!url || at === -1) return reply.status(400).send({ error: 'not_an_asset' });
    const key = decodeURIComponent(url.slice(at + marker.length).split('?')[0] ?? '');
    if (!key.startsWith(`${session.user.id}/`)) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    const segKind = key.split('/')[1];
    if (segKind !== 'audio' && segKind !== 'video') {
      return reply.status(415).send({ error: 'no_audio_track' });
    }
    const peaksKey = `${key}.peaks.json`;
    try {
      await minio.statObject(bucket, peaksKey);
      const cached = await streamToBuffer(await minio.getObject(bucket, peaksKey));
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(JSON.parse(cached.toString('utf8')));
    } catch {
      /* cache miss → decode below */
    }
    let peaks: number[];
    try {
      peaks = await decodePeaks(minio, bucket, key);
    } catch (err) {
      app.log.error({ err, key }, 'studio: peaks decode failed');
      return reply.status(502).send({ error: 'peaks_failed' });
    }
    const payload = JSON.stringify({ peaks });
    void minio
      .putObject(bucket, peaksKey, Buffer.from(payload), Buffer.byteLength(payload), {
        'Content-Type': 'application/json',
      })
      .catch((err) => app.log.error({ err, peaksKey }, 'studio: peaks cache write failed'));
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send({ peaks });
  });

  // Timeline filmstrip sprite (review #1: a clip used to open up to 8 <video>
  // elements per clip, so a real multi-clip timeline spawned hundreds and hit
  // the browser's media-element cap). The API tiles ~20 frames into ONE JPEG via
  // ffmpeg, caches it as a `*.strip.jpg` sidecar in MinIO, and returns its URL +
  // grid; the client renders frame cells as background-position slices of that
  // single image. Same scoping/fallback discipline as the peaks sidecar; pure
  // timeline chrome, no render path touched.
  app.get<{ Querystring: { url?: string } }>('/v1/studio/filmstrip', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const url = (req.query.url ?? '').trim();
    const marker = `/${bucket}/`;
    const at = url.indexOf(marker);
    if (!url || at === -1) return reply.status(400).send({ error: 'not_an_asset' });
    const key = decodeURIComponent(url.slice(at + marker.length).split('?')[0] ?? '');
    if (!key.startsWith(`${session.user.id}/`)) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    if (key.split('/')[1] !== 'video') {
      return reply.status(415).send({ error: 'not_video' });
    }
    const stripKey = `${key}.strip.jpg`;
    const meta = {
      sprite: `${publicBase}/${bucket}/${stripKey}`,
      cols: FILMSTRIP_COLS,
      rows: FILMSTRIP_ROWS,
      count: FILMSTRIP_COUNT,
    };
    try {
      await minio.statObject(bucket, stripKey);
      reply.header('Cache-Control', 'private, max-age=31536000, immutable');
      return reply.send(meta);
    } catch {
      /* cache miss → render below */
    }
    let jpeg: Buffer;
    try {
      jpeg = await renderFilmstrip(minio, bucket, key);
    } catch (err) {
      app.log.error({ err, key }, 'studio: filmstrip render failed');
      return reply.status(502).send({ error: 'filmstrip_failed' });
    }
    // The sprite must exist before the client loads its URL, so await the write.
    try {
      await minio.putObject(bucket, stripKey, jpeg, jpeg.length, { 'Content-Type': 'image/jpeg' });
    } catch (err) {
      app.log.error({ err, stripKey }, 'studio: filmstrip cache write failed');
      return reply.status(502).send({ error: 'filmstrip_store_failed' });
    }
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    return reply.send(meta);
  });

  // ── Resumable multipart video upload ──────────────────────────────────────
  // init → (part × N) → complete. State is implicit: temp chunks live under
  // `_mp/${userId}/${uploadId}/` (userId from the session), so a user can only
  // ever touch their own upload, a dropped connection resumes by re-listing what
  // landed, and a lifecycle rule on the `_mp/` prefix sweeps abandoned chunks.

  // 1) Reserve an upload id and tell the client how to slice the file.
  app.post('/v1/studio/upload/init', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!(await checkUploadRate(reply, session.user.id))) return;
    const parsed = z
      .object({ ext: z.string(), size: z.number().int().positive().max(MAX_UPLOAD_BYTES) })
      .safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_init' });
    const ext = sanitizeExt(parsed.data.ext);
    if (!VIDEO_EXTS.has(ext)) return reply.status(415).send({ error: 'unsupported_ext' });
    const parts = Math.ceil(parsed.data.size / PART_SIZE);
    if (parts > MAX_PARTS) return reply.status(413).send({ error: 'too_large' });
    return { uploadId: randomUUID(), partSize: PART_SIZE, parts };
  });

  // 2) Store one chunk. Streamed in via the dedicated part parser (bounded to a
  //    single part), then written to its temp object keyed by index.
  app.put<{ Querystring: { uploadId?: string; index?: string } }>(
    '/v1/studio/upload/part',
    { bodyLimit: PART_SIZE + 4 * 1024 * 1024 },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (
        !(await checkUploadRate(
          reply,
          session.user.id,
          'studio-upload-part',
          UPLOAD_PART_RATE_LIMIT_MAX,
        ))
      )
        return;
      const uploadId = String(req.query.uploadId ?? '');
      if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'bad_upload_id' });
      const index = Number(req.query.index);
      if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS) {
        return reply.status(400).send({ error: 'bad_index' });
      }
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_part' });
      }
      await minio.putObject(bucket, partKey(session.user.id, uploadId, index), body, body.length, {
        'Content-Type': 'application/octet-stream',
      });
      return { ok: true, index };
    },
  );

  // 3) Which chunks already landed — lets the client skip them on resume.
  app.get<{ Querystring: { uploadId?: string } }>(
    '/v1/studio/upload/status',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const uploadId = String(req.query.uploadId ?? '');
      if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'bad_upload_id' });
      const parts = await listPartIndices(mpPrefix(session.user.id, uploadId));
      return { parts };
    },
  );

  // 4) Assemble the chunks into the final asset (server-side compose) and sweep
  //    the temps. Refuses if any part is missing so we never stitch a hole.
  app.post('/v1/studio/upload/complete', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!(await checkUploadRate(reply, session.user.id))) return;
    const parsed = z
      .object({
        uploadId: z.string(),
        ext: z.string(),
        parts: z.number().int().positive().max(MAX_PARTS),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_complete' });
    const { uploadId, parts } = parsed.data;
    if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'bad_upload_id' });
    const ext = sanitizeExt(parsed.data.ext);
    if (!VIDEO_EXTS.has(ext)) return reply.status(415).send({ error: 'unsupported_ext' });
    const userId = session.user.id;
    const present = new Set(await listPartIndices(mpPrefix(userId, uploadId)));
    for (let i = 0; i < parts; i++) {
      if (!present.has(i)) return reply.status(409).send({ error: 'missing_part', index: i });
    }
    const finalKey = `${userId}/video/${uploadId}.${ext}`;
    const firstPart = await streamToBuffer(
      await minio.getObject(bucket, partKey(userId, uploadId, 0)),
    );
    if (!matchesDeclaredMediaType(ext, firstPart)) {
      return reply.status(415).send({ error: 'invalid_media_type' });
    }
    const sources = Array.from(
      { length: parts },
      (_, i) => new CopySourceOptions({ Bucket: bucket, Object: partKey(userId, uploadId, i) }),
    );
    try {
      // Stamp the real video content-type on the assembled object — chunks are
      // stored as octet-stream, and the browser (with nosniff) won't decode a
      // video served as binary/octet-stream.
      await minio.composeObject(
        new CopyDestinationOptions({
          Bucket: bucket,
          Object: finalKey,
          Headers: { 'Content-Type': VIDEO_CT[ext] ?? 'video/mp4' },
          MetadataDirective: 'REPLACE',
        }),
        sources,
      );
    } catch (err) {
      req.log.error({ err, uploadId }, 'studio upload compose failed');
      return reply.status(500).send({ error: 'compose_failed' });
    }
    await minio
      .removeObjects(
        bucket,
        Array.from({ length: parts }, (_, i) => partKey(userId, uploadId, i)),
      )
      .catch(() => {});
    return { url: `${publicBase}/${bucket}/${finalKey}`, kind: 'video' };
  });

  // Discard an in-flight upload's temp chunks (client cancel / cleanup).
  app.post('/v1/studio/upload/abort', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!(await checkUploadRate(reply, session.user.id))) return;
    const uploadId = String((req.body as { uploadId?: string } | undefined)?.uploadId ?? '');
    if (!UPLOAD_ID_RE.test(uploadId)) return reply.status(400).send({ error: 'bad_upload_id' });
    const keys = await listPartKeys(mpPrefix(session.user.id, uploadId));
    if (keys.length) await minio.removeObjects(bucket, keys).catch(() => {});
    return { ok: true };
  });

  // Upload an audio line (raw bytes). Stored in the assets bucket; served via
  // the public proxy so ffmpeg can read it during render.
  app.post<{ Querystring: { ext?: string } }>(
    '/v1/studio/upload-audio',
    { bodyLimit: 52_428_800 },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (!(await checkUploadRate(reply, session.user.id))) return;
      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_body' });
      }
      if (body.length > 50 * 1024 * 1024) {
        return reply.status(413).send({ error: 'too_large' });
      }
      const ext = sanitizeExt(req.query.ext ?? 'mp3') || 'mp3';
      const ctMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
      };
      if (!ctMap[ext]) return reply.status(415).send({ error: 'unsupported_ext' });
      if (!matchesDeclaredMediaType(ext, body)) {
        return reply.status(415).send({ error: 'invalid_media_type' });
      }
      const key = `${session.user.id}/audio/${randomUUID()}.${ext}`;
      await minio.putObject(bucket, key, body, body.length, {
        'Content-Type': ctMap[ext]!,
      });
      return { url: `${publicBase}/${bucket}/${key}` };
    },
  );

  function isUserStudioAsset(url: string, userId: string): boolean {
    const prefix = `${publicBase}/${bucket}/${userId}/`;
    return url.startsWith(prefix);
  }

  /**
   * BL-4: every URL fed to the render worker (clips, overlays, audio lines)
   * must belong to this user — either an own-origin studio upload
   * (`isUserStudioAsset`) or one of their own gallery assets. Otherwise the
   * ffmpeg farm becomes an SSRF/egress proxy (e.g. `http://169.254.169.254/…`
   * or arbitrary external fetch). Returns the first non-owned URL, or null when
   * every URL is owned.
   */
  async function firstUnownedRenderUrl(urls: string[], userId: string): Promise<string | null> {
    const unique = [...new Set(urls)];
    const needGallery = unique.filter((u) => !isUserStudioAsset(u, userId));
    if (needGallery.length === 0) return null;
    const rows = await db
      .select({ assetUrl: galleryItems.assetUrl })
      .from(galleryItems)
      .where(
        and(
          availableOwnedAssetCondition(userId, new Date()),
          inArray(galleryItems.assetUrl, needGallery),
        ),
      );
    const owned = new Set(rows.map((r) => r.assetUrl));
    return needGallery.find((u) => !owned.has(u)) ?? null;
  }

  // Auto-caption a clip's audio. Provider-backed only for assets that belong to
  // this user; otherwise arbitrary URLs could burn ASR spend outside Studio.
  app.post('/v1/studio/captions', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = req.body as { clipUrl?: string; language?: string } | undefined;
    const clipUrl = body?.clipUrl;
    const language = typeof body?.language === 'string' ? body.language : undefined;
    if (typeof clipUrl !== 'string' || !clipUrl) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    // Cap ASR submits so a caller can't exhaust provider spend.
    if (opts.redis) {
      const rl = await checkPerUserRateLimit(
        opts.redis,
        session.user.id,
        'studio-captions',
        CAPTIONS_RATE_LIMIT_MAX,
      );
      reply.header('x-ratelimit-limit', String(CAPTIONS_RATE_LIMIT_MAX));
      reply.header('x-ratelimit-remaining', String(rl.remaining));
      if (!rl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }

    const owned =
      isUserStudioAsset(clipUrl, session.user.id) ||
      (
        await db
          .select({ id: galleryItems.id })
          .from(galleryItems)
          .where(
            and(
              availableOwnedAssetCondition(session.user.id, new Date()),
              eq(galleryItems.assetUrl, clipUrl),
              eq(galleryItems.kind, 'video'),
            ),
          )
          .limit(1)
      )[0];
    if (!owned) return reply.status(403).send({ error: 'asset_not_owned' });

    const asrFactory = createAsrFactory(process.env, {
      groqFetch: egressFetch as unknown as typeof fetch,
    });

    const provider = asrFactory.forLanguage(language);
    if (!provider) {
      // No ASR provider configured — return a demo stub so the pipeline is
      // testable. Fake per-word timings ride along so word-pop captions («по
      // словам») are exercisable without any provider key.
      return {
        stub: true,
        segments: [
          {
            text: 'Авто-субтитры (демо)',
            startSec: 0,
            endSec: 2,
            words: [
              { word: 'Авто-субтитры', startSec: 0, endSec: 1 },
              { word: '(демо)', startSec: 1, endSec: 2 },
            ],
          },
          {
            text: 'Настройте WHISPER_SERVER_URL для расшифровки',
            startSec: 2,
            endSec: 4,
            words: [
              { word: 'Настройте', startSec: 2, endSec: 2.7 },
              { word: 'WHISPER_SERVER_URL', startSec: 2.7, endSec: 3.4 },
              { word: 'для', startSec: 3.4, endSec: 3.6 },
              { word: 'расшифровки', startSec: 3.6, endSec: 4 },
            ],
          },
        ],
      };
    }

    try {
      const segments = await provider.transcribe(clipUrl, language);
      return { stub: false, segments };
    } catch {
      return reply.status(502).send({ error: 'asr_failed' });
    }
  });

  // Studio AI voice generation is intentionally parked until its workbook COGS,
  // customer price, reserve/commit/refund path, and provider fallback are approved.
  // Manual voiceover uploads and timeline playback remain available.
  app.post('/v1/studio/tts', async (_req, reply) => {
    return reply.status(410).send({ error: 'studio_tts_disabled' });
  });

  // Create a render: persist the edit-decision doc + enqueue the ffmpeg job.
  app.post('/v1/studio/render', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    // Guest-CJM (owner decision 2026-07-09): a «Гость» edits and previews
    // freely, but the render farm needs a real account — export stays free
    // AFTER signup (retention hook), and anonymous sessions can't burn ffmpeg
    // slots. Same wall shape as generation/assist (jobs-routes, script-assist).
    if (session.user.isAnonymous) {
      return reply.status(403).send({ error: 'signup_required' });
    }

    // BL-2: per-user submit throttle (Redis INCR — real client identity, not
    // the shared proxy IP). Generous; this is an abuse ceiling.
    if (opts.redis) {
      const rl = await checkPerUserRateLimit(
        opts.redis,
        session.user.id,
        'studio-render',
        RENDER_RATE_LIMIT_MAX,
      );
      reply.header('x-ratelimit-limit', String(RENDER_RATE_LIMIT_MAX));
      reply.header('x-ratelimit-remaining', String(rl.remaining));
      if (!rl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }

    const parsed = renderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const d = parsed.data;

    if (d.projectId) {
      const project = await validateOwnedLiveProject(db, d.projectId, session.user.id);
      if (!project) return reply.status(404).send({ error: 'not_found' });
    }

    // BL-2: reject an oversized timeline before it reaches the 2-slot pool.
    const maxSeconds = Number(process.env.STUDIO_MAX_RENDER_SECONDS ?? RENDER_MAX_SECONDS_DEFAULT);
    const declaredSeconds = declaredRenderSeconds(d);
    if (declaredSeconds > maxSeconds) {
      return reply.status(400).send({
        error: 'render_too_long',
        declaredSeconds: Math.round(declaredSeconds),
        maxSeconds,
      });
    }

    // The worker downscales to a 1920 cap with a 64px floor per side, so an
    // aspect ratio steeper than 1920/64 = 30:1 cannot preserve aspect within both
    // bounds (the floor would stretch the short side). The schema allows 64–3840
    // per axis, so reject the degenerate ratio here rather than render a distorted
    // frame. Real formats top out around 21:9 (2.33:1); 30:1 is a wide margin.
    const maxAspect = Math.max(d.width, d.height) / Math.min(d.width, d.height);
    if (maxAspect > 1920 / 64) {
      return reply.status(400).send({ error: 'render_bad_aspect', maxAspect: 30 });
    }

    // The worker composites at most GUARD_TRACK_LAYER_CAP upper-track clips and
    // drops the rest — reject an over-cap spec instead of silently losing layers.
    const trackClipCount = (d.tracks ?? []).reduce((n, tr) => n + tr.length, 0);
    if (trackClipCount > GUARD_TRACK_LAYER_CAP) {
      return reply
        .status(400)
        .send({ error: 'too_many_track_clips', max: GUARD_TRACK_LAYER_CAP, got: trackClipCount });
    }

    // BL-2: cap simultaneous in-flight renders per user so one caller can't
    // monopolise the worker pool. Abuse ceiling, not a strict invariant.
    const inflightMax = Number(process.env.STUDIO_MAX_INFLIGHT_RENDERS ?? RENDER_INFLIGHT_DEFAULT);
    const active = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(
        and(
          eq(studioRenders.userId, session.user.id),
          inArray(studioRenders.status, ['queued', 'running']),
        ),
      )
      .limit(inflightMax + 1);
    if (active.length >= inflightMax) {
      return reply.status(429).send({ error: 'too_many_active_renders', limit: inflightMax });
    }

    // Stable gallery identities take precedence over stored URL snapshots.
    // Every omitted id is deliberately reported the same way (foreign,
    // missing, deleted, or reaped) so ownership cannot be probed.
    const identifiedClips = [...d.clips, ...(d.tracks ?? []).flatMap((track) => track)].filter(
      (clip): clip is typeof clip & { assetId: string } => !!clip.assetId,
    );
    const resolvedAssets = await resolveAvailableOwnedAssets(
      db,
      session.user.id,
      identifiedClips.map((clip) => clip.assetId),
    );
    const unavailableAssetIds = [
      ...new Set(
        identifiedClips
          .filter((clip) => !resolvedAssets.has(clip.assetId))
          .map((clip) => clip.assetId),
      ),
    ];
    if (unavailableAssetIds.length > 0) {
      return reply.status(409).send({
        error: 'asset_unavailable',
        assetIds: unavailableAssetIds,
        message: 'Материал недоступен. Замените его перед экспортом.',
      });
    }
    for (const clip of identifiedClips) {
      clip.url = resolvedAssets.get(clip.assetId)!.assetUrl;
    }

    // BL-4: every clip/overlay/audio URL must be owned by this user (SSRF).
    const renderUrls = [
      ...d.clips.map((c) => c.url),
      ...(d.tracks ?? []).flatMap((tr) => tr.map((c) => c.url)),
      ...(d.overlays ?? []).map((o) => o.url),
      ...(d.audio?.url ? [d.audio.url] : []),
      ...(d.music?.url ? [d.music.url] : []),
      ...(d.voiceover?.url ? [d.voiceover.url] : []),
      ...(d.sfx ?? []).map((s) => s.url),
    ];
    const unowned = await firstUnownedRenderUrl(renderUrls, session.user.id);
    if (unowned !== null) {
      return reply.status(400).send({ error: 'asset_not_owned', url: unowned });
    }
    const track = (
      t:
        | {
            url: string;
            gainDb?: number | undefined;
            fromSec?: number | undefined;
            fadeIn?: boolean | undefined;
            fadeOut?: boolean | undefined;
            duck?:
              | {
                  db: number;
                  segments: { fromSec: number; toSec: number }[];
                  sourceKey?: string | undefined;
                }
              | undefined;
          }
        | null
        | undefined,
    ) =>
      t
        ? {
            url: t.url,
            ...(t.gainDb !== undefined ? { gainDb: t.gainDb } : {}),
            ...(t.fromSec !== undefined ? { fromSec: t.fromSec } : {}),
            ...(t.fadeIn !== undefined ? { fadeIn: t.fadeIn } : {}),
            ...(t.fadeOut !== undefined ? { fadeOut: t.fadeOut } : {}),
            ...(t.duck !== undefined
              ? {
                  duck: {
                    db: t.duck.db,
                    segments: t.duck.segments,
                    ...(t.duck.sourceKey !== undefined ? { sourceKey: t.duck.sourceKey } : {}),
                  },
                }
              : {}),
          }
        : null;
    const toSpecClip = (c: z.infer<typeof clipSchema>): StudioClip =>
      compactJson({
        url: c.url,
        ...(c.inSec !== undefined ? { inSec: c.inSec } : {}),
        ...(c.outSec !== undefined ? { outSec: c.outSec } : {}),
        ...(c.speed !== undefined ? { speed: c.speed } : {}),
        ...(c.speedCurve !== undefined ? { speedCurve: c.speedCurve } : {}),
        ...(c.animIn !== undefined ? { animIn: c.animIn } : {}),
        ...(c.animOut !== undefined ? { animOut: c.animOut } : {}),
        ...(c.keyframes !== undefined ? { keyframes: c.keyframes } : {}),
        ...(c.muted !== undefined ? { muted: c.muted } : {}),
        ...(c.volumeDb !== undefined ? { volumeDb: c.volumeDb } : {}),
        ...(c.transition !== undefined ? { transition: c.transition } : {}),
        ...(c.transitionSec !== undefined ? { transitionSec: c.transitionSec } : {}),
        ...(c.filter !== undefined ? { filter: c.filter } : {}),
        ...(c.transform !== undefined ? { transform: c.transform } : {}),
        ...(c.color !== undefined ? { color: c.color } : {}),
        ...(c.reversed !== undefined ? { reversed: c.reversed } : {}),
        ...(c.flipH !== undefined ? { flipH: c.flipH } : {}),
        ...(c.flipV !== undefined ? { flipV: c.flipV } : {}),
        ...(c.freeze !== undefined ? { freeze: c.freeze } : {}),
        ...(c.mask !== undefined ? { mask: c.mask } : {}),
        ...(c.opacity !== undefined ? { opacity: c.opacity } : {}),
        ...(c.blendMode !== undefined ? { blendMode: c.blendMode } : {}),
        ...(c.startSec !== undefined ? { startSec: c.startSec } : {}),
      }) as StudioClip;
    // Upper-track clips composite as flat alpha layers (static overlays). The
    // worker can't honour instruments that assume opaque-over-black compositing on
    // an alpha layer: a mask/blend need lower-layer compositing, and the output-
    // time MOTION filters (keyframes, entrance/exit anims) pad/rotate/opacity with
    // OPAQUE black or drop the alpha channel — so an animated upper clip renders a
    // black rectangle. Strip them so the stored spec reflects what actually renders
    // (static transform/opacity/color/trim/speed still apply). The preview matches
    // (PreviewStage renders upper clips static too). Animated upper tracks are
    // deferred Phase-II work (needs alpha-safe motion filters).
    const toSpecTrackClip = (c: z.infer<typeof clipSchema>): StudioClip => {
      const {
        mask: _mask,
        blendMode: _blend,
        keyframes: _kf,
        animIn: _in,
        animOut: _out,
        ...rest
      } = toSpecClip(c);
      return rest;
    };
    const spec: StudioRenderSpec = {
      clips: d.clips.map(toSpecClip),
      ...(d.tracks ? { tracks: d.tracks.map((tr) => tr.map(toSpecTrackClip)) } : {}),
      overlays: (d.overlays ?? []).map(
        (o): StudioOverlayClip =>
          compactJson({
            url: o.url,
            atSec: o.atSec,
            ...(o.inSec !== undefined ? { inSec: o.inSec } : {}),
            ...(o.outSec !== undefined ? { outSec: o.outSec } : {}),
            ...(o.scale !== undefined ? { scale: o.scale } : {}),
            ...(o.posX !== undefined ? { posX: o.posX } : {}),
            ...(o.posY !== undefined ? { posY: o.posY } : {}),
            ...(o.opacity !== undefined ? { opacity: o.opacity } : {}),
            ...(o.muted !== undefined ? { muted: o.muted } : {}),
            ...(o.gainDb !== undefined ? { gainDb: o.gainDb } : {}),
          }) as StudioOverlayClip,
      ),
      audio: track(d.audio),
      music: track(d.music),
      voiceover: track(d.voiceover),
      ...(d.sfx
        ? {
            sfx: d.sfx.map(
              (s): StudioSfx =>
                compactJson({
                  url: s.url,
                  atSec: s.atSec,
                  ...(s.gainDb !== undefined ? { gainDb: s.gainDb } : {}),
                }) as StudioSfx,
            ),
          }
        : {}),
      texts: (d.texts ?? []).map((t) => ({
        text: t.text,
        fromSec: t.fromSec,
        toSec: t.toSec,
        position: t.position,
        ...(t.sizeFrac !== undefined ? { sizeFrac: t.sizeFrac } : {}),
        ...(t.font !== undefined ? { font: t.font } : {}),
        ...(t.fade !== undefined ? { fade: t.fade } : {}),
        ...(t.plate !== undefined ? { plate: t.plate } : {}),
      })),
      ...(d.popText !== undefined
        ? {
            popText: compactJson({
              ...(d.popText.font !== undefined ? { font: d.popText.font } : {}),
              ...(d.popText.sizeFrac !== undefined ? { sizeFrac: d.popText.sizeFrac } : {}),
              ...(d.popText.position !== undefined ? { position: d.popText.position } : {}),
              ...(d.popText.plate !== undefined ? { plate: d.popText.plate } : {}),
              words: d.popText.words.map((w) => ({
                text: w.text,
                fromSec: w.fromSec,
                toSec: w.toSec,
              })),
            }) as NonNullable<StudioRenderSpec['popText']>,
          }
        : {}),
      width: d.width,
      height: d.height,
      fps: d.fps,
      ...(d.format !== undefined ? { format: d.format } : {}),
      ...(d.background !== undefined
        ? {
            background: d.background.color
              ? { type: d.background.type, color: d.background.color }
              : { type: d.background.type },
          }
        : {}),
      ...(d.coverSec !== undefined ? { coverSec: d.coverSec } : {}),
    };
    const renderId = nid();
    await db.transaction(async (tx) => {
      await tx.insert(studioRenders).values({
        id: renderId,
        userId: session.user.id,
        projectId: d.projectId ?? null,
        spec,
      });
      await enqueueViaOutbox({
        tx,
        queueName: STUDIO_RENDER_QUEUE,
        jobId: `render-${renderId}`,
        payload: { renderId },
      });
    });
    return reply.status(201).send({ renderId, status: 'queued' });
  });

  // ---- Studio projects: multiple named compositions per user (mirrors boards),
  // plus one reserved "scratch" row the quick `/studio` editor and the
  // generate/boards hand-off write to. `timeline` is opaque, size-capped editor
  // state; a monotonic `__rev` rides inside it (last-writer-wins) so a slow
  // debounced save can't clobber a newer one. ----
  const PROJECT_MAX_BYTES = 262_144; // 256 KiB of editor state is plenty
  const PROJECT_MAX_COUNT = 50;
  const projectResolverParamsSchema = z.object({ projectId: workspaceProjectIdSchema });
  /** Stable per-user scratch project id — the slot behind the legacy singular
   *  endpoint, so upserts target a primary key (no unique-on-user_id needed). */
  const scratchId = (userId: string) => `scratch-${userId}`;

  /** Stamp the monotonic rev into the timeline blob, or null to skip a stale
   *  write. Returns the value to persist, or 'skip' when rev <= stored. */
  function stampRev(timeline: unknown, rev: number | null, storedRev: number): unknown | 'skip' {
    if (rev === null) return timeline;
    if (rev <= storedRev) return 'skip';
    return { ...(timeline as object), __rev: rev };
  }

  // Legacy singular endpoint — the scratch project. GET returns a null timeline
  // when never saved; PUT upserts the reserved row by primary key.
  app.get('/v1/studio/project', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select({ timeline: studioProjects.timeline, updatedAt: studioProjects.updatedAt })
      .from(studioProjects)
      .where(eq(studioProjects.id, scratchId(session.user.id)))
      .limit(1);
    return rows[0] ?? { timeline: null, updatedAt: null };
  });

  app.put('/v1/studio/project', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = req.body as { timeline?: unknown; rev?: unknown } | undefined;
    const timeline = body?.timeline;
    if (timeline === undefined || JSON.stringify(timeline).length > PROJECT_MAX_BYTES) {
      return reply.status(400).send({ error: 'invalid_timeline' });
    }
    const id = scratchId(session.user.id);
    const rev = typeof body?.rev === 'number' && Number.isFinite(body.rev) ? body.rev : null;
    let stamped: unknown = timeline;
    if (rev !== null) {
      const existing = await db
        .select({ timeline: studioProjects.timeline })
        .from(studioProjects)
        .where(eq(studioProjects.id, id))
        .limit(1);
      const storedRev = (existing[0]?.timeline as { __rev?: number } | null)?.__rev ?? -1;
      const next = stampRev(timeline, rev, storedRev);
      if (next === 'skip') return { ok: true, skipped: true };
      stamped = next;
    }
    await db.transaction(async (tx) => {
      await tx
        .insert(studioProjects)
        .values({
          id,
          userId: session.user.id,
          title: 'Быстрый монтаж',
          timeline: stamped,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: studioProjects.id,
          set: { timeline: stamped, updatedAt: new Date() },
        });
      await syncAssetReferences(tx, {
        userId: session.user.id,
        refType: 'studio_clip',
        resourceId: id,
        references: studioTimelineAssetReferences(stamped),
      });
    });
    return { ok: true };
  });

  // List the user's projects (newest first) for the gallery.
  const listProjectsSchema = z
    .object({
      projectId: workspaceProjectIdSchema.optional(),
      cursor: z.string().max(2_048).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict();
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/v1/studio/projects',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listProjectsSchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const { projectId, limit } = parsed.data;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const context = projectListContext(projectId);
      const cursor = parsed.data.cursor
        ? decodeProjectListCursor(parsed.data.cursor, {
            scope: 'studio',
            ownerId: session.user.id,
            context,
          })
        : null;
      if (parsed.data.cursor && !cursor) {
        return reply.status(400).send({ error: 'invalid_cursor' });
      }
      const rows = await db
        .select({
          id: studioProjects.id,
          projectId: studioProjects.projectId,
          title: studioProjects.title,
          createdAt: studioProjects.createdAt,
          updatedAt: studioProjects.updatedAt,
        })
        .from(studioProjects)
        .where(
          and(
            eq(studioProjects.userId, session.user.id),
            ...(projectId ? [eq(studioProjects.projectId, projectId)] : []),
            ...(cursor
              ? [
                  or(
                    lt(studioProjects.updatedAt, cursor.updatedAt),
                    and(
                      eq(studioProjects.updatedAt, cursor.updatedAt),
                      lt(studioProjects.id, cursor.id),
                    ),
                  )!,
                ]
              : []),
          ),
        )
        .orderBy(desc(studioProjects.updatedAt), desc(studioProjects.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const items = more ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          more && last
            ? encodeProjectListCursor({
                scope: 'studio',
                ownerId: session.user.id,
                context,
                updatedAt: last.updatedAt,
                id: last.id,
              })
            : null,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/resolve/studio',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = projectResolverParamsSchema.safeParse(req.params);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const projectId = parsed.data.projectId;
      const intent = `workspace-resolve:${session.user.id}:${projectId}:studio`;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${intent}))`);
        if (!(await validateOwnedLiveProject(tx, projectId, session.user.id))) {
          return { kind: 'not_found' as const };
        }
        const [existing] = await tx
          .select({ id: studioProjects.id })
          .from(studioProjects)
          .where(
            and(
              eq(studioProjects.userId, session.user.id),
              eq(studioProjects.projectId, projectId),
            ),
          )
          .orderBy(desc(studioProjects.updatedAt), desc(studioProjects.id))
          .limit(1);
        if (existing) return { kind: 'document' as const, id: existing.id };
        const count = await tx
          .select({ id: studioProjects.id })
          .from(studioProjects)
          .where(eq(studioProjects.userId, session.user.id));
        if (count.length >= PROJECT_MAX_COUNT) return { kind: 'limit' as const };
        const [created] = await tx
          .insert(studioProjects)
          .values({ id: nid(), userId: session.user.id, projectId, timeline: {} })
          .returning({ id: studioProjects.id });
        return { kind: 'document' as const, id: created!.id };
      });
      if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (outcome.kind === 'limit') return { destination: 'list' as const };
      return { destination: 'document' as const, id: outcome.id };
    },
  );

  // Create a new named project; client navigates to /studio/:id to edit it.
  const createProjectSchema = z.object({
    title: z.string().trim().min(1).max(80).optional(),
    projectId: workspaceProjectIdSchema.optional(),
  });
  app.post('/v1/studio/projects', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = createProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const outcome = await db.transaction(async (tx) => {
      if (
        parsed.data.projectId &&
        !(await validateOwnedLiveProject(tx, parsed.data.projectId, session.user.id))
      ) {
        return { kind: 'not_found' as const };
      }
      const count = await tx
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(eq(studioProjects.userId, session.user.id));
      if (count.length >= PROJECT_MAX_COUNT) return { kind: 'limit' as const };
      const [row] = await tx
        .insert(studioProjects)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: parsed.data.projectId ?? null,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          timeline: {},
        })
        .returning({
          id: studioProjects.id,
          title: studioProjects.title,
          projectId: studioProjects.projectId,
          createdAt: studioProjects.createdAt,
          updatedAt: studioProjects.updatedAt,
        });
      return { kind: 'created' as const, row };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_projects', max: PROJECT_MAX_COUNT });
    }
    return reply.status(201).send(outcome.row);
  });

  // Load one project's timeline + title (ownership-checked).
  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>(
    '/v1/studio/projects/:id',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listProjectsSchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const projectId = parsed.data.projectId;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const rows = await db
        .select({
          projectId: studioProjects.projectId,
          timeline: studioProjects.timeline,
          title: studioProjects.title,
          updatedAt: studioProjects.updatedAt,
        })
        .from(studioProjects)
        .where(
          and(eq(studioProjects.id, req.params.id), eq(studioProjects.userId, session.user.id)),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return reply.status(404).send({ error: 'not_found' });
      if (projectId && row.projectId !== projectId) {
        return reply.status(409).send({
          error: 'project_mismatch',
          expectedProjectId: projectId,
          actualProjectId: row.projectId,
        });
      }
      return row;
    },
  );

  // Update a project's timeline and/or title (rev-guarded last-writer-wins).
  const updateProjectSchema = z.object({
    title: z.string().trim().min(1).max(80).optional(),
    timeline: z.unknown().optional(),
    rev: z.number().finite().optional(),
  });
  app.put<{ Params: { id: string } }>('/v1/studio/projects/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = updateProjectSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { title, timeline, rev } = parsed.data;
    if (timeline !== undefined && JSON.stringify(timeline).length > PROJECT_MAX_BYTES) {
      return reply.status(400).send({ error: 'invalid_timeline' });
    }
    let stamped: unknown | undefined = timeline;
    if (timeline !== undefined && typeof rev === 'number') {
      const existing = await db
        .select({ timeline: studioProjects.timeline })
        .from(studioProjects)
        .where(
          and(eq(studioProjects.id, req.params.id), eq(studioProjects.userId, session.user.id)),
        )
        .limit(1);
      if (existing.length === 0) return reply.status(404).send({ error: 'not_found' });
      const storedRev = (existing[0]?.timeline as { __rev?: number } | null)?.__rev ?? -1;
      const next = stampRev(timeline, rev, storedRev);
      if (next === 'skip') return { ok: true, skipped: true };
      stamped = next;
    }
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(studioProjects)
        .set({
          ...(title !== undefined ? { title } : {}),
          ...(stamped !== undefined ? { timeline: stamped } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(eq(studioProjects.id, req.params.id), eq(studioProjects.userId, session.user.id)),
        )
        .returning({ id: studioProjects.id });
      if (rows.length > 0 && stamped !== undefined) {
        await syncAssetReferences(tx, {
          userId: session.user.id,
          refType: 'studio_clip',
          resourceId: req.params.id,
          references: studioTimelineAssetReferences(stamped),
        });
      }
      return rows;
    });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Delete a project.
  app.delete<{ Params: { id: string } }>('/v1/studio/projects/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const deleted = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(studioProjects)
        .where(
          and(eq(studioProjects.id, req.params.id), eq(studioProjects.userId, session.user.id)),
        )
        .returning({ id: studioProjects.id });
      if (rows.length > 0) {
        await syncAssetReferences(tx, {
          userId: session.user.id,
          refType: 'studio_clip',
          resourceId: req.params.id,
          references: [],
        });
      }
      return rows;
    });
    if (deleted.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // B-2a: durable render history — the caller's renders, newest first, so the
  // Studio history panel survives a refresh. Capped; resultUrl present once a
  // render succeeds (drives download), errorMessage on failure (drives retry).
  app.get('/v1/studio/renders', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select({
        id: studioRenders.id,
        status: studioRenders.status,
        resultUrl: studioRenders.resultUrl,
        errorMessage: studioRenders.errorMessage,
        createdAt: studioRenders.createdAt,
        finishedAt: studioRenders.finishedAt,
      })
      .from(studioRenders)
      .where(eq(studioRenders.userId, session.user.id))
      .orderBy(desc(studioRenders.createdAt))
      .limit(30);
    return { renders: rows };
  });

  app.get<{ Params: { id: string } }>('/v1/studio/renders/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(studioRenders)
      .where(and(eq(studioRenders.id, req.params.id), eq(studioRenders.userId, session.user.id)))
      .limit(1);
    const r = rows[0];
    if (!r) return reply.status(404).send({ error: 'not_found' });
    return {
      id: r.id,
      status: r.status,
      resultUrl: r.resultUrl,
      errorMessage: r.errorMessage,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
    };
  });

  // Cancel a queued/running render. Flips status to 'canceled' atomically;
  // the worker's cooperative checkpoints (studio-render.ts) see it and abort
  // without producing gallery output, and a never-picked-up queued render is
  // simply skipped. Idempotent: cancelling a terminal render is a no-op that
  // echoes the current status.
  app.post<{ Params: { id: string } }>('/v1/studio/renders/:id/cancel', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const canceled = await db
      .update(studioRenders)
      .set({ status: 'canceled', finishedAt: new Date() })
      .where(
        and(
          eq(studioRenders.id, req.params.id),
          eq(studioRenders.userId, session.user.id),
          inArray(studioRenders.status, ['queued', 'running']),
        ),
      )
      .returning({ id: studioRenders.id, status: studioRenders.status });
    if (canceled[0]) return { id: canceled[0].id, status: canceled[0].status };

    // Nothing flipped: either unknown render or already terminal.
    const existing = await db
      .select({ id: studioRenders.id, status: studioRenders.status })
      .from(studioRenders)
      .where(and(eq(studioRenders.id, req.params.id), eq(studioRenders.userId, session.user.id)))
      .limit(1);
    if (!existing[0]) return reply.status(404).send({ error: 'not_found' });
    return { id: existing[0].id, status: existing[0].status };
  });
}
