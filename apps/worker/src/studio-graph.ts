import type {
  StudioClip,
  StudioColor,
  StudioFilter,
  StudioOverlayClip,
  StudioRenderSpec,
  StudioTextOverlay,
  StudioTransform,
  StudioTransition,
} from '@seed/db';

/**
 * Pure ffmpeg filtergraph builders for the studio render — no I/O, no spawn,
 * so the whole assembly logic is unit-testable as string output.
 *
 * Pipeline shape (see studio-render.ts):
 *  pass 1  per clip: trim/scale/pad/fps/speed/volume → n{i}.mp4 (uniform codec)
 *  pass 2  one invocation: xfade/concat chain + drawtext overlays + amix/loudnorm
 */

// Transition id → ffmpeg xfade mode. The basic opacity transitions remap to
// xfade's fade family; the geometric ones use the identically-named xfade mode
// (the studio id IS the xfade mode), so the CSS preview in _model.ts `txPreview`
// can mirror each mode's verified motion frame-for-frame. `Exclude<…,'cut'>`
// makes this map exhaustive — adding a StudioTransition fails the build here.
const XFADE_BY_TRANSITION: Record<Exclude<StudioTransition, 'cut'>, string> = {
  crossfade: 'fade',
  dip: 'fadeblack',
  flash: 'fadewhite',
  slideleft: 'slideleft',
  slideright: 'slideright',
  slideup: 'slideup',
  slidedown: 'slidedown',
  wipeleft: 'wipeleft',
  wiperight: 'wiperight',
  wipeup: 'wipeup',
  wipedown: 'wipedown',
  circleopen: 'circleopen',
  circleclose: 'circleclose',
  zoomin: 'zoomin',
};

/** ffmpeg filter chains matching the CSS preview filters in the editor. */
const FILTER_VF: Record<Exclude<StudioFilter, 'none'>, string> = {
  warm: 'colortemperature=temperature=4600,eq=saturation=1.12:contrast=1.04',
  cool: 'colortemperature=temperature=7800,eq=saturation=1.08:contrast=1.04',
  mono: 'hue=s=0,eq=contrast=1.1',
  punch: 'eq=saturation=1.32:contrast=1.12',
};

export const DEFAULT_TRANSITION_SEC = 0.5;
const FADE_SEC = 0.3;

export function clampSpeed(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 1;
  // E5 widened the range (was 0.5–2); atempo chains cover the extremes.
  return Math.max(0.25, Math.min(v, 4));
}

/** atempo accepts 0.5–2 per stage — decompose wider speeds into equal
 * in-range factors (E5). */
export function buildAtempoChain(speed: number): string[] {
  if (speed === 1) return [];
  if (speed >= 0.5 && speed <= 2) return [`atempo=${round3(speed)}`];
  const f = Math.sqrt(speed);
  return [`atempo=${round3(f)}`, `atempo=${round3(f)}`];
}

/** E5 speed-ramp presets — piecewise-constant rates over fractions of the
 * TRIMMED source range. Fractions sum to 1. */
export const SPEED_CURVES: Record<'montage' | 'hero' | 'flash', { frac: number; rate: number }[]> =
  {
    /** slow build → fast finish */
    montage: [
      { frac: 0.4, rate: 0.6 },
      { frac: 0.6, rate: 1.6 },
    ],
    /** fast — slow hero moment — fast */
    hero: [
      { frac: 0.3, rate: 1.8 },
      { frac: 0.4, rate: 0.45 },
      { frac: 0.3, rate: 1.8 },
    ],
    /** linger → whip */
    flash: [
      { frac: 0.7, rate: 0.6 },
      { frac: 0.3, rate: 2.4 },
    ],
  };

export interface SpeedRamp {
  /** Video setpts expression mapping source T → output time. */
  setpts: string;
  /** Output duration of the ramped range. */
  outDuration: number;
  /** Uniform audio tempo that lands audio on the same duration. */
  avgSpeed: number;
}

/**
 * Compile a speed-curve preset into a piecewise setpts expression for a
 * trimmed range of `srcLen` seconds (post -ss, T starts at 0). Audio can't
 * ramp piecewise with stock filters — it gets the average tempo so both
 * streams end together (documented approximation).
 */
export function buildSpeedRamp(curve: keyof typeof SPEED_CURVES, srcLen: number): SpeedRamp {
  const segs = SPEED_CURVES[curve];
  let srcAcc = 0;
  let outAcc = 0;
  // innermost-else fallback expression first, built right-to-left
  const pieces: { srcStart: number; srcEnd: number; rate: number; outStart: number }[] = [];
  for (const s of segs) {
    const len = srcLen * s.frac;
    pieces.push({ srcStart: srcAcc, srcEnd: srcAcc + len, rate: s.rate, outStart: outAcc });
    srcAcc += len;
    outAcc += len / s.rate;
  }
  let expr = `${round3(pieces[pieces.length - 1]!.outStart)}+(T-${round3(
    pieces[pieces.length - 1]!.srcStart,
  )})/${pieces[pieces.length - 1]!.rate}`;
  for (let i = pieces.length - 2; i >= 0; i--) {
    const p = pieces[i]!;
    expr = `if(lt(T\\,${round3(p.srcEnd)})\\,${round3(p.outStart)}+(T-${round3(p.srcStart)})/${p.rate}\\,${expr})`;
  }
  return {
    setpts: `setpts='(${expr})/TB'`,
    outDuration: outAcc,
    avgSpeed: srcLen / outAcc,
  };
}

/**
 * Entrance/exit animations (E6) as plain vf filters in OUTPUT time — append
 * after setpts. fade = fade in/out; zoom = ken-burns crop settle (1.2→1 in,
 * 1→1.2 out); slide = crop window over a 3W pad (enter from left / exit
 * right). Needs the clip's output duration for exits.
 */
export function buildAnimChain(opts: {
  animIn?: { kind: 'fade' | 'slide' | 'zoom'; durSec: number } | undefined;
  animOut?: { kind: 'fade' | 'slide' | 'zoom'; durSec: number } | undefined;
  outDur: number | null;
  width: number;
  height: number;
  fps: number;
}): string[] {
  const { animIn, animOut, outDur, width: W, height: H } = opts;
  const clampD = (d: number) => Math.max(0.2, Math.min(d, 2));
  const chain: string[] = [];
  const zoomExprs: string[] = [];
  const slideX: string[] = [];

  // commas inside the '…'-quoted expressions are quote-protected — do NOT
  // backslash-escape them (that injects literal backslashes into the expr).
  if (animIn) {
    const d = round3(clampD(animIn.durSec));
    if (animIn.kind === 'fade') chain.push(`fade=t=in:st=0:d=${d}`);
    if (animIn.kind === 'zoom') zoomExprs.push(`0.2*(1-min(it/${d},1))`);
    if (animIn.kind === 'slide') slideX.push(`if(lt(t,${d}),2*${W}-${W}*t/${d},${W})`);
  }
  if (animOut && outDur && outDur > 0.3) {
    const d = round3(Math.min(clampD(animOut.durSec), outDur / 2));
    const st = round3(Math.max(0, outDur - d));
    if (animOut.kind === 'fade') chain.push(`fade=t=out:st=${st}:d=${d}`);
    if (animOut.kind === 'zoom') zoomExprs.push(`0.2*max(0,(it-${st})/${d})`);
    if (animOut.kind === 'slide') slideX.push(`${W}-${W}*max(0,(t-${st})/${d})`);
  }

  if (zoomExprs.length) {
    // crop can't animate w/h (config-time eval) — zoompan is the real tool;
    // `it` = input timestamp, post-setpts = output time.
    chain.push(
      `zoompan=z='1+${zoomExprs.join('+')}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${opts.fps}`,
    );
  }
  if (slideX.length) {
    // combine: entrance window starts right of content, exit moves left of it
    const x = slideX.length === 2 ? `(${slideX[0]})+(${slideX[1]})-${W}` : slideX[0]!;
    chain.push(`pad=w=3*${W}:h=${H}:x=${W}:y=0:color=black`, `crop=${W}:${H}:x='${x}':y=0`);
  }
  return chain;
}

