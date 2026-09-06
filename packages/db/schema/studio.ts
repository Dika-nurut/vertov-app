import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { usersApp } from './users';
import { projects } from './projects';

/** Transition INTO the next clip (ffmpeg xfade). Basic opacity transitions
 * (cut · crossfade · dip-to-black · flash/dip-to-white) plus the geometric
 * market set — slide/push, wipe, iris (circle), and zoom — each backed by an
 * xfade mode whose motion the CSS preview mirrors frame-for-frame. */
export type StudioTransition =
  | 'cut'
  | 'crossfade'
  | 'dip'
  | 'flash'
  | 'slideleft'
  | 'slideright'
  | 'slideup'
  | 'slidedown'
  | 'wipeleft'
  | 'wiperight'
  | 'wipeup'
  | 'wipedown'
  | 'circleopen'
  | 'circleclose'
  | 'zoomin';

/** Per-clip color filter — previewed with CSS, rendered with ffmpeg. */
export type StudioFilter = 'none' | 'warm' | 'cool' | 'mono' | 'punch';

/** One clip placed on the studio timeline. */
export interface StudioClip {
  /** Public asset URL of the source video (proxy URL). */
  url: string;
  /** Trim in-point in seconds (default 0). */
  inSec?: number;
  /** Trim out-point in seconds (default = clip end). */
  outSec?: number;
  /** Playback speed 0.5–2 (default 1). */
  speed?: number;
  /** Mute the clip's own audio. */
  muted?: boolean;
  /** Gain on the clip's own audio in dB (-40..20, default 0). */
  volumeDb?: number;
  /** Transition into the NEXT clip (ignored on the last clip). */
  transition?: StudioTransition;
  /** Transition length in seconds (0.2–1.5, default 0.5). */
  transitionSec?: number;
  /** Color filter (default 'none'). */
  filter?: StudioFilter;
  /** Per-clip transform (editor E2). Additive — a clip without one renders
   * exactly as before. */
  transform?: StudioTransform;
  /** Per-clip colour grade (editor E3). Additive; supersedes `filter`
   * presets (presets quick-apply these values in the UI). */
  color?: StudioColor;
  /** Editor E4: play the trimmed range backwards (audio too). */
  reversed?: boolean;
  /** Editor E4: mirror horizontally / vertically. */
  flipH?: boolean;
  flipV?: boolean;
  /** Editor E4: freeze-frame clip — holds the source frame at `atSec` for
   * `durSec`. When set, inSec/outSec are ignored for duration purposes. */
  freeze?: { atSec: number; durSec: number };
  /** Editor E5: speed-ramp preset (piecewise speed over the trimmed range).
   * Overrides `speed` for video; audio gets the matching average tempo. */
  speedCurve?: StudioSpeedCurve;
  /** Editor E6: entrance / exit animation. */
  animIn?: StudioAnim;
  animOut?: StudioAnim;
  /** Editor E7 (phase 1): keyframes over OUTPUT time within the clip.
   * opacity 0–1 · posX/posY ±100 (%) · scale 1–3 · rotate ±180 (°). */
  keyframes?: StudioKeyframes;
  /** S3 (subsystem C): reveal only a masked region; the rest falls through to
   * the composition background. CSS clip-path/mask mirrors it 1:1 in preview. */
  mask?: StudioMask;
  /** S3 (subsystem D, Basic.Blend): static layer opacity 0–1 (default 1). */
  opacity?: number;
  /** S3 (subsystem D, Basic.Blend): blend mode vs the composition background. */
  blendMode?: StudioBlendMode;
  /** Multi-track (Phase II): absolute timeline start (seconds on the assembled
   * output) when this clip rides an UPPER video track. Ignored on the base
   * track, which lays clips sequentially. */
  startSec?: number;
}

/** Blend modes a CSS `mix-blend-mode` mirrors 1:1 over the background box. */
export type StudioBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