export function clampTransitionSec(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_TRANSITION_SEC;
  return Math.max(0.2, Math.min(v, 1.5));
}

/**
 * E7: compile keyframes into a piecewise-LINEAR ffmpeg expression over the
 * given time variable (t / it / T). Holds outside the key range (CapCut
 * semantics). Keys sorted defensively.
 */
export function kfExpr(kfs: { t: number; v: number }[], timeVar = 't'): string {
  const ks = [...kfs].sort((a, b) => a.t - b.t);
  if (ks.length === 0) return '0';
  if (ks.length === 1) return String(round3(ks[0]!.v));
  let expr = String(round3(ks[ks.length - 1]!.v)); // hold after the last key
  for (let i = ks.length - 2; i >= 0; i--) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    const dt = Math.max(0.001, b.t - a.t);
    const seg = `${round3(a.v)}+(${round3(b.v)}-${round3(a.v)})*(${timeVar}-${round3(a.t)})/${round3(dt)}`;
    expr = `if(lt(${timeVar},${round3(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${timeVar},${round3(ks[0]!.t)}),${round3(ks[0]!.v)},${expr})`;
}

/**
 * E7 keyframe filters (phase 1: opacity + transform), output-time, appended
 * after setpts/anims. All LINEAR-chain realizable:
 *  rotate  → rotate a='expr·π/180' on a hypot canvas, re-cropped to frame
 *  scale   → zoompan z (1–3; zoompan can't go below 1 — documented)
 *  posX/Y  → 3W×3H pad + keyframed crop window
 *  opacity → geq RGB multiply (≡ alpha over the black frame); per-pixel CPU
 */
export function buildKeyframeChain(opts: {
  keyframes: NonNullable<StudioClip['keyframes']>;
  width: number;
  height: number;
  fps: number;
}): string[] {
  const { keyframes: kf, width: W, height: H } = opts;
  const chain: string[] = [];
  if (kf.rotate?.length) {
    const a = `(${kfExpr(kf.rotate)})*PI/180`;
    chain.push(
      `rotate=a='${a}':c=black:ow='hypot(iw,ih)':oh=ow`,
      `crop=${W}:${H}:(iw-${W})/2:(ih-${H})/2`,
    );
  }
  if (kf.scale?.length) {
    chain.push(
      `zoompan=z='${kfExpr(kf.scale, 'it')}':x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2':d=1:s=${W}x${H}:fps=${opts.fps}`,
    );
  }
  if (kf.posX?.length || kf.posY?.length) {
    const xOff = kf.posX?.length ? `(${kfExpr(kf.posX)})*${W}/100` : '0';
    const yOff = kf.posY?.length ? `(${kfExpr(kf.posY)})*${H}/100` : '0';
    chain.push(
      `pad=w=3*${W}:h=3*${H}:x=${W}:y=${H}:color=black`,
      `crop=${W}:${H}:x='${W}-(${xOff})':y='${H}-(${yOff})'`,
    );
  }
  if (kf.opacity?.length) {
    // multiplying RGB by the curve over the black frame IS opacity — and it
    // stays a plain linear -vf chain (no split/overlay needed)
    const f = `clip(${kfExpr(kf.opacity, 'T')},0,1)`;
    chain.push(
      'format=gbrp',
      `geq=r='r(X,Y)*${f}':g='g(X,Y)*${f}':b='b(X,Y)*${f}'`,
      'format=yuv420p',
    );
  }
  return chain;
}

/** Effective output duration of a clip after trim + speed.
 * Freeze-frame clips (E4) hold one frame for freeze.durSec — trim/speed
 * don't apply. */
export function clipOutputDuration(clip: StudioClip, sourceDur: number): number {
  if (clip.freeze) return Math.max(0.5, Math.min(clip.freeze.durSec, 10));
  const inSec = Math.max(0, clip.inSec ?? 0);
  const outSec = clip.outSec && clip.outSec > inSec ? Math.min(clip.outSec, sourceDur) : sourceDur;
  if (clip.speedCurve && SPEED_CURVES[clip.speedCurve]) {
    return Math.max(0.1, buildSpeedRamp(clip.speedCurve, outSec - inSec).outDuration);
  }
  return Math.max(0.1, (outSec - inSec) / clampSpeed(clip.speed));
}

/** Escape a string for use inside a drawtext text='…' value.
 * We render with expansion=none, so only filter-syntax characters need
 * escaping (\, ', :) — % stays literal. Empirically, % under the default
 * expansion mode silently breaks text_h-based positioning, so expansion
 * stays OFF and overlays are single-line (newlines → space). */
export function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\\\\\'")
    .replace(/:/g, '\\:')
    .replace(/\s*\n\s*/g, ' ');
}

/** Relative-luminance contrast rule for text sitting on a plate — mirrors the
 * web preview's copy in apps/web/app/studio/_model.ts (plateTextColor). Kept
 * as two trivial, independently-readable implementations rather than a
 * shared package, per the plate feature brief. */
function plateTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#0c0e12' : '#ffffff';
}

export interface OverlayFontPaths {
  sans: string;
  serif: string;
  display: string;
  mono: string;
}

/** One drawtext filter for a timed overlay; y from position, centered x.
 * Long titles auto-shrink to fit the frame width (~0.62×fontsize per Cyrillic
 * bold glyph) instead of clipping at the edges. */
export function drawtextFilter(
  t: StudioTextOverlay,
  width: number,
  height: number,
  fonts: OverlayFontPaths,
  opts: { halfOpenEnable?: boolean } = {},
): string {
  const from = Math.max(0, t.fromSec);
  const to = Math.max(from + 0.1, t.toSec);
  const sizeFrac = t.sizeFrac && t.sizeFrac > 0 ? Math.min(t.sizeFrac, 0.25) : 1 / 15;
  const fitCap = Math.floor((width * 1.45) / Math.max(1, t.text.length));
  const fontsize = Math.max(12, Math.min(Math.round(height * sizeFrac), fitCap));
  const fontfile =
    t.font === 'serif'
      ? fonts.serif
      : t.font === 'display'
        ? fonts.display
        : t.font === 'mono'
          ? fonts.mono
          : fonts.sans;
  const y =
    t.position === 'top' ? 'h*0.08' : t.position === 'center' ? '(h-text_h)/2' : 'h*0.88-text_h';
  // Fade envelope MUST mirror the preview (PreviewStage.tsx `fadeP`), which takes
  // the MINIMUM of the attack and release ramps simultaneously — not a sequential
  // if() that evaluates attack first. The two only diverge for a short overlay
  // (duration < 2·FADE_SEC) where the ramps overlap: the sequential form kept the
  // overlay near full-alpha while the preview was already fading it out. min() of
  // both ramps, clamped to [0,1], matches the preview frame-for-frame.
  // NOTE: ffmpeg's min()/max() are BINARY — nest them (a 3-arg min silently breaks
  // the drawtext filter at render time: "Error reinitializing filters").
  const alpha = t.fade
    ? `:alpha='max(0\\,min(1\\,min((t-${from})/${FADE_SEC}\\,(${to}-t)/${FADE_SEC})))'`
    : '';
  const fontcolor = t.plate ? plateTextColor(t.plate.color) : 'white';
  const plate = t.plate
    ? `:box=1:boxcolor=${t.plate.color}:boxborderw=${Math.round(fontsize * 0.35)}`
    : '';
  // Pop-caption words are adjacent (one word's `to` == the next word's `from`);
  // `between()` is inclusive on both ends, so a shared boundary frame renders
  // both words at once while the preview shows exactly one. Half-open
  // [from,to) for that lane matches the preview's `playhead ∈ [from,to)` word
  // lookup. Ordinary text overlays keep `between()` — they aren't adjacency-packed.
  const enable = opts.halfOpenEnable
    ? `gte(t\\,${from})*lt(t\\,${to})`
    : `between(t\\,${from}\\,${to})`;
  return (
    `drawtext=fontfile=${fontfile}:expansion=none:text='${escapeDrawtext(t.text)}'` +
    `:fontsize=${fontsize}:fontcolor=${fontcolor}:borderw=${Math.max(1, Math.round(fontsize / 18))}:bordercolor=black@0.55${plate}` +
    `:x=(w-text_w)/2:y=${y}` +
    `:enable='${enable}'${alpha}`
  );
}