/** Mask shape + soft edge (subsystem C). circle/rect/linear/diamond/star/heart
 * are shapes a CSS mask-image mirrors exactly (or closely — heart is a
 * documented implicit-curve approximation), so preview≈export holds.
 * cinematic-bars is a fixed 12%-of-frame letterbox, not a feathered shape.
 * `freeform` is a hand-drawn polygon: an array of normalized 0–1 vertices
 * compiled into a point-in-polygon test on both sides (ffmpeg geq + CSS SVG
 * mask), no raster. */
export interface StudioMask {
  shape:
    | 'none'
    | 'circle'
    | 'rect'
    | 'linear'
    | 'heart'
    | 'star'
    | 'diamond'
    | 'cinematic-bars'
    | 'freeform';
  /** Soft edge 0–100 (% of the feather band). */
  feather?: number;
  /** Swap revealed/hidden regions. */
  invert?: boolean;
  /** Freeform polygon vertices — normalized 0–1 fractions of frame w/h. Only
   * meaningful when shape==='freeform'; ignored otherwise. Cap 16 (see the
   * worker geq generator — the per-pixel expression stays tractable). */
  points?: { x: number; y: number }[];
}

export type StudioKfProp = 'opacity' | 'posX' | 'posY' | 'scale' | 'rotate';
export interface StudioKeyframe {
  /** Output-time seconds from the clip's start. */
  t: number;
  v: number;
}
export type StudioKeyframes = Partial<Record<StudioKfProp, StudioKeyframe[]>>;

/** Clip entrance/exit animation (E6): kind + duration (0.2–2s). */
export interface StudioAnim {
  kind: 'fade' | 'slide' | 'zoom';
  durSec: number;
}

/** Named speed ramps — segment tables live in the render graph builder. */
export type StudioSpeedCurve = 'montage' | 'hero' | 'flash';

/** Colour grade — every prop centered at 0 (±100), like the CapCut sliders.
 * vignette/grain are 0–100 (off at 0). */
export interface StudioColor {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  /** + = warmer (lower kelvin), − = cooler. */
  temperature?: number;
  /** Lift/crush the upper region of the tone curve. */
  highlight?: number;
  /** Lift/crush the lower region of the tone curve. */
  shadow?: number;
  vignette?: number;
  grain?: number;
  /** S3 subsystem D (Curves): a named tone-curve preset over the grade. */
  curve?: StudioCurvePreset;
  /** S3 subsystem D (HSL): per-colour-range hue/sat/lum (ffmpeg huesaturation). */
  hsl?: StudioHsl;
}

/** HSL colour ranges (ffmpeg huesaturation: reds/yellows/greens/cyans/blues/magentas). */
export type StudioHslChannel = 'r' | 'y' | 'g' | 'c' | 'b' | 'm';
export interface StudioHslAdjust {
  /** Hue shift −180..180°. */
  h?: number;
  /** Saturation −100..100. */
  s?: number;
  /** Lightness/intensity −100..100. */
  l?: number;
}
export type StudioHsl = Partial<Record<StudioHslChannel, StudioHslAdjust>>;

/** CapCut Curves presets — each compiles to an ffmpeg `curves` argument. The
 * last 6 are the "Looks" film-emulation grades (original, CSS-approximated). */
export type StudioCurvePreset =
  | 'lighten'
  | 'darken'
  | 'fade'
  | 'contrast'
  | 'cool'
  | 'warm'
  | 'vintage'
  | 'warm-film'
  | 'cool-film'
  | 'noir'
  | 'teal-orange'
  | 'bleach-bypass'
  | 'faded-polaroid';

/** Transform values mirror the CSS preview 1:1 (preview≈render parity). */
export interface StudioTransform {
  /** Uniform scale 0.2–3 (default 1). */
  scale?: number;
  /** Horizontal offset as % of frame width, -100..100 (default 0). */
  posX?: number;
  /** Vertical offset as % of frame height, -100..100 (default 0). */
  posY?: number;
  /** Rotation in degrees, -180..180 (default 0). */
  rotate?: number;
  /** Edge crop fractions 0–0.45 of source width/height (default 0). */
  crop?: { left?: number; top?: number; right?: number; bottom?: number };
}