export interface AssemblyInput {
  /** Output durations of the NORMALIZED clips, in order (ffprobe pass 1 output). */
  durations: number[];
  clips: StudioClip[];
  spec: StudioRenderSpec;
  fonts: OverlayFontPaths;
  /** Input indexes of the optional audio lines among the ffmpeg -i args. */
  musicInput?: number | null;
  voiceoverInput?: number | null;
  /** Timed sound-effect lines: each placed at `atSec` and mixed under the video.
   * They're trimmed to the timeline length so they never extend the output. */
  sfxInputs?: { inputIdx: number; atSec: number; gainDb?: number }[];
  /** E8: PiP overlay sources — raw inputs (trim happens in-graph). */
  overlays?: { inputIdx: number; clip: StudioOverlayClip; sourceDur: number; hasAudio: boolean }[];
  /** Phase II: upper-track layers — PRE-NORMALIZED full-instrument alpha clips
   * (frame-sized yuva). Each is time-shifted to `startSec` and alpha-composited
   * over the assembled track, base-first → top-last. The clip's instruments are
   * already baked in, so the graph only places + composites it. */
  trackLayers?: {
    inputIdx: number;
    startSec: number;
    /** Output duration of the normalized layer (post trim/speed). */
    outDuration: number;
    hasAudio: boolean;
    muted?: boolean;
  }[];
  /** False when every timeline source is intentionally silent. `loudnorm`
   * produces NaN samples for digital silence on FFmpeg 6.1, so silent exports
   * keep their valid padded AAC line without attempting loudness analysis. */
  applyLoudnessNormalization?: boolean;
}

export interface AssemblyGraph {
  filterComplex: string;
  videoLabel: string;
  audioLabel: string;
  /** Total timeline duration after transitions overlap. */
  totalDuration: number;
}

/**
 * Build the single pass-2 filter_complex: video chain (xfade or concat),
 * text overlays, then the audio mix (clip audio ⊕ music ⊕ voiceover → loudnorm).
 *
 * Inputs 0..n-1 are the normalized clips; music/voiceover follow (their input
 * indexes are passed explicitly).
 */
export function buildAssemblyGraph(input: AssemblyInput): AssemblyGraph {
  const { durations, clips, spec, fonts } = input;
  const n = durations.length;
  if (n === 0 || n !== clips.length) {
    throw new Error(`assembly needs matching clips/durations (got ${clips.length}/${n})`);
  }

  const parts: string[] = [];
  let vLabel: string;
  let aLabel: string;
  let total: number;

  // Per-pair transition (clip i → i+1), clamped so the overlap can't exceed
  // half of either adjacent clip.
  const transitions = clips.slice(0, -1).map((c, i) => {
    const kind: StudioTransition = c.transition ?? 'cut';
    if (kind === 'cut') return { kind: 'cut' as const, dur: 0 };
    const maxByClips = Math.max(0.1, Math.min(durations[i]!, durations[i + 1]!) / 2);
    return { kind, dur: Math.min(clampTransitionSec(c.transitionSec), maxByClips) };
  });

  if (n === 1) {
    // -map '[0:v]' would be parsed as a GRAPH label (which wouldn't exist
    // when there are no overlays) — route through a no-op filter so the
    // mapped label is always a real graph output.
    parts.push('[0:v]null[vone]');
    vLabel = '[vone]';
    aLabel = '[0:a]';
    total = durations[0]!;
  } else if (transitions.every((t) => t.kind === 'cut')) {
    // All cuts → plain concat filter (single code path with transitions).
    const ins = Array.from({ length: n }, (_, i) => `[${i}:v][${i}:a]`).join('');
    parts.push(`${ins}concat=n=${n}:v=1:a=1[vcat][acat]`);
    vLabel = '[vcat]';
    aLabel = '[acat]';
    total = durations.reduce((a, b) => a + b, 0);
  } else {
    // xfade/acrossfade chain. offset_i is measured on the ACCUMULATED output.
    let acc = durations[0]!;
    let prevV = '[0:v]';
    let prevA = '[0:a]';
    for (let i = 0; i < n - 1; i++) {
      const t = transitions[i]!;
      const outV = `[vx${i}]`;
      const outA = `[ax${i}]`;
      if (t.kind === 'cut') {
        // concat the pair to keep the chain uniform
        parts.push(`${prevV}${prevA}[${i + 1}:v][${i + 1}:a]concat=n=2:v=1:a=1${outV}${outA}`);
        acc = acc + durations[i + 1]!;
      } else {
        const offset = Math.max(0, acc - t.dur);
        const trans = XFADE_BY_TRANSITION[t.kind];
        // xfade refuses mismatched input timebases, and a concat output
        // (1/1000000) feeding xfade against a raw normalized input (1/15360)
        // is exactly that — normalize both sides with settb=AVTB.
        parts.push(`${prevV}settb=AVTB[vtba${i}]`);
        parts.push(`[${i + 1}:v]settb=AVTB[vtbb${i}]`);
        parts.push(
          `[vtba${i}][vtbb${i}]xfade=transition=${trans}:duration=${t.dur}:offset=${round3(offset)}${outV}`,
        );
        parts.push(`${prevA}[${i + 1}:a]acrossfade=d=${t.dur}${outA}`);
        acc = acc - t.dur + durations[i + 1]!;
      }
      prevV = outV;
      prevA = outA;
    }
    vLabel = prevV;
    aLabel = prevA;
    total = acc;
  }

  // E8: PiP overlays composited over the assembled main track. Each source
  // is trimmed in-graph, scaled to its PiP size, time-shifted to atSec and
  // overlaid with a between() window; eof_action=pass keeps the main track
  // running after a PiP ends.
  const pips = (input.overlays ?? []).slice(0, 6);
  pips.forEach((ov, i) => {
    const c = ov.clip;
    const inS = Math.max(0, c.inSec ?? 0);
    const outS = c.outSec && c.outSec > inS ? Math.min(c.outSec, ov.sourceDur) : ov.sourceDur;
    const at = round3(Math.max(0, c.atSec));
    const end = round3(at + Math.max(0.1, outS - inS));
    const sc = Math.max(0.1, Math.min(c.scale ?? 0.35, 1));
    const op = Math.max(0, Math.min(c.opacity ?? 1, 1));
    const px = Math.round(((c.posX ?? 28) / 100) * spec.width);
    const py = Math.round(((c.posY ?? -28) / 100) * spec.height);
    const layer = [
      `trim=start=${round3(inS)}:end=${round3(outS)}`,
      `setpts=PTS-STARTPTS+${at}/TB`,
      `scale=trunc(${spec.width}*${round3(sc)}/2)*2:-2`,
      'format=rgba',
      ...(op < 1 ? [`colorchannelmixer=aa=${round3(op)}`] : []),
    ].join(',');
    parts.push(`[${ov.inputIdx}:v]${layer}[pip${i}]`);
    parts.push(
      `${vLabel}[pip${i}]overlay=x=(W-w)/2+${px}:y=(H-h)/2+${py}:enable='between(t,${at},${end})':eof_action=pass[vpip${i}]`,
    );
    vLabel = `[vpip${i}]`;
  });

  // Phase II: upper-track layers — pre-normalized frame-sized alpha clips,
  // time-shifted to startSec and alpha-composited (base-first → top-last). The
  // layer is already the full-instrument clip on transparency, so we only place
  // and overlay it.
  const layers = input.trackLayers ?? [];
  layers.forEach((tl, i) => {
    const start = round3(Math.max(0, tl.startSec));
    const end = round3(start + Math.max(0.1, tl.outDuration));
    parts.push(`[${tl.inputIdx}:v]setpts=PTS-STARTPTS+${start}/TB[tl${i}]`);
    parts.push(
      `${vLabel}[tl${i}]overlay=0:0:enable='between(t,${start},${end})':eof_action=pass[vtl${i}]`,
    );
    vLabel = `[vtl${i}]`;
  });

  // Text overlays on the assembled video.
  const texts = (spec.texts ?? []).filter((t) => t.text.trim().length > 0).slice(0, 12);
  if (texts.length > 0) {
    const chain = texts.map((t) => drawtextFilter(t, spec.width, spec.height, fonts)).join(',');
    parts.push(`${vLabel}${chain}[vtxt]`);
    vLabel = '[vtxt]';
  }

  // Word-pop captions («по словам»): ONE shared style, one drawtext per word,
  // each enabled only in its own [fromSec,toSec] window. A dedicated lane (not
  // `texts`, capped at 12) because a clip of speech yields 50–200 words. Note:
  // this is word-by-word POP, not inline karaoke highlight — ffmpeg can't
  // reliably measure per-glyph text extents, so pop is the honest realizable
  // mode (mirrors OpenReel's renderWordByWord). Capped at 400 to bound filters.
  const pop = spec.popText;
  if (pop && pop.words.length > 0) {
    const base = {
      position: pop.position ?? 'center',
      ...(pop.font !== undefined ? { font: pop.font } : {}),
      ...(pop.sizeFrac !== undefined ? { sizeFrac: pop.sizeFrac } : {}),
      ...(pop.plate !== undefined ? { plate: pop.plate } : {}),
    } satisfies Omit<StudioTextOverlay, 'text' | 'fromSec' | 'toSec'>;
    const chain = pop.words
      .slice(0, 400)
      .filter((w) => w.text.trim().length > 0)
      .map((w) =>
        drawtextFilter(
          { ...base, text: w.text, fromSec: w.fromSec, toSec: w.toSec },
          spec.width,
          spec.height,
          fonts,
          { halfOpenEnable: true },
        ),
      )
      .join(',');
    if (chain) {
      parts.push(`${vLabel}${chain}[vpop]`);
      vLabel = '[vpop]';
    }
  }

  // Audio mix: clip audio ⊕ music ⊕ voiceover, then broadcast loudness.
  const lines: string[] = [aLabel];
  const addTrack = (
    inputIdx: number,
    track: {
      gainDb?: number;
      fromSec?: number;
      fadeIn?: boolean;
      fadeOut?: boolean;
      duck?: { db: number; segments: { fromSec: number; toSec: number }[] };
    },
    tag: string,
  ) => {
    const gain = typeof track.gainDb === 'number' ? Math.max(-40, Math.min(track.gainDb, 20)) : 0;
    const delayMs = Math.round(Math.max(0, track.fromSec ?? 0) * 1000);
    // Ducking rides LAST so `t` in the expression is timeline time (post-delay/
    // trim), matching the windows stored in project-timeline seconds — and the
    // preview, which evaluates duckGainDbAt against the same timeline playhead.
    const duckExpr = track.duck ? buildDuckVolumeExpr(track.duck.segments, track.duck.db) : null;
    const steps = [
      `volume=${gain}dB`,
      ...(track.fadeIn ? ['afade=t=in:st=0:d=1'] : []),
      ...(delayMs > 0 ? [`adelay=${delayMs}:all=1`] : []),
      // Trim the line to the video length so amix duration=first stays exact.
      `atrim=0:${round3(total)}`,
      // Fade-out measured against the TIMELINE end (post-delay/trim).
      ...(track.fadeOut ? [`afade=t=out:st=${round3(Math.max(0, total - 1))}:d=1`] : []),
      ...(duckExpr ? [`volume='${duckExpr}':eval=frame`] : []),
    ];
    parts.push(`[${inputIdx}:a]${steps.join(',')}[${tag}]`);
    lines.push(`[${tag}]`);
  };
  const music =
    spec.music ??
    (spec.audio
      ? {
          url: spec.audio.url,
          ...(spec.audio.gainDb !== undefined ? { gainDb: spec.audio.gainDb } : {}),
        }
      : null);
  if (music && input.musicInput != null) addTrack(input.musicInput, music, 'am');
  if (spec.voiceover && input.voiceoverInput != null)
    addTrack(input.voiceoverInput, spec.voiceover, 'av');
  // E8: PiP audio joins the mix (trimmed, delayed to atSec)
  pips.forEach((ov, i) => {
    if (!ov.hasAudio || ov.clip.muted) return;
    const inS = Math.max(0, ov.clip.inSec ?? 0);
    const outS =
      ov.clip.outSec && ov.clip.outSec > inS
        ? Math.min(ov.clip.outSec, ov.sourceDur)
        : ov.sourceDur;
    const gain = Math.max(-40, Math.min(ov.clip.gainDb ?? 0, 20));
    const delayMs = Math.round(Math.max(0, ov.clip.atSec) * 1000);
    const steps = [
      `atrim=${round3(inS)}:${round3(outS)}`,
      'asetpts=PTS-STARTPTS',
      ...(gain !== 0 ? [`volume=${gain}dB`] : []),
      ...(delayMs > 0 ? [`adelay=${delayMs}:all=1`] : []),
      `atrim=0:${round3(total)}`,
    ];
    parts.push(`[${ov.inputIdx}:a]${steps.join(',')}[apip${i}]`);
    lines.push(`[apip${i}]`);
  });
  // Phase II: upper-track-layer audio. The normalized intermediate already baked
  // trim/speed/gain/mute, so the line just rides in at startSec, trimmed to total.
  layers.forEach((tl, i) => {
    if (!tl.hasAudio || tl.muted) return;
    const delayMs = Math.round(Math.max(0, tl.startSec) * 1000);
    const steps = [
      'asetpts=PTS-STARTPTS',
      ...(delayMs > 0 ? [`adelay=${delayMs}:all=1`] : []),
      `atrim=0:${round3(total)}`,
    ];
    parts.push(`[${tl.inputIdx}:a]${steps.join(',')}[atl${i}]`);
    lines.push(`[atl${i}]`);
  });
  // Timed SFX — each a short hit placed at atSec, gained, delayed and trimmed to
  // the timeline length so it rides UNDER the video and can't extend the output
  // (amix duration=first is governed by the video-length clip audio line).
  const sfxInputs = (input.sfxInputs ?? []).slice(0, 10);
  sfxInputs.forEach((sx, i) => {
    const gain = typeof sx.gainDb === 'number' ? Math.max(-40, Math.min(sx.gainDb, 20)) : 0;
    const delayMs = Math.round(Math.max(0, sx.atSec) * 1000);
    const steps = [
      `volume=${gain}dB`,
      ...(delayMs > 0 ? [`adelay=${delayMs}|${delayMs}`] : []),
      `atrim=0:${round3(total)}`,
    ];
    parts.push(`[${sx.inputIdx}:a]${steps.join(',')}[sfx${i}]`);
    lines.push(`[sfx${i}]`);
  });

  if (lines.length > 1) {
    parts.push(
      `${lines.join('')}amix=inputs=${lines.length}:duration=first:dropout_transition=0:normalize=0[amix]`,
    );
    aLabel = '[amix]';
  }
  parts.push(
    input.applyLoudnessNormalization === false
      ? `${aLabel}anull[aout]`
      : `${aLabel}loudnorm=I=-16:TP=-1.5:LRA=11[aout]`,
  );
  aLabel = '[aout]';

  return {
    filterComplex: parts.join(';'),
    videoLabel: vLabel,
    audioLabel: aLabel,
    totalDuration: total,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/**
 * Fit a requested output size under a per-side cap while PRESERVING aspect ratio.
 * The API advertises up to 3840 per side; clamping each axis INDEPENDENTLY to the
 * cap (the old `min(w,1920)` per axis) turned a 3840×2160 request into a squished
 * 1920×1920 — and text/PiP were still laid out against the original dims. Scaling
 * both axes by one factor keeps 16:9 as 1920×1080. Even dims (yuv420p needs them),
 * floored at 64. In-range sizes (≤ cap on both axes) pass through unchanged, so the
 * common 1280×720 / 1080×1920 specs stay byte-identical.
 *
 * The 64px floor only preserves aspect for ratios ≤ cap/64 = 30:1; a steeper ratio
 * would stretch the floored short side. The API rejects > 30:1 up front
 * (`render_bad_aspect`), so valid specs never reach that floor here — it stays a
 * defensive backstop, not an aspect-distorting path for real input.
 */
export function fitRenderDimensions(
  rawWidth: number | undefined,
  rawHeight: number | undefined,
  cap = 1920,
): { width: number; height: number } {
  const w = Math.max(1, rawWidth || 1280);
  const h = Math.max(1, rawHeight || 720);
  const scale = Math.min(1, cap / Math.max(w, h));
  const even = (n: number) => Math.max(64, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

// Auto-ducking ramp constants — MUST match apps/web/lib/ducking.ts
// (DUCK_ATTACK_SEC / DUCK_RELEASE_SEC). Only the hold windows + `db` travel on
// the spec; the ramps are reconstructed here so preview == export.
const DUCK_ATTACK_SEC = 0.25;
const DUCK_RELEASE_SEC = 0.4;

/**
 * ffmpeg `volume` expression implementing lib/ducking.ts `duckGainDbAt` exactly:
 * for each hold window a piecewise dB contribution (0 → duckDb attack ramp, hold,
 * duckDb → 0 release ramp, else 0), combined with `min` (most-ducked wins), then
 * converted to a linear factor via pow(10, dB/20). Lerp happens in dB on BOTH
 * sides — the parity contract. Returns null when there is nothing to duck.
 *
 * Commas inside the expression are escaped (`\,`) so the filtergraph parser does
 * not read them as filter separators — same convention as the setpts/drawtext
 * expressions elsewhere in this file.
 */
export function buildDuckVolumeExpr(
  segments: { fromSec: number; toSec: number }[],
  db: number,
): string | null {
  if (!segments || segments.length === 0) return null;
  const d = round3(Math.max(-40, Math.min(0, db)));
  const atk = DUCK_ATTACK_SEC;
  const rel = DUCK_RELEASE_SEC;
  const contrib = (s: { fromSec: number; toSec: number }): string => {
    const a = round3(Math.max(0, s.fromSec));
    const b = round3(Math.max(a, s.toSec));
    const pa = round3(a - atk);
    const pb = round3(b + rel);
    // if(t<pa,0, if(t<a, d*(t-pa)/atk, if(t<b, d, if(t<pb, d*(1-(t-b)/rel), 0))))
    return (
      `if(lt(t\\,${pa})\\,0\\,` +
      `if(lt(t\\,${a})\\,${d}*(t-${pa})/${atk}\\,` +
      `if(lt(t\\,${b})\\,${d}\\,` +
      `if(lt(t\\,${pb})\\,${d}*(1-(t-${b})/${rel})\\,0))))`
    );
  };
  const contribs = segments.map(contrib);
  // min() over all contributions — most-ducked (most-negative) wins on overlap.
  // Combine as a BALANCED tree (depth ⌈log2 N⌉), not a right-nested reduce (depth
  // N): ffmpeg's recursive expression parser fails on deep nesting (~93 segments
  // of `min(a,min(b,min(c,…)))` → "Error when evaluating the volume expression"),
  // while a balanced tree of the schema-max 120 windows stays ~7 deep. min() is
  // associative so the value is identical.
  const balancedMin = (xs: string[]): string => {
    if (xs.length === 1) return xs[0]!;
    const mid = Math.floor(xs.length / 2);
    return `min(${balancedMin(xs.slice(0, mid))}\\,${balancedMin(xs.slice(mid))})`;
  };
  const minExpr = balancedMin(contribs);
  return `pow(10\\,(${minExpr})/20)`;
}

/**
 * Colour grade (E3) → ffmpeg chain. null when absent/neutral so untouched
 * clips keep their legacy args. Slider→filter maps chosen to track the CSS
 * preview (preview≈render parity):
 *  brightness ±100 → eq brightness ±0.3 · contrast ±100 → eq 0.5..1.5
 *  saturation ±100 → eq 0..2 · temperature +100 → 3900K / −100 → 9100K
 *  highlight/shadow ±100 → curves control points (0.75/0.25 regions)
 *  vignette 0..100 → vignette angle PI/5..PI/2 · grain 0..100 → noise 0..20
 */
/** S3 subsystem D: tone-curve presets → ffmpeg `curves` arguments. The 6
 * "Looks" (warm-film…faded-polaroid) mirror CURVE_CSS in the web _model.ts —
 * eq brightness/contrast/saturation ≈ CSS brightness/contrast/saturate, ffmpeg
 * `hue` h= ≈ CSS hue-rotate, so preview≈render holds for the same reason the
 * original 7 do. */
const CURVE_PRESETS: Record<NonNullable<StudioColor['curve']>, string> = {
  lighten: `curves=all='0/0.08 0.5/0.62 1/1'`,
  darken: `curves=all='0/0 0.5/0.38 1/0.92'`,
  fade: `curves=all='0/0.12 1/0.92'`,
  contrast: `curves=all='0/0 0.25/0.16 0.75/0.84 1/1'`,
  cool: `curves=b='0/0.06 1/1':r='0/0 1/0.93'`,
  warm: `curves=r='0/0.05 1/1':b='0/0 1/0.9'`,
  vintage: `curves=all='0/0.1 0.5/0.52 1/0.9':b='0/0.06 1/0.92'`,
  'warm-film': `eq=saturation=1.1:contrast=1.06:brightness=0.02,curves=r='0/0.04 1/1':b='0/0 1/0.9'`,
  'cool-film': `hue=h=-10:s=0.92,eq=contrast=1.05:brightness=0.01`,
  noir: `eq=saturation=0.2:contrast=1.35:brightness=-0.06`,
  // Same CSS limitation applies: ffmpeg `hue` can't split shadows/highlights by
  // colour either — approximated as a global hue shift + saturation push.
  'teal-orange': `hue=h=8:s=1.35,eq=contrast=1.1`,
  'bleach-bypass': `eq=saturation=0.5:contrast=1.4:brightness=0.08`,
  'faded-polaroid': `eq=contrast=0.8:brightness=0.1,curves=r='0/0.03 1/1':b='0/0 1/0.94'`,
};

export function buildColorChain(color: StudioColor | undefined): string | null {
  if (!color) return null;
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0;
  const b = num(color.brightness, -100, 100);
  const c = num(color.contrast, -100, 100);
  const s = num(color.saturation, -100, 100);
  const t = num(color.temperature, -100, 100);
  const hi = num(color.highlight, -100, 100);
  const sh = num(color.shadow, -100, 100);
  const vg = num(color.vignette, 0, 100);
  const gr = num(color.grain, 0, 100);
  const curve = color.curve && CURVE_PRESETS[color.curve] ? color.curve : null;
  // S3 HSL: one ffmpeg `huesaturation` per adjusted colour range.
  const hslParts: string[] = [];
  if (color.hsl) {
    for (const ch of ['r', 'y', 'g', 'c', 'b', 'm'] as const) {
      const a = color.hsl[ch];
      if (!a) continue;
      const h = num(a.h, -180, 180);
      const sat = num(a.s, -100, 100) / 100;
      const lum = num(a.l, -100, 100) / 100;
      if (h || sat || lum) {
        hslParts.push(
          `huesaturation=hue=${round3(h)}:saturation=${round3(sat)}:intensity=${round3(lum)}:colors=${ch}`,
        );
      }
    }
  }
  if (!b && !c && !s && !t && !hi && !sh && !vg && !gr && !curve && hslParts.length === 0)
    return null;

  const parts: string[] = [];
  if (b || c || s) {
    const eq: string[] = [];
    if (b) eq.push(`brightness=${round3((b / 100) * 0.3)}`);
    if (c) eq.push(`contrast=${round3(1 + c / 200)}`);
    if (s) eq.push(`saturation=${round3(Math.max(0, 1 + s / 100))}`);
    parts.push(`eq=${eq.join(':')}`);
  }
  if (t) parts.push(`colortemperature=temperature=${Math.round(6500 - t * 26)}`);
  if (hi || sh) {
    const pts = ['0/0'];
    if (sh) pts.push(`0.25/${round3(Math.min(0.6, Math.max(0.02, 0.25 + (sh / 100) * 0.15)))}`);
    if (hi) pts.push(`0.75/${round3(Math.min(0.98, Math.max(0.4, 0.75 + (hi / 100) * 0.15)))}`);
    pts.push('1/1');
    parts.push(`curves=all='${pts.join(' ')}'`);
  }
  if (curve) parts.push(CURVE_PRESETS[curve]);
  parts.push(...hslParts);
  if (vg)
    parts.push(`vignette=a=${round3(Math.PI / 5 + (vg / 100) * (Math.PI / 2 - Math.PI / 5))}`);
  if (gr) parts.push(`noise=alls=${Math.round(gr * 0.2)}:allf=t+u`);
  return parts.join(',');
}

/** #RRGGBB → [r,g,b] 0–255 (default black) for geq composites over the bg. */
export function hexToRgb(hex: string | undefined): [number, number, number] {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Fold binary ffmpeg `min(a,b)` over a list (the expr language has no n-ary min). */
function nestMin(xs: string[]): string {
  return xs.reduce((acc, x) => (acc ? `min(${acc},${x})` : x), '');
}

/**
 * Freeform polygon mask → geq alpha expression over normalized frame coords
 * nx=X/W, ny=Y/H (points are 0–1 fractions). NO rasterization: the polygon is
 * compiled straight into arithmetic.
 *
 * Inside test = even-odd ray casting (PNPOLY, W. R. Franklin), unrolled over the
 * vertices in TS since ffmpeg expressions have no loops. For each edge (prev→cur)
 * a horizontal ray to the right crosses it iff the edge straddles ny AND nx sits
 * left of the edge's x at height ny; `mod(Σcrossings,2)` is the parity → 1 inside.
 * Horizontal edges (Δy≈0) never cross a horizontal ray and are dropped (also
 * avoids a divide-by-zero in the slope).
 *
 * Feather (>0) = a true polygon signed-edge ramp: min point-to-segment distance
 * to the boundary, eroding inward exactly like the circle/rect shapes' feather
 * (outside stays hard 0 via the inside gate). Distance is measured in normalized
 * space, so it's mildly anisotropic on non-square frames — the documented coarse
 * approximation the CSS gaussian-blur mirror shares. Returns the shape alpha in
 * [0,1] BEFORE invert (caller applies `1-…`). Empty string when <3 points.
 */
export function freeformMaskExpr(points: { x: number; y: number }[], feather: number): string {
  const pts = points.slice(0, 16);
  if (pts.length < 3) return '';
  const nx = 'X/W';
  const ny = 'Y/H';
  const cross: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = pts[i]!;
    const prev = pts[(i + pts.length - 1) % pts.length]!;
    if (Math.abs(cur.y - prev.y) < 1e-6) continue; // horizontal edge
    const slope = (prev.x - cur.x) / (prev.y - cur.y);
    const b = round3(slope);
    const a = round3(cur.x - slope * cur.y); // edge x at height ny = a + b*ny
    const yi = round3(cur.y);
    const yj = round3(prev.y);
    cross.push(`abs(gt(${yi},${ny})-gt(${yj},${ny}))*lt(${nx},${a}+(${b})*(${ny}))`);
  }
  const inside = cross.length ? `mod(${cross.join('+')},2)` : '0';
  const f = (Math.max(0, Math.min(100, feather)) / 100) * 0.4;
  if (f < 0.006) return inside;
  const dists: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const c = pts[(i + 1) % pts.length]!;
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) continue; // degenerate edge
    const ax = round3(a.x);
    const ay = round3(a.y);
    const dxr = round3(dx);
    const dyr = round3(dy);
    const l2r = round3(l2);
    const t = `clip(((${nx}-${ax})*(${dxr})+(${ny}-${ay})*(${dyr}))/${l2r},0,1)`;
    dists.push(`hypot(${nx}-(${ax}+(${t})*(${dxr})),${ny}-(${ay}+(${t})*(${dyr})))`);
  }
  if (!dists.length) return inside;
  return `${inside}*clip(${nestMin(dists)}/${round3(f)},0,1)`;
}

/**
 * S3 subsystems C (Mask) + D-Blend (Opacity) → one per-pixel geq that lerps the
 * clip toward the composition background by a combined alpha:
 *   out = bg + (clip − bg) · α,   α = shapeMask · opacity
 * α=1 shows the clip, α=0 falls through to the bg — which is exactly what the
 * CSS clip-path/opacity preview shows, so preview==export holds. Null when
 * neutral (no mask, opacity 1) so untouched clips keep their legacy args.
 */
export function buildMaskBlendChain(opts: {
  mask?: StudioClip['mask'];
  opacity?: number;
  mode?: StudioClip['blendMode'];
  bg: [number, number, number];
}): string | null {
  const op = typeof opts.opacity === 'number' ? Math.max(0, Math.min(1, opts.opacity)) : 1;
  const m = opts.mask;
  // A freeform mask with <3 vertices draws nothing → treat as no mask.
  const hasMask =
    !!m && m.shape !== 'none' && (m.shape !== 'freeform' || (m.points?.length ?? 0) >= 3);
  const mode = opts.mode && opts.mode !== 'normal' ? opts.mode : null;
  if (op >= 1 && !hasMask && !mode) return null;
  const [R, G, B] = opts.bg;
  // Blend mode against the bg channel `bgc`, applied to clip channel `src`.
  const blended = (src: string, bgc: number): string => {
    if (mode === 'multiply') return `${src}*${bgc}/255`;
    if (mode === 'screen') return `255-(255-${src})*${255 - bgc}/255`;
    if (mode === 'overlay')
      return bgc < 128 ? `2*${src}*${bgc}/255` : `255-2*(255-${src})*${255 - bgc}/255`;
    return src;
  };
  let alpha = `${round3(op)}`;
  if (hasMask) {
    const feather = Math.max(0.006, ((m!.feather ?? 0) / 100) * 0.4);
    let shape: string;
    if (m!.shape === 'freeform') {
      shape = freeformMaskExpr(m!.points ?? [], m!.feather ?? 0);
    } else if (m!.shape === 'circle') {
      shape = `clip((1-(hypot(X-W/2,Y-H/2)/(min(W,H)/2)))/${round3(feather)},0,1)`;
    } else if (m!.shape === 'rect') {
      const dx = `min(X-W*0.16,W*0.84-X)/(W*${round3(feather)})`;
      const dy = `min(Y-H*0.16,H*0.84-Y)/(H*${round3(feather)})`;
      shape = `clip(min(${dx},${dy}),0,1)`;
    } else if (m!.shape === 'diamond') {
      // L1 (taxicab) distance from centre — an exact diamond touching the
      // frame's edge midpoints, matching the CSS clip-path polygon 1:1.
      shape = `clip((1-(abs(X-W/2)/(W/2)+abs(Y-H/2)/(H/2)))/${round3(feather)},0,1)`;
    } else if (m!.shape === 'star') {
      // Exact 5-point star polygon via polar boundary-per-wedge: fold the
      // angle into the symmetric [0,π/5] wedge around each tip, then the
      // straight edge between the outer tip (radius R) and the inner valley
      // (radius R·ratio) has a closed-form polar radius r(α) = c/(a·cosα+b·sinα)
      // (line-through-two-polar-points formula) — same shape the CSS star
      // polygon draws, just expressed algebraically for geq.
      const sin36 = round3(Math.sin(Math.PI / 5));
      const cos36 = round3(Math.cos(Math.PI / 5));
      // Inner/outer radius ratio of the CSS/SVG star (STAR_PATH in _model.ts).
      // STAR_PATH is the canonical 5-point pentagram whose inner vertices sit at
      // sin(18°)/sin(54°) ≈ 0.382 of the outer radius — NOT 0.5 (that draws a
      // visibly rounder/fatter star than the preview, breaking preview==export).
      const ratio = 0.382;
      const router = 'min(W,H)/2';
      const rinner = `(${router})*${ratio}`;
      const a = `(${rinner})*${sin36}`;
      const b = `(${router})-(${rinner})*${cos36}`;
      const cc = `(${router})*(${rinner})*${sin36}`;
      // +4*PI keeps the mod() input positive regardless of ffmpeg's mod sign
      // convention, before folding into the tip-centred wedge. The extra
      // +PI/5 phase-shifts the fold so phi=0 (a tip, per rBoundary below)
      // lands on the "straight up" screen direction (atan2=-PI/2), matching
      // the CSS/SVG star (STAR_PATH in _model.ts) whose first point (50,0)
      // is a tip pointing straight up — without it, phi=0 landed on a valley
      // instead, rendering a rotated (36°-off) star vs. the editor preview.
      const phi = `mod(atan2(Y-H/2,X-W/2)+PI/2+PI/5+4*PI,2*PI/5)-PI/5`;
      const rBoundary = `(${cc})/((${a})*cos(abs(${phi}))+(${b})*sin(abs(${phi})))`;
      shape = `clip((1-hypot(X-W/2,Y-H/2)/(${rBoundary}))/${round3(feather)},0,1)`;
    } else if (m!.shape === 'heart') {
      // Approximation (no closed-form geq heart is practical): the implicit
      // heart curve (x²+y²−1)³−x²y³≤0, rescaled to frame coords and flipped
      // so the cusp sits at the top (screen Y grows down). The cubic term
      // flattens the gradient near the boundary to almost nothing, so ×40
      // rescales it back to an edge width comparable to the other shapes.
      const hx = `(X-W/2)/(W*0.35)`;
      const hy = `-(Y-H*0.45)/(H*0.4)`;
      const r2 = `((${hx})*(${hx})+(${hy})*(${hy})-1)`;
      const impl = `(${r2})*(${r2})*(${r2})-(${hx})*(${hx})*(${hy})*(${hy})*(${hy})`;
      shape = `clip((0-(${impl})*40)/${round3(feather)},0,1)`;
    } else if (m!.shape === 'cinematic-bars') {
      // Fixed 12%-of-frame letterbox bars, no feather (hard cut) — simplest
      // correct read of "cinematic bars": two opaque bands, not a soft shape.
      shape = `if(lt(Y,H*0.12),0,if(gt(Y,H*0.88),0,1))`;
    } else {
      // linear: reveal the lower half with a vertical feathered edge
      shape = `clip((Y-H*0.5)/(H*${round3(feather)})+0.5,0,1)`;
    }
    if (m!.invert) shape = `(1-(${shape}))`;
    alpha = op >= 1 ? shape : `(${shape})*${round3(op)}`;
  }
  return (
    `format=gbrp,` +
    `geq=r='${R}+((${blended('r(X,Y)', R)})-${R})*(${alpha})':` +
    `g='${G}+((${blended('g(X,Y)', G)})-${G})*(${alpha})':` +
    `b='${B}+((${blended('b(X,Y)', B)})-${B})*(${alpha})',` +
    `format=yuv420p`
  );
}

/** Clamp a transform to its UI ranges; null when absent or identity —
 * identity clips MUST take the legacy chain (byte-identical args). */
export function clampTransform(t: StudioTransform | undefined): {
  scale: number;
  posX: number;
  posY: number;
  rotate: number;
  crop: { left: number; top: number; right: number; bottom: number };
} | null {
  if (!t) return null;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  const out = {
    scale: num(t.scale, 0.2, 3, 1),
    posX: num(t.posX, -100, 100, 0),
    posY: num(t.posY, -100, 100, 0),
    rotate: num(t.rotate, -180, 180, 0),
    crop: {
      left: num(t.crop?.left, 0, 0.45, 0),
      top: num(t.crop?.top, 0, 0.45, 0),
      right: num(t.crop?.right, 0, 0.45, 0),
      bottom: num(t.crop?.bottom, 0, 0.45, 0),
    },
  };
  const c = out.crop;
  const identity =
    out.scale === 1 &&
    out.posX === 0 &&
    out.posY === 0 &&
    out.rotate === 0 &&
    c.left === 0 &&
    c.top === 0 &&
    c.right === 0 &&
    c.bottom === 0;
  return identity ? null : out;
}

/**
 * Video graph for a transformed clip (E2): crop → fit → user scale → colour
 * filter → rotate (transparent corners) → overlay onto a frame-sized base at
 * the offset. Mirrors the CSS preview transform exactly.
 */
/** Sanitize an ffmpeg colour token — a 6-digit hex (#RRGGBB) or a safe named
 * colour; anything else falls back to black so a bad value can't inject args. */
export function sanitizeBgColor(c: string | undefined): string {
  if (!c) return 'black';
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return `0x${c.slice(1)}`;
  if (/^[a-zA-Z]{3,20}$/.test(c)) return c;
  return 'black';
}

export function buildTransformGraph(opts: {
  transform: NonNullable<ReturnType<typeof clampTransform>>;
  filterChain: string | null;
  speed: number;
  width: number;
  height: number;
  fps: number;
  /** S3 subsystem G: letterbox/canvas background colour (default black). */
  bgColor?: string;
  /** E4 temporal/geometry ops folded into the composite. */
  flips?: string[];
  reversed?: boolean;
  freezeDur?: number | null;
  /** E5: full setpts filter (speed ramp) replacing the uniform speed. */
  setptsExpr?: string | null;
  /** E6: entrance/exit animation filters (output-time, post-setpts). */
  animChain?: string[];
  /** Phase II: render onto a TRANSPARENT frame-sized canvas (yuva) so the clip
   * can ride an upper track and alpha-composite over the base. The base track
   * keeps the opaque path. */
  alpha?: boolean;
  /** Phase II: static layer opacity 0–1 baked into the alpha channel (upper
   * tracks only — the base track has nothing to show through to). */
  layerOpacity?: number;
}): string {
  const { transform: t, filterChain, speed, width, height, fps } = opts;
  const alpha = opts.alpha === true;
  const bg = alpha ? 'black@0' : sanitizeBgColor(opts.bgColor);
  const flips = opts.flips ?? [];
  const c = t.crop;
  const cropW = Math.max(0.1, 1 - c.left - c.right);
  const cropH = Math.max(0.1, 1 - c.top - c.bottom);
  const layer: string[] = [];
  if (opts.freezeDur) layer.push('trim=end_frame=1', 'setpts=PTS-STARTPTS');
  // alpha layers carry an alpha channel from the start so crop/scale/rotate and
  // the transparent-base overlay all preserve it.
  if (alpha) layer.push('format=rgba');
  if (cropW < 1 || cropH < 1) {
    layer.push(
      `crop=iw*${round3(cropW)}:ih*${round3(cropH)}:iw*${round3(c.left)}:ih*${round3(c.top)}`,
    );
  }
  layer.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
  if (t.scale !== 1) {
    // even dimensions keep yuv420p happy after the composite
    layer.push(`scale=trunc(iw*${round3(t.scale)}/2)*2:trunc(ih*${round3(t.scale)}/2)*2`);
  }
  layer.push(...flips);
  if (filterChain) layer.push(filterChain);
  if (t.rotate !== 0) {
    const rad = `${round3(t.rotate)}*PI/180`;
    layer.push('format=rgba', `rotate=${rad}:c=black@0:ow=rotw(${rad}):oh=roth(${rad})`);
  }
  const px = Math.round((t.posX / 100) * width);
  const py = Math.round((t.posY / 100) * height);
  const op =
    typeof opts.layerOpacity === 'number' ? Math.max(0, Math.min(1, opts.layerOpacity)) : 1;
  const post: string[] = [
    alpha ? 'format=yuva444p10le' : 'format=yuv420p',
    'setsar=1',
    ...(alpha && op < 1 ? [`colorchannelmixer=aa=${round3(op)}`] : []),
    ...(opts.freezeDur ? [`tpad=stop_mode=clone:stop_duration=${round3(opts.freezeDur)}`] : []),
    ...(opts.reversed && !opts.freezeDur ? ['reverse'] : []),
    ...(opts.setptsExpr && !opts.freezeDur
      ? [opts.setptsExpr]
      : speed !== 1 && !opts.freezeDur
        ? [`setpts=PTS/${speed}`]
        : []),
    ...(opts.animChain ?? []),
    `fps=${fps}`,
  ];
  return (
    `color=${bg}:s=${width}x${height}:r=${fps}[xbase];` +
    `[0:v]${layer.join(',')}[xclip];` +
    `[xbase][xclip]overlay=x=(W-w)/2+${px}:y=(H-h)/2+${py}:shortest=1,${post.join(',')}[vout]`
  );
}

/** Args for the pass-1 per-clip normalization (trim/scale/pad/fps/speed/volume). */
export function buildNormalizeArgs(opts: {
  clip: StudioClip;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  outFile: string;
  /** S3 subsystem G: composition background colour for the letterbox bars. */
  bgColor?: string;
  /** Phase II: normalize an UPPER-TRACK clip onto a transparent frame-sized
   * canvas (ProRes 4444 / yuva intermediate) so it alpha-composites over the
   * base in pass 2. Forces the transform path; static opacity is baked into the
   * alpha channel. Mask/blend are NOT applied here (gated to base track) — they
   * need lower-layer compositing the overlay path can't honour yet. */
  alpha?: boolean;
}): string[] {
  const { clip, hasAudio, width, height, fps, outFile } = opts;
  const alpha = opts.alpha === true;
  const bg = sanitizeBgColor(opts.bgColor);
  // E4: a freeze clip holds ONE frame — speed/trim don't apply, audio is
  // silent (clip sound makes no sense on a still).
  const freezeDur = clip.freeze ? Math.max(0.5, Math.min(clip.freeze.durSec, 10)) : null;
  // E5: a speed ramp needs the trimmed length for its piecewise expression —
  // requires explicit trim bounds (the editor always sends them).
  const rampLen =
    !freezeDur &&
    clip.speedCurve &&
    SPEED_CURVES[clip.speedCurve] &&
    typeof clip.outSec === 'number' &&
    clip.outSec > (clip.inSec ?? 0)
      ? clip.outSec - (clip.inSec ?? 0)
      : null;
  const ramp = rampLen ? buildSpeedRamp(clip.speedCurve!, rampLen) : null;
  const speed = freezeDur ? 1 : ramp ? ramp.avgSpeed : clampSpeed(clip.speed);
  const reversed = clip.reversed === true && !freezeDur;
  // E6: animations run in OUTPUT time — exits need the clip's out-duration
  // (known for freeze clips and explicitly trimmed clips).
  const trimLen =
    typeof clip.outSec === 'number' && clip.outSec > (clip.inSec ?? 0)
      ? clip.outSec - (clip.inSec ?? 0)
      : null;
  const outDur = freezeDur ?? (ramp ? ramp.outDuration : trimLen ? trimLen / speed : null);
  // Output-time MOTION (entrance/exit anims + keyframes) pad/rotate with OPAQUE
  // black and the opacity geq drops the alpha channel — all fine over the base
  // track, but they destroy an ALPHA (upper-track) layer's transparency. Gate
  // them off for alpha layers (mirrors the mask/blend gating). The API also
  // strips these from track clips; this keeps the invariant for any spec source.
  const animChain = alpha
    ? []
    : buildAnimChain({
        animIn: clip.animIn,
        animOut: clip.animOut,
        outDur,
        width,
        height,
        fps,
      });
  // E7: keyframes run after the entrance/exit anims, same output-time base
  const kfChain =
    !alpha && clip.keyframes && Object.values(clip.keyframes).some((a) => a && a.length > 0)
      ? buildKeyframeChain({ keyframes: clip.keyframes, width, height, fps })
      : [];
  animChain.push(...kfChain);
  const flips = [...(clip.flipH ? ['hflip'] : []), ...(clip.flipV ? ['vflip'] : [])];
  const pre: string[] = ['-y'];
  if (freezeDur) {
    pre.push('-ss', String(Math.max(0, clip.freeze!.atSec)));
  } else {
    if (typeof clip.inSec === 'number' && clip.inSec > 0) pre.push('-ss', String(clip.inSec));
    if (typeof clip.outSec === 'number' && clip.outSec > 0) pre.push('-to', String(clip.outSec));
  }
  pre.push('-i', clip.url);
  if (!hasAudio || freezeDur) {
    pre.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  const presetChain =
    clip.filter && clip.filter !== 'none'
      ? FILTER_VF[clip.filter as Exclude<StudioFilter, 'none'>]
      : null;
  // E3: colour-grade sliders append after the legacy preset (both may exist
  // on old projects); untouched clips contribute nothing.
  const colorChain = buildColorChain(clip.color);
  // S3 C/D: mask + static opacity, lerped toward the composition background.
  const maskBlendChain = buildMaskBlendChain({
    ...(clip.mask ? { mask: clip.mask } : {}),
    ...(typeof clip.opacity === 'number' ? { opacity: clip.opacity } : {}),
    ...(clip.blendMode ? { mode: clip.blendMode } : {}),
    bg: hexToRgb(opts.bgColor),
  });
  // Alpha (upper-track) clips skip mask/blend (deferred — they need lower-layer
  // compositing); their static opacity is baked as alpha by the transform graph.
  const filterChain = alpha
    ? [presetChain, colorChain].filter(Boolean).join(',') || null
    : [presetChain, colorChain, maskBlendChain].filter(Boolean).join(',') || null;
  // E2: a non-identity transform swaps the fixed scale+pad for a composite
  // graph; identity clips keep the LEGACY chain byte-for-byte. Alpha clips ALWAYS
  // take the composite path (onto a transparent canvas).
  const baseTransform = clampTransform(clip.transform);
  const transform =
    alpha && !baseTransform
      ? { scale: 1, posX: 0, posY: 0, rotate: 0, crop: { left: 0, top: 0, right: 0, bottom: 0 } }
      : baseTransform;
  const vf = [
    ...(freezeDur ? ['trim=end_frame=1', 'setpts=PTS-STARTPTS'] : []),
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${bg}`,
    'setsar=1',
    ...flips,
    ...(filterChain ? [filterChain] : []),
    ...(freezeDur ? [`tpad=stop_mode=clone:stop_duration=${freezeDur}`] : []),
    ...(reversed ? ['reverse'] : []),
    ...(ramp ? [ramp.setpts] : speed !== 1 ? [`setpts=PTS/${speed}`] : []),
    ...animChain,
    `fps=${fps}`,
  ].join(',');

  const gain = clip.muted
    ? -120
    : typeof clip.volumeDb === 'number'
      ? Math.max(-40, Math.min(clip.volumeDb, 20))
      : 0;
  const af = [
    // `anullsrc` is infinite, but `-shortest` can stop before AAC emits its
    // first packet on sub-second silent clips. `apad` keeps audio packets
    // flowing until the video stream ends, so pass 2 always receives a real
    // audio timeline (not merely an empty stream declaration).
    ...(!hasAudio || freezeDur ? ['apad'] : []),
    ...(reversed ? ['areverse'] : []),
    // ramps land audio on the same duration via the AVERAGE tempo (audio
    // can't ramp piecewise with stock filters — documented approximation)
    ...buildAtempoChain(round3(speed)),
    ...(gain !== 0 ? [`volume=${gain}dB`] : []),
  ];

  // freeze uses the silent lavfi line even when the source has audio
  const audioMap = hasAudio && !freezeDur ? '0:a:0' : '1:a:0';
  const videoArgs = transform
    ? [
        '-filter_complex',
        buildTransformGraph({
          transform,
          filterChain,
          speed,
          width,
          height,
          fps,
          ...(opts.bgColor ? { bgColor: opts.bgColor } : {}),
          flips,
          reversed,
          freezeDur,
          setptsExpr: ramp?.setpts ?? null,
          animChain,
          ...(alpha ? { alpha: true, layerOpacity: clip.opacity ?? 1 } : {}),
        }),
        '-map',
        '[vout]',
        '-map',
        audioMap,
      ]
    : // legacy chain — byte-identical to the pre-E2 builder
      ['-map', '0:v:0', '-map', audioMap, '-vf', vf];

  // Alpha (upper-track) intermediates use ProRes 4444 (yuva444p10le) so the
  // alpha channel survives to pass-2 compositing; the base track keeps H.264
  // at a fixed timescale (xfade/concat need matching timebases).
  const videoCodec = alpha
    ? ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
  return [
    ...pre,
    ...videoArgs,
    ...(freezeDur ? ['-t', String(freezeDur)] : []),
    ...(af.length ? ['-af', af.join(',')] : []),
    ...videoCodec,
    '-c:a',
    'aac',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-shortest',
    ...(alpha ? [] : ['-video_track_timescale', '15360']),
    outFile,
  ];
}