/** A text overlay, timed against the assembled timeline (absolute seconds). */
export interface StudioTextOverlay {
  text: string;
  fromSec: number;
  toSec: number;
  /** Vertical placement; horizontally always centered (v1). */
  position: 'top' | 'center' | 'bottom';
  /** Font size as a fraction of output height (default 1/15). */
  sizeFrac?: number;
  /** Title font: sans (Onest, default) · serif · display (Unbounded, heavy
   * headline) · mono (Martian Mono). The worker renders each with the matching
   * bundled TTF; the CSS preview uses the same family for preview≈export. */
  font?: 'sans' | 'serif' | 'display' | 'mono';
  /** Fade in/out over 0.3s. */
  fade?: boolean;
  /** CapCut-style background box behind the text (hex color). Absent = no
   * plate, byte-identical to the legacy drawtext (white text, no box). */
  plate?: { color: string };
}

/**
 * CapCut-style word-pop captions («по словам»): each spoken WORD is shown alone
 * in its own time window, sharing ONE style. A DEDICATED lane (not `texts`)
 * because a clip of speech yields 50–200 words — far past the 12-`texts` cap, and
 * each word is its own drawtext filter. This is the honest realizable mode:
 * true inline karaoke highlight would need per-glyph text-extent measurement that
 * ffmpeg can't do reliably, so word-by-word POP (OpenReel's renderWordByWord) is
 * what preview and export can both faithfully render. Absent = unchanged.
 */
export interface StudioPopText {
  /** Shared title font for every word (default sans). */
  font?: 'sans' | 'serif' | 'display' | 'mono';
  /** Shared size as a fraction of output height (default 1/15). */
  sizeFrac?: number;
  /** Shared vertical placement (default center). */
  position?: 'top' | 'center' | 'bottom';
  /** Shared CapCut-style background plate behind every word. */
  plate?: { color: string };
  /** One entry per spoken word, in absolute assembled-timeline seconds. */
  words: { text: string; fromSec: number; toSec: number }[];
}

/** An audio line mixed over the assembled timeline. */
export interface StudioAudioTrack {
  url: string;
  gainDb?: number;
  /** Start offset on the timeline in seconds (default 0). */
  fromSec?: number;
  /** 1s fade-in / fade-out at the line's ends. */
  fadeIn?: boolean;
  fadeOut?: boolean;
  /** Auto-ducking (music line): dip the music to `db` during each hold window
   * (project-timeline seconds) while a voiceover speaks. Attack/release ramps are
   * fixed constants applied at render (studio-graph.ts), not stored per window.
   * `sourceKey` (`${voiceover.url}@${voiceover.fromSec}` at analysis time) lets the
   * client detect a stale duck after the voiceover changes; render ignores it. */
  duck?: {
    db: number;
    segments: { fromSec: number; toSec: number }[];
    sourceKey?: string;
  };
}

/**
 * A timed sound-effect clip mixed UNDER the assembled timeline at an absolute
 * time. Unlike {@link StudioAudioTrack} (music/voiceover, which start at
 * `fromSec` and run to the end), an SFX is a short hit placed at `atSec`; the
 * worker trims it to the video length so it never extends the render duration.
 */
export interface StudioSfx {
  url: string;
  /** Absolute timeline start (seconds on the assembled output). */
  atSec: number;
  /** Gain in dB (-40..20, default 0). */
  gainDb?: number;
}

/**
 * Editor E8: a picture-in-picture overlay riding ABOVE the main track at an
 * absolute timeline position. Scaled/placed like CapCut's overlay track.
 */
export interface StudioOverlayClip {
  url: string;
  /** Timeline start (seconds on the ASSEMBLED output). */
  atSec: number;
  /** Source trim (defaults: whole clip). */
  inSec?: number;
  outSec?: number;
  /** PiP size as a fraction of frame width (0.1–1, default 0.35). */
  scale?: number;
  /** Center offset as % of frame, like StudioTransform (default top-right). */
  posX?: number;
  posY?: number;
  /** 0–1 (default 1). */
  opacity?: number;
  muted?: boolean;
  gainDb?: number;
}

/**
 * S3 (subsystem G): the composition background that fills the letterbox bars
 * when a clip doesn't cover the frame (after a Ratio change). `color` is the
 * solid fill; `blur` derives a frosted backdrop from the clip itself. Absent =
 * the legacy solid black, byte-for-byte.
 */
export interface StudioBackground {
  type: 'color' | 'blur';
  /** ffmpeg colour for `type:'color'` (e.g. '#101014' or 'black'). */
  color?: string;
}

/** The edit-decision document the ffmpeg render service consumes. */
export interface StudioRenderSpec {
  clips: StudioClip[];
  /**
   * Multi-track (Phase II): upper VIDEO tracks composited over the base track,
   * base-first → top-last. Each clip is a FULL {@link StudioClip} placed
   * absolutely via `startSec`, so an upper-track clip carries the same instrument
   * set (color/transform/mask/blend/keyframes/animation/trim) as a base clip.
   * When absent, {@link StudioOverlayClip}[] `overlays` are mapped into a single
   * synthetic upper track (back-compat).
   */
  tracks?: StudioClip[][];
  /** Editor E8: PiP overlays composited over the assembled main track. DEPRECATED
   * compat alias for a single upper track — mapped into `tracks` by the worker. */
  overlays?: StudioOverlayClip[];
  /** Legacy single audio line (pre-v2 clients). Treated as `music`. */
  audio?: { url: string; gainDb?: number } | null;
  music?: StudioAudioTrack | null;
  voiceover?: StudioAudioTrack | null;
  /** Timed sound-effect clips mixed under the timeline (each at its `atSec`). */
  sfx?: StudioSfx[];
  texts?: StudioTextOverlay[];
  /** Word-pop captions («по словам») — a dedicated lane, one drawtext per word.
   * Kept apart from `texts` because it blows the 12-text cap immediately. */
  popText?: StudioPopText;
  width: number;
  height: number;
  fps?: number;
  /** Editor E9: output container (codecs stay H.264/AAC). Default mp4. */
  format?: 'mp4' | 'mov';
  /** S3 subsystem G: letterbox/canvas background fill (default solid black). */
  background?: StudioBackground;
  /** S7 (subsystem H): cover-frame time (seconds) for the render thumbnail. */
  coverSec?: number;
}

/**
 * A server-side ffmpeg render of a multi-clip timeline into a single MP4.
 * Decoupled from `jobs` (which is AI-generation only) — this is pure
 * post-production assembly.
 */
export const studioRenders = pgTable(
  'studio_renders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // queued | running | succeeded | failed
    status: text('status').notNull().default('queued'),
    spec: jsonb('spec').notNull().$type<StudioRenderSpec>(),
    resultUrl: text('result_url'),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('studio_renders_user_id_idx').on(t.userId),
    index('studio_renders_project_id_idx').on(t.projectId),
    index('studio_renders_status_idx').on(t.status),
  ],
);

/**
 * A studio composition the user can keep and reopen. Each user may have many
 * (mirrors `boards`): a named project per row, plus one reserved "scratch"
 * project (deterministic id `scratch-<userId>`) that the quick `/studio` editor
 * and the generate/boards hand-off write to. `timeline` stores the client-side
 * editor state; the server treats it as opaque JSON.
 */
export const studioProjects = pgTable(
  'studio_projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    title: text('title').notNull().default('Новый проект'),
    timeline: jsonb('timeline').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('studio_projects_user_id_idx').on(t.userId)],
);
