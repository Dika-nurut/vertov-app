// Studio editor — domain model: types, constants, and pure helpers extracted
// from StudioClient.tsx (review #1: shrink the ~6k-line component). No React
// state lives here; the dependency is one-way (the component imports this).
import type * as React from 'react';
import {
  ArrowLeftRight,
  Captions,
  Film,
  Gauge,
  Layers,
  Music,
  SlidersHorizontal,
  Sparkles,
  Type,
  Volume2,
  Zap,
} from './_icons';

// Speed-ramp kind — referenced by TClip; the runtime speed helpers still live in
// StudioClient for now (a later "timeline model" extraction will join them here).
export type SpeedCurve = 'montage' | 'hero' | 'flash';

export interface StudioClip {
  id: string;
  assetUrl: string;
  createdAt?: string;
}

export type Transition =
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
export type Filter = 'none' | 'warm' | 'cool' | 'mono' | 'punch';

/** Per-clip transform (E2) — values mirror the ffmpeg chain 1:1. */
export interface TTransform {
  scale: number;
  posX: number;
  posY: number;
  rotate: number;
  crop: { left: number; top: number; right: number; bottom: number };
}
export const DEFAULT_TRANSFORM: TTransform = {
  scale: 1,
  posX: 0,
  posY: 0,
  rotate: 0,
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
};
export const isIdentityTransform = (t: TTransform | undefined): boolean =>
  !t ||
  (t.scale === 1 &&
    t.posX === 0 &&
    t.posY === 0 &&
    t.rotate === 0 &&
    t.crop.left === 0 &&
    t.crop.top === 0 &&
    t.crop.right === 0 &&
    t.crop.bottom === 0);

/** CSS mirror of the render transform: crop clips first (clip-path), then
 * the whole element translates/rotates/scales — same order as the ffmpeg
 * graph (crop → fit → scale → rotate → overlay offset). */
export function transformStyle(t: TTransform | undefined): React.CSSProperties {
  if (isIdentityTransform(t)) return {};
  const tr = t!;
  return {
    clipPath:
      tr.crop.left || tr.crop.top || tr.crop.right || tr.crop.bottom
        ? `inset(${tr.crop.top * 100}% ${tr.crop.right * 100}% ${tr.crop.bottom * 100}% ${tr.crop.left * 100}%)`
        : undefined,
    transform: `translate(${tr.posX}%, ${tr.posY}%) rotate(${tr.rotate}deg) scale(${tr.scale})`,
  };
}

/** Per-clip colour grade (E3) — centered ±100 sliders; vignette/grain 0–100. */
export type CurvePreset =
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
export const CURVE_LABELS: Record<CurvePreset, string> = {
  lighten: 'Светлее',
  darken: 'Темнее',
  fade: 'Выцвет',
  contrast: 'Контраст',
  cool: 'Холод',
  warm: 'Тепло',
  vintage: 'Винтаж',
  'warm-film': 'Плёнка тёплая',
  'cool-film': 'Плёнка холодная',
  noir: 'Нуар',
  'teal-orange': 'Тил-оранж',
  'bleach-bypass': 'Байпас отбеливания',
  'faded-polaroid': 'Выцветший полароид',
};
/** Approximate CSS mirror of the ffmpeg curve presets (preview≈render, same
 * standard as the 8-slider grade above). The 6 "Looks" (warm-film…faded-polaroid)
 * are original hand-tuned film-emulation grades — approximated with the same CSS
 * filter primitives, not arbitrary .cube LUT upload (no canvas/WebGL preview layer
 * exists, and an "approximate preview" exception to preview==export is a no-go). */
export const CURVE_CSS: Record<CurvePreset, string> = {
  lighten: 'brightness(1.12)',
  darken: 'brightness(0.9)',
  fade: 'contrast(0.85) brightness(1.06)',
  contrast: 'contrast(1.22)',
  cool: 'hue-rotate(-6deg) saturate(1.05)',
  warm: 'sepia(0.18) saturate(1.05)',
  vintage: 'sepia(0.32) contrast(0.92) brightness(1.03)',
  'warm-film': 'sepia(0.22) saturate(1.1) contrast(1.06) brightness(1.02)',
  'cool-film': 'hue-rotate(-10deg) saturate(0.92) contrast(1.05) brightness(1.01)',
  noir: 'grayscale(0.85) contrast(1.35) brightness(0.94)',
  // CSS can't split shadows/highlights by colour like a real teal-orange grade —
  // approximated as a moderate hue-shift + saturation push across the whole image.
  'teal-orange': 'hue-rotate(8deg) saturate(1.35) contrast(1.1)',
  'bleach-bypass': 'grayscale(0.4) contrast(1.4) brightness(1.08)',
  'faded-polaroid': 'brightness(1.1) contrast(0.8) sepia(0.12) saturate(0.85)',
};

export interface TColor {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  highlight: number;
  shadow: number;
  vignette: number;
  grain: number;
  /** S3 subsystem D: tone-curve preset. */
  curve?: CurvePreset;
  /** S3 subsystem D: per-colour-range HSL. */
  hsl?: THsl;
}
export type HslChannel = 'r' | 'y' | 'g' | 'c' | 'b' | 'm';
export interface THslAdjust {
  h?: number;
  s?: number;
  l?: number;
}
export type THsl = Partial<Record<HslChannel, THslAdjust>>;
export const HSL_SWATCHES: { ch: HslChannel; color: string; label: string }[] = [
  { ch: 'r', color: '#e0564a', label: 'Красный' },
  { ch: 'y', color: '#e0b24a', label: 'Жёлтый' },
  { ch: 'g', color: '#4ea35a', label: 'Зелёный' },
  { ch: 'c', color: '#4ab6c4', label: 'Голубой' },
  { ch: 'b', color: '#4a6fe0', label: 'Синий' },
  { ch: 'm', color: '#9a4ae0', label: 'Пурпур' },
];
export const hslActive = (h: THsl | undefined): boolean =>
  !!h && Object.values(h).some((a) => !!a && !!(a.h || a.s || a.l));
export const DEFAULT_COLOR: TColor = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  highlight: 0,
  shadow: 0,
  vignette: 0,
  grain: 0,
};
export const isNeutralColor = (c: TColor | undefined): boolean =>
  !c ||
  (!c.curve &&
    !hslActive(c.hsl) &&
    (Object.keys(DEFAULT_COLOR) as (keyof TColor)[]).every((k) => (c[k] ?? 0) === 0));

/** CSS mirror of buildColorChain (preview≈render). highlight/shadow are a
 * tone-curve op CSS can't express — approximated with gentle brightness/
 * contrast nudges; vignette/grain render as overlay divs. */
export function colorCss(c: TColor | undefined): string {
  if (isNeutralColor(c)) return '';
  const g = c!;
  const parts: string[] = [];
  if (g.brightness) parts.push(`brightness(${1 + (g.brightness / 100) * 0.3})`);
  if (g.contrast) parts.push(`contrast(${1 + g.contrast / 200})`);
  if (g.saturation) parts.push(`saturate(${Math.max(0, 1 + g.saturation / 100)})`);
  if (g.temperature > 0) parts.push(`sepia(${(g.temperature / 100) * 0.35})`);
  if (g.temperature < 0) parts.push(`hue-rotate(${(g.temperature / 100) * 12}deg)`);
  if (g.shadow) parts.push(`brightness(${1 + (g.shadow / 100) * 0.06})`);
  if (g.highlight) parts.push(`contrast(${1 + (g.highlight / 100) * 0.06})`);
  if (g.curve) parts.push(CURVE_CSS[g.curve]);
  // HSL is per-hue (CSS can't target a single hue) — show an aggregate nudge as
  // a coarse indication; the ffmpeg huesaturation render is exact.
  if (hslActive(g.hsl)) {
    const adj = Object.values(g.hsl!).filter(Boolean) as THslAdjust[];
    const avg = (k: keyof THslAdjust) =>
      adj.reduce((s, a) => s + (a[k] ?? 0), 0) / Math.max(1, adj.length);
    const h = avg('h');
    const s = avg('s');
    const l = avg('l');
    if (h) parts.push(`hue-rotate(${Math.round(h * 0.4)}deg)`);
    if (s) parts.push(`saturate(${Math.max(0, 1 + s / 200)})`);
    if (l) parts.push(`brightness(${1 + l / 300})`);
  }
  return parts.join(' ');
}

/** Quick-apply preset → slider values (presets are sugar over the grade). */
export const PRESET_COLOR: Record<Exclude<Filter, 'none'>, Partial<TColor>> = {
  warm: { temperature: 45, saturation: 12, contrast: 8 },
  cool: { temperature: -45, saturation: 8, contrast: 8, brightness: 2 },
  mono: { saturation: -100, contrast: 20 },
  punch: { saturation: 32, contrast: 24 },
};

export const GRAIN_SVG =
  `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E` +
  `%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E` +
  `%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`;

export interface TClip {
  uid: string;
  url: string;
  /** Stable gallery identity. Absent for legacy and direct-upload URLs. */
  assetId?: string;
  /** Runtime-only lifecycle projection; stripped from persisted snapshots. */
  assetUnavailable?: boolean;
  assetExpiresAt?: string | null;
  /** Source duration (s), probed client-side. */
  dur: number;
  inSec: number;
  outSec: number;
  /** Absolute timeline start (s) for a clip on a NON-base track (multi-track
   * model, _tracks.ts). The base track stays sequential and ignores this. */
  startSec?: number;
  speed: number;
  muted: boolean;
  volumeDb: number;
  /** Transition INTO the next clip. */
  transition: Transition;
  transitionSec: number;
  filter: Filter;
  /** E2: optional — absent = identity (legacy render path). */
  transform?: TTransform;
  /** E3: optional — absent = neutral grade (legacy render path). */
  color?: TColor;
  /** E4 toolbar ops. */
  reversed?: boolean;
  flipH?: boolean;
  flipV?: boolean;
  freeze?: { atSec: number; durSec: number };
  /** E5: speed-ramp preset (overrides uniform speed); undefined = uniform. */
  speedCurve?: SpeedCurve | undefined;
  /** E6: entrance/exit animation. */
  animIn?: TAnim | undefined;
  animOut?: TAnim | undefined;
  /** E7 phase 1: keyframes (output-time within the clip). */
  keyframes?: TKeyframes | undefined;
  /** S3 subsystem C: mask shape + soft edge. */
  mask?: TMask | undefined;
  /** S3 subsystem D (Blend): static layer opacity 0–1. */
  opacity?: number | undefined;
  /** S3 subsystem D (Blend): blend mode vs the background. */
  blendMode?: BlendMode | undefined;
}
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';
export const BLEND_LABELS: Record<BlendMode, string> = {
  normal: 'Обычный',
  multiply: 'Умножение',
  screen: 'Экран',
  overlay: 'Перекрытие',
};

export type MaskShape =
  | 'none'
  | 'circle'
  | 'rect'
  | 'linear'
  | 'heart'
  | 'star'
  | 'diamond'
  | 'cinematic-bars'
  | 'freeform';
export interface TMask {
  shape: MaskShape;
  feather?: number;
  invert?: boolean;
  /** Freeform polygon vertices — normalized 0–1 fractions of frame w/h. Only
   * meaningful when shape==='freeform'. ≤16 (schema cap); <3 renders nothing. */
  points?: { x: number; y: number }[];
}
export const MASK_LABEL: Record<MaskShape, string> = {
  none: 'Нет',
  circle: 'Круг',
  rect: 'Прямоугольник',
  linear: 'Линия',
  heart: 'Сердце',
  star: 'Звезда',
  diamond: 'Ромб',
  'cinematic-bars': 'Кино-полосы',
  freeform: 'Перо',
};

/** Data-URI SVG mask source for shapes a CSS gradient can't express (diamond/
 * star/heart) — same inline-SVG-data-URI style as {@link GRAIN_SVG}. `path` is
 * drawn in a 0–100 viewBox; a blur filter approximates feather (the geq mirror
 * can't reuse this — it does the shape math directly), and invert punches the
 * shape out of a full-canvas rect via `fill-rule="evenodd"` instead of
 * swapping fill colours (there's only one shape fill here, not a gradient A/B). */
function maskSvgUri(path: string, featherPct: number, invert: boolean): string {
  const blur = Math.round(featherPct * 0.12 * 100) / 100;
  const d = invert ? `M0 0H100V100H0Z ${path}` : path;
  const rule = invert ? ` fill-rule='evenodd'` : '';
  return (
    `url("data:image/svg+xml,%3Csvg viewBox='0 0 100 100' xmlns='http://www.w3.org/2000/svg'%3E` +
    `%3Cfilter id='b' x='-30%25' y='-30%25' width='160%25' height='160%25'%3E` +
    `%3CfeGaussianBlur stdDeviation='${blur}'/%3E%3C/filter%3E` +
    `%3Cpath d='${d}'${rule} fill='%23000' filter='url(%23b)'/%3E%3C/svg%3E")`
  );
}

const DIAMOND_PATH = 'M50 0L100 50L50 100L0 50Z';
const STAR_PATH = 'M50 0L61 35L98 35L68 57L79 91L50 70L21 91L32 57L2 35L39 35Z';
// Implicit-heart-curve silhouette. Traced DIRECTLY from the worker's geq heart
// (studio-graph.ts: implicit `(hx²+hy²−1)³ − hx²·hy³ ≤ 0`, hx=(X-50)/35,
// hy=−(Y-45)/40) by ray-casting the boundary from the centre — the curve is
// star-convex there, so this polyline matches the export shape. NOT a hand-drawn
// bezier: the previous path put the top cleft at Y≈16, but the worker's cleft sits
// at Y≈5, so a hand path broke preview==export at the notch. Exported for the
// parity test in _model.test.ts.
export const HEART_PATH =
  'M85,45 L83.98,47.23 L82.91,49.33 L81.82,51.33 L80.7,53.23 L79.55,55.03 L78.39,56.76 L77.2,58.41 L75.99,60.01 L74.76,61.54 L73.5,63.04 L72.22,64.48 L70.9,65.9 L69.54,67.29 L68.15,68.65 L66.7,70 L65.21,71.34 L63.65,72.67 L62.02,74.02 L60.31,75.38 L58.52,76.78 L56.61,78.24 L54.59,79.83 L52.4,81.69 L50,85 L47.6,81.69 L45.41,79.83 L43.39,78.24 L41.48,76.78 L39.69,75.38 L37.98,74.02 L36.35,72.67 L34.79,71.34 L33.3,70 L31.85,68.65 L30.46,67.29 L29.1,65.9 L27.78,64.48 L26.5,63.04 L25.24,61.54 L24.01,60.01 L22.8,58.41 L21.61,56.76 L20.45,55.03 L19.3,53.23 L18.18,51.33 L17.09,49.33 L16.02,47.23 L15,45 L14.02,42.64 L13.11,40.14 L12.27,37.5 L11.53,34.69 L10.92,31.73 L10.46,28.62 L10.19,25.37 L10.15,21.99 L10.39,18.53 L10.95,15.04 L11.88,11.57 L13.21,8.21 L14.97,5.05 L17.16,2.2 L19.76,-0.25 L22.75,-2.2 L26.05,-3.57 L29.57,-4.32 L33.22,-4.43 L36.9,-3.91 L40.49,-2.79 L43.93,-1.1 L47.13,1.18 L50,5 L52.87,1.18 L56.07,-1.1 L59.51,-2.79 L63.1,-3.91 L66.78,-4.43 L70.43,-4.32 L73.95,-3.57 L77.25,-2.2 L80.24,-0.25 L82.84,2.2 L85.03,5.05 L86.79,8.21 L88.12,11.57 L89.05,15.04 L89.61,18.53 L89.85,21.99 L89.81,25.37 L89.54,28.62 L89.08,31.73 L88.47,34.69 L87.73,37.5 L86.89,40.14 L85.98,42.64 Z';

/** Build the SVG `mask-image` data URI for a freeform polygon (CSS mirror of the
 * worker's point-in-polygon geq). White = revealed; the edge is softened to mirror
 * the geq's inward feather (approximate — feather is the one place preview≈export
 * is coarse). The soft ramp is confined strictly INSIDE the hard polygon boundary
 * (feComposite operator="in" against the unblurred fill) — a loose feGaussianBlur
 * bleeds alpha both inward AND outward past the edge, but the worker's geq only
 * erodes inward (`inside*clip(dist/f,0,1)` is hard zero outside), so an unconfined
 * blur would show a halo the export never renders. `invert` reveals the outside:
 * with feather>0 that's a flood-fill white minus the confined ramp (operator="out",
 * over the full canvas, not just the polygon's own hole) so the fade stays anchored
 * to the same inward-from-the-edge band as the non-inverted case. */
export function freeformMaskUri(
  points: { x: number; y: number }[],
  feather: number,
  invert: boolean,
): string | null {
  const pts = points.slice(0, 16);
  if (pts.length < 3) return null;
  const d =
    pts
      .map((p, i) => `${i ? 'L' : 'M'}${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`)
      .join(' ') + ' Z';
  // Feather → gaussian stdDeviation in the 0–100 viewBox (≈ the geq 0.4·f band).
  const std = ((Math.max(0, Math.min(100, feather)) / 100) * 0.4 * 100) / 2;
  let body: string;
  if (std > 0.01) {
    // even-odd fill mirrors the worker's PNPOLY parity (freeformMaskExpr) — a
    // self-intersecting hand-drawn polygon must fill the SAME region in preview
    // and export; SVG's default `nonzero` would fill overlap loops the geq leaves
    // empty (mod-2 crossing), breaking preview==export on a crossed path.
    const solid = `<path fill-rule="evenodd" fill="#fff" d="${d}"/>`;
    const invertOps = invert
      ? `<feFlood flood-color="#fff" result="bg"/><feComposite in="bg" in2="ramp" operator="out"/>`
      : '';
    body =
      `<defs><filter id="fb" filterUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">` +
      `<feGaussianBlur in="SourceGraphic" stdDeviation="${std.toFixed(2)}" result="blur"/>` +
      `<feComposite in="blur" in2="SourceGraphic" operator="in"${invert ? ' result="ramp"' : ''}/>` +
      `${invertOps}</filter></defs>` +
      `<g filter="url(#fb)">${solid}</g>`;
  } else {
    // Hard edge (no blur): evenodd cuts the polygon as a hole so the outside
    // reveals. The non-inverted path is ALSO evenodd so a self-intersecting
    // polygon fills the same region the worker's even-odd geq does (preview==export).
    body = invert
      ? `<path fill-rule="evenodd" fill="#fff" d="M0,0 H100 V100 H0 Z ${d}"/>`
      : `<path fill-rule="evenodd" fill="#fff" d="${d}"/>`;
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none">` +
    `${body}</svg>`;
  // Minimal, deterministic encoding for a data URI (single-line SVG, no spaces
  // needing escaping beyond these).
  const enc = svg.replace(/"/g, "'").replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23');
  return `url("data:image/svg+xml,${enc}")`;
}

/** CSS mirror of the ffmpeg mask geq: `mask-image` (not clip-path — crop owns
 * that) reveals the shape, the rest falls through to the canvas background.
 * Approximate feather, exact shape → preview≈export. */
export function maskStyle(c: TClip): React.CSSProperties {
  const m = c.mask;
  // mix-blend-mode blends the clip with the bg-coloured preview box — exactly
  // what the ffmpeg blend geq does over the composition background.
  const blend =
    c.blendMode && c.blendMode !== 'normal'
      ? ({ mixBlendMode: c.blendMode } as React.CSSProperties)
      : {};
  const op = {
    ...blend,
    ...(typeof c.opacity === 'number' && c.opacity < 1 ? { opacity: c.opacity } : {}),
  };
  if (!m || m.shape === 'none') return op;
  if (m.shape === 'freeform') {
    // A hand-drawn polygon: SVG mask-image (same alpha mechanism as the gradient
    // shapes below). <3 points = nothing drawn yet → fall through to no mask.
    const uri = freeformMaskUri(m.points ?? [], m.feather ?? 0, !!m.invert);
    if (!uri) return op;
    return {
      ...op,
      maskImage: uri,
      WebkitMaskImage: uri,
      maskSize: '100% 100%',
      WebkitMaskSize: '100% 100%',
    } as React.CSSProperties;
  }
  const f = Math.max(0, Math.min(40, (m.feather ?? 0) / 2)); // feather %
  const A = m.invert ? 'transparent' : '#000';
  const B = m.invert ? '#000' : 'transparent';
  if (m.shape === 'diamond' || m.shape === 'star' || m.shape === 'heart') {
    const path = m.shape === 'diamond' ? DIAMOND_PATH : m.shape === 'star' ? STAR_PATH : HEART_PATH;
    const img = maskSvgUri(path, f, !!m.invert);
    return { ...op, maskImage: img, WebkitMaskImage: img };
  }
  if (m.shape === 'cinematic-bars') {
    // Fixed 12%-of-frame letterbox bars — not a feathered shape, so `feather`
    // is intentionally ignored (no new TMask field: reuses the existing type).
    const lo = 12;
    const hi = 88;
    const img = `linear-gradient(to bottom, ${B} 0%, ${B} ${lo}%, ${A} ${lo}%, ${A} ${hi}%, ${B} ${hi}%, ${B} 100%)`;
    return { ...op, maskImage: img, WebkitMaskImage: img };
  }
  let img: string;
  if (m.shape === 'circle') {
    img = `radial-gradient(circle closest-side, ${A} ${Math.max(0, 100 - f)}%, ${B} 100%)`;
  } else if (m.shape === 'rect') {
    const lo = 16 - f / 2;
    const hi = 84 + f / 2;
    img =
      `linear-gradient(to right, ${B} ${lo}%, ${A} ${16}%, ${A} ${84}%, ${B} ${hi}%),` +
      `linear-gradient(to bottom, ${B} ${lo}%, ${A} ${16}%, ${A} ${84}%, ${B} ${hi}%)`;
  } else {
    img = `linear-gradient(to bottom, ${B} ${Math.max(0, 50 - f)}%, ${A} ${Math.min(100, 50 + f)}%)`;
  }
  return {
    ...op,
    maskImage: img,
    WebkitMaskImage: img,
    ...(m.shape === 'rect' ? { maskComposite: 'intersect', WebkitMaskComposite: 'source-in' } : {}),
  } as React.CSSProperties;
}

export type KfProp = 'opacity' | 'posX' | 'posY' | 'scale' | 'rotate';
export type TKeyframes = Partial<Record<KfProp, { t: number; v: number }[]>>;

/** Linear interpolation with hold-outside-range (mirror of kfExpr). */
export function kfValueAt(kfs: { t: number; v: number }[] | undefined, t: number): number | null {
  if (!kfs || kfs.length === 0) return null;
  const ks = [...kfs].sort((a, b) => a.t - b.t);
  if (t <= ks[0]!.t) return ks[0]!.v;
  if (t >= ks[ks.length - 1]!.t) return ks[ks.length - 1]!.v;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (t < b.t) return a.v + ((b.v - a.v) * (t - a.t)) / Math.max(0.001, b.t - a.t);
  }
  return ks[ks.length - 1]!.v;
}

/** E7 CSS mirror: keyframed opacity + transform at the playhead. */
export function kfAdjust(c: TClip, tIn: number): { opacity: number; transformExtra: string } {
  const kf = c.keyframes;
  if (!kf) return { opacity: 1, transformExtra: '' };
  let opacity = 1;
  let extra = '';
  const o = kfValueAt(kf.opacity, tIn);
  if (o !== null) opacity = Math.min(1, Math.max(0, o));
  const px = kfValueAt(kf.posX, tIn);
  const py = kfValueAt(kf.posY, tIn);
  if (px !== null || py !== null) extra += ` translate(${px ?? 0}%, ${py ?? 0}%)`;
  const r = kfValueAt(kf.rotate, tIn);
  // round3 (not whole degrees) to match the worker's kfExpr precision — whole-
  // degree rounding drifted eased rotation up to 0.5° (several px at 1080p corners).
  if (r !== null) extra += ` rotate(${Math.round(r * 1000) / 1000}deg)`;
  const s = kfValueAt(kf.scale, tIn);
  if (s !== null) extra += ` scale(${Math.round(s * 100) / 100})`;
  return { opacity, transformExtra: extra };
}

export type AnimKind = 'fade' | 'slide' | 'zoom';
export interface TAnim {
  kind: AnimKind;
  durSec: number;
}
export const ANIM_LABEL: Record<AnimKind | 'none', string> = {
  none: 'Нет',
  fade: 'Затух.',
  slide: 'Сдвиг',
  zoom: 'Зум',
};

/* Animation gallery (CapCut §4.3) — In / Out / Combo presets compiled into
 * keyframes, which already render end-to-end (preview kfAdjust + worker
 * buildKeyframeChain), so preview==export holds with zero worker changes.
 * Each segment animates one keyframe channel from→to over the in/out window.
 * scale stays ≥1 (zoompan can't go below 1) and every value sits in schema range. */
export type AnimSeg = { ch: KfProp; from: number; to: number };
export interface AnimPreset {
  id: string;
  label: string;
  group: 'in' | 'out' | 'combo';
  in?: AnimSeg[];
  out?: AnimSeg[];
}
export const FADE_IN: AnimSeg = { ch: 'opacity', from: 0, to: 1 };
export const FADE_OUT: AnimSeg = { ch: 'opacity', from: 1, to: 0 };
export const ANIM_PRESETS: AnimPreset[] = [
  // ── In (entrance) ──
  { id: 'in-fade', label: 'Появление', group: 'in', in: [FADE_IN] },
  { id: 'in-up', label: 'Снизу', group: 'in', in: [{ ch: 'posY', from: 30, to: 0 }, FADE_IN] },
  { id: 'in-down', label: 'Сверху', group: 'in', in: [{ ch: 'posY', from: -30, to: 0 }, FADE_IN] },
  { id: 'in-left', label: 'Слева', group: 'in', in: [{ ch: 'posX', from: -30, to: 0 }, FADE_IN] },
  { id: 'in-right', label: 'Справа', group: 'in', in: [{ ch: 'posX', from: 30, to: 0 }, FADE_IN] },
  { id: 'in-zoom', label: 'Зум', group: 'in', in: [{ ch: 'scale', from: 1.35, to: 1 }, FADE_IN] },
  {
    id: 'in-spin',
    label: 'Поворот',
    group: 'in',
    in: [{ ch: 'rotate', from: -75, to: 0 }, { ch: 'scale', from: 1.2, to: 1 }, FADE_IN],
  },
  {
    id: 'in-rise',
    label: 'Взлёт',
    group: 'in',
    in: [{ ch: 'posY', from: 18, to: 0 }, { ch: 'scale', from: 1.1, to: 1 }, FADE_IN],
  },
  // ── Out (exit) ──
  { id: 'out-fade', label: 'Затухание', group: 'out', out: [FADE_OUT] },
  { id: 'out-up', label: 'Вверх', group: 'out', out: [{ ch: 'posY', from: 0, to: -30 }, FADE_OUT] },
  { id: 'out-down', label: 'Вниз', group: 'out', out: [{ ch: 'posY', from: 0, to: 30 }, FADE_OUT] },
  {
    id: 'out-left',
    label: 'Влево',
    group: 'out',
    out: [{ ch: 'posX', from: 0, to: -30 }, FADE_OUT],
  },
  {
    id: 'out-right',
    label: 'Вправо',
    group: 'out',
    out: [{ ch: 'posX', from: 0, to: 30 }, FADE_OUT],
  },
  {
    id: 'out-zoom',
    label: 'Зум',
    group: 'out',
    out: [{ ch: 'scale', from: 1, to: 1.35 }, FADE_OUT],
  },
  {
    id: 'out-spin',
    label: 'Поворот',
    group: 'out',
    out: [{ ch: 'rotate', from: 0, to: 75 }, FADE_OUT],
  },
  // ── Combo (both) ──
  { id: 'combo-fade', label: 'Плавно', group: 'combo', in: [FADE_IN], out: [FADE_OUT] },
  {
    id: 'combo-zoom',
    label: 'Зум',
    group: 'combo',
    in: [{ ch: 'scale', from: 1.3, to: 1 }, FADE_IN],
    out: [{ ch: 'scale', from: 1, to: 1.3 }, FADE_OUT],
  },
  {
    id: 'combo-drift',
    label: 'Дрейф',
    group: 'combo',
    in: [{ ch: 'posX', from: -25, to: 0 }, FADE_IN],
    out: [{ ch: 'posX', from: 0, to: 25 }, FADE_OUT],
  },
  {
    id: 'combo-rise',
    label: 'Подъём',
    group: 'combo',
    in: [{ ch: 'posY', from: 22, to: 0 }, FADE_IN],
    out: [{ ch: 'posY', from: 0, to: -22 }, FADE_OUT],
  },
  {
    id: 'combo-spin',
    label: 'Вращение',
    group: 'combo',
    in: [{ ch: 'rotate', from: -60, to: 0 }, FADE_IN],
    out: [{ ch: 'rotate', from: 0, to: 60 }, FADE_OUT],
  },
];

/** Compile a preset into keyframes for a clip of `clipDur`, in/out over `durSec`. */
export function buildAnimKeyframes(p: AnimPreset, clipDur: number, durSec: number): TKeyframes {
  const kf: TKeyframes = {};
  const add = (ch: KfProp, t: number, v: number) => {
    (kf[ch] ??= []).push({ t: Math.round(t * 1000) / 1000, v });
  };
  const dIn = Math.max(0.1, Math.min(durSec, clipDur / 2));
  for (const s of p.in ?? []) {
    add(s.ch, 0, s.from);
    add(s.ch, dIn, s.to);
  }
  const dOut = Math.max(0.1, Math.min(durSec, clipDur / 2));
  const tOut = Math.max(dIn + 0.05, clipDur - dOut);
  for (const s of p.out ?? []) {
    add(s.ch, tOut, s.from);
    add(s.ch, clipDur, s.to);
  }
  return kf;
}

/** CSS mirror of buildAnimChain — opacity/translate/scale per playhead. */
export function animAdjust(
  c: TClip,
  tIn: number,
  outDur: number,
): { opacity: number; transformExtra: string } {
  let opacity = 1;
  let extra = '';
  if (c.animIn) {
    const d = Math.max(0.2, Math.min(c.animIn.durSec, 2));
    const p = Math.min(1, Math.max(0, tIn / d));
    if (c.animIn.kind === 'fade') opacity *= p;
    if (c.animIn.kind === 'slide') extra += ` translateX(${Math.round(-(1 - p) * 100)}%)`;
    if (c.animIn.kind === 'zoom') extra += ` scale(${1 + 0.2 * (1 - p)})`;
  }
  if (c.animOut && outDur > 0.3) {
    const d = Math.min(Math.max(0.2, Math.min(c.animOut.durSec, 2)), outDur / 2);
    const q = Math.min(1, Math.max(0, (tIn - (outDur - d)) / d));
    if (q > 0) {
      if (c.animOut.kind === 'fade') opacity *= 1 - q;
      if (c.animOut.kind === 'slide') extra += ` translateX(${Math.round(q * 100)}%)`;
      if (c.animOut.kind === 'zoom') extra += ` scale(${1 + 0.2 * q})`;
    }
  }
  return { opacity, transformExtra: extra };
}

/** Transform + flips combined for the preview element (E2+E4). */
export function clipGeometryStyle(c: TClip): React.CSSProperties {
  const base = transformStyle(c.transform);
  const mask = maskStyle(c);
  const flips = `${c.flipH ? ' scaleX(-1)' : ''}${c.flipV ? ' scaleY(-1)' : ''}`;
  if (!flips) return { ...base, ...mask };
  return { ...base, ...mask, transform: `${base.transform ?? ''}${flips}`.trim() };
}

export interface TText {
  uid: string;
  text: string;
  fromSec: number;
  toSec: number;
  position: 'top' | 'center' | 'bottom';
  font: 'sans' | 'serif' | 'display' | 'mono';
  fade: boolean;
  /** Font size as a fraction of output height (matches StudioTextOverlay.sizeFrac;
   * worker fontsize = height·sizeFrac). Undefined = the worker default (1/15). */
  sizeFrac?: number;
  /** CapCut-style background box behind the text. Absent = no plate (legacy
   * identical). Text color is derived from the plate's luminance (see
   * plateTextColor) rather than stored, so preview and worker stay in sync. */
  plate?: { color: string } | undefined;
}

/** Word-pop captions («по словам»): each spoken WORD shown alone in its own time
 * window, sharing ONE style. Lives in its OWN state lane (not `TText[]`) because a
 * clip of speech produces 50–200 words — far past the 12-text export cap — and
 * each word renders as its own drawtext (see StudioPopText / the popText render
 * lane). This is word-by-word POP, not inline karaoke highlight: ffmpeg can't
 * measure per-glyph text extents reliably, so pop is the honest realizable mode. */
export interface PopText {
  font: TText['font'];
  /** Undefined = the worker default (1/15). */
  sizeFrac?: number;
  position: TText['position'];
  plate?: { color: string } | undefined;
  words: { text: string; fromSec: number; toSec: number }[];
}

/** Worker drawtext default (packages/db studio.ts: 1/15 of output height). */
export const TEXT_DEFAULT_FRAC = 1 / 15;

/** Relative-luminance contrast rule for text sitting on a plate — mirrors the
 * worker's copy in apps/worker/src/studio-graph.ts (drawtextFilter). Kept as
 * two trivial, independently-readable implementations rather than a shared
 * package, per the plate feature brief. */
export function plateTextColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#0c0e12' : '#ffffff';
}

/** Title font picker labels. */
export const TEXT_FONT_LABEL: Record<TText['font'], string> = {
  sans: 'Гротеск',
  display: 'Заголовок',
  serif: 'Антиква',
  mono: 'Моно',
};
/** CSS family for the preview — mirrors the worker's bundled TTF per font so
 * preview ≈ export (sans=Onest · display=Unbounded · mono=Martian · serif≈DejaVu). */
export const TEXT_FONT_CLASS: Record<TText['font'], string> = {
  sans: 'font-sans',
  display: 'font-display',
  mono: 'font-mono',
  serif: "[font-family:Georgia,'Times_New_Roman',serif]",
};

/** Text-template gallery (CapCut Text §3.5). Each preset drops a pre-styled text
 * clip; every field (position / font / size / fade) is already rendered by the
 * worker's drawtext, so a template renders end-to-end with ZERO worker changes —
 * preview==export free, the same trick the animation gallery uses. */
export interface TextTemplate {
  id: string;
  label: string;
  sample: string;
  position: TText['position'];
  font: TText['font'];
  sizeFrac: number;
  fade: boolean;
  /** Only the «lower-third» template ships a default plate. */
  plate?: { color: string } | undefined;
}
export const TEXT_TEMPLATES: TextTemplate[] = [
  {
    id: 'title',
    label: 'Заголовок',
    sample: 'ЗАГОЛОВОК',
    position: 'top',
    font: 'serif',
    sizeFrac: 0.11,
    fade: false,
  },
  {
    id: 'subtitle',
    label: 'Подзаголовок',
    sample: 'Подзаголовок',
    position: 'top',
    font: 'sans',
    sizeFrac: 0.06,
    fade: false,
  },
  {
    id: 'quote',
    label: 'Цитата',
    sample: '«Цитата дня»',
    position: 'center',
    font: 'serif',
    sizeFrac: 0.085,
    fade: true,
  },
  {
    id: 'hero',
    label: 'Акцент',
    sample: 'АКЦЕНТ',
    position: 'center',
    font: 'serif',
    sizeFrac: 0.13,
    fade: true,
  },
  {
    id: 'lower',
    label: 'Нижняя плашка',
    sample: 'Нижняя плашка',
    position: 'bottom',
    font: 'sans',
    sizeFrac: 0.06,
    fade: true,
    plate: { color: '#101014' },
  },
  {
    id: 'caption',
    label: 'Подпись',
    sample: 'подпись к кадру',
    position: 'bottom',
    font: 'sans',
    sizeFrac: 0.042,
    fade: false,
  },
];

export interface TAudio {
  url: string;
  name: string;
  gainDb: number;
  fromSec: number;
  fadeIn: boolean;
  fadeOut: boolean;
  /** Auto-ducking (music only, UI-wise): music dips to `db` during each hold
   * window while the voiceover speaks. Windows are in project-timeline seconds;
   * attack/release ramps live in lib/ducking.ts (duckGainDbAt). Absent = off. */
  duck?:
    | {
        db: number;
        segments: { fromSec: number; toSec: number }[];
        /** `${voiceover.url}@${voiceover.fromSec}` at analysis time — lets
         * consumers detect a stale duck after the voiceover changes/moves/is
         * removed. Optional so specs without it (older projects) stay valid. */
        sourceKey?: string;
      }
    | undefined;
}

/** A timed sound-effect clip: a short audio hit placed at an absolute timeline
 * time, mixed UNDER the video (it never extends the render duration). `durSec`
 * is the source length probed client-side (preview window); the render trims to
 * the video length regardless. */
export interface TSfx {
  uid: string;
  url: string;
  name: string;
  atSec: number;
  gainDb: number;
  durSec?: number;
}

export type Format = {
  id: '16:9' | '9:16' | '1:1' | '4:3' | '2:1' | '3:4';
  label: string;
  /** Platform hint shown in the canvas Ratio dropdown (S5, subsystem A). */
  hint: string;
  width: number;
  height: number;
};
export const FORMATS: Format[] = [
  { id: '9:16', label: '9:16', hint: 'TikTok · Reels · Shorts', width: 1080, height: 1920 },
  { id: '1:1', label: '1:1', hint: 'Instagram пост', width: 1080, height: 1080 },
  { id: '16:9', label: '16:9', hint: 'YouTube', width: 1920, height: 1080 },
  { id: '4:3', label: '4:3', hint: 'Классика', width: 1440, height: 1080 },
  { id: '2:1', label: '2:1', hint: 'Кино', width: 1920, height: 960 },
  { id: '3:4', label: '3:4', hint: 'Портрет', width: 1080, height: 1440 },
];

export const TRANSITION_LABEL: Record<Transition, string> = {
  cut: 'Склейка',
  crossfade: 'Наплыв',
  dip: 'Затемнение',
  flash: 'Вспышка',
  slideleft: 'Сдвиг ←',
  slideright: 'Сдвиг →',
  slideup: 'Сдвиг ↑',
  slidedown: 'Сдвиг ↓',
  wipeleft: 'Шторка ←',
  wiperight: 'Шторка →',
  wipeup: 'Шторка ↑',
  wipedown: 'Шторка ↓',
  circleopen: 'Круг наружу',
  circleclose: 'Круг внутрь',
  zoomin: 'Зум',
};

/** Transition catalog grouped for the picker UI (CapCut Transitions library
 * §3.9). `group` drives the categorized grid; order is presentation order. */
export type TransitionGroup = 'basic' | 'slide' | 'wipe' | 'zoom';
export const TRANSITION_GROUP_LABEL: Record<TransitionGroup, string> = {
  basic: 'Базовые',
  slide: 'Сдвиг',
  wipe: 'Шторки',
  zoom: 'Зум и круг',
};
export interface TransitionMeta {
  id: Transition;
  label: string;
  group: TransitionGroup;
}
export const TRANSITIONS: TransitionMeta[] = [
  { id: 'cut', label: TRANSITION_LABEL.cut, group: 'basic' },
  { id: 'crossfade', label: TRANSITION_LABEL.crossfade, group: 'basic' },
  { id: 'dip', label: TRANSITION_LABEL.dip, group: 'basic' },
  { id: 'flash', label: TRANSITION_LABEL.flash, group: 'basic' },
  { id: 'slideleft', label: TRANSITION_LABEL.slideleft, group: 'slide' },
  { id: 'slideright', label: TRANSITION_LABEL.slideright, group: 'slide' },
  { id: 'slideup', label: TRANSITION_LABEL.slideup, group: 'slide' },
  { id: 'slidedown', label: TRANSITION_LABEL.slidedown, group: 'slide' },
  { id: 'wipeleft', label: TRANSITION_LABEL.wipeleft, group: 'wipe' },
  { id: 'wiperight', label: TRANSITION_LABEL.wiperight, group: 'wipe' },
  { id: 'wipeup', label: TRANSITION_LABEL.wipeup, group: 'wipe' },
  { id: 'wipedown', label: TRANSITION_LABEL.wipedown, group: 'wipe' },
  { id: 'zoomin', label: TRANSITION_LABEL.zoomin, group: 'zoom' },
  { id: 'circleopen', label: TRANSITION_LABEL.circleopen, group: 'zoom' },
  { id: 'circleclose', label: TRANSITION_LABEL.circleclose, group: 'zoom' },
];

/** Iris radius (CSS circle() %) that just covers the frame corners at p=1:
 * a percentage radius resolves against √(w²+h²)/√2, so √2/2 ≈ 70.7% reaches a
 * corner; 72% over-covers slightly so the iris fully clears the frame. */
const IRIS_R = 72;

/** Per-clip CSS the transition applies during the overlap. `transform` and
 * `clipPath` compose with the clip's own geometry in the preview; `lift` raises
 * this clip above its transition partner (incoming over outgoing). */
export interface TxPreview {
  opacity: number;
  transform?: string;
  clipPath?: string;
  lift?: boolean;
}

/**
 * CSS preview for a transition's outgoing/incoming clip at progress p∈[0,1] —
 * the crown-jewel preview==export mirror of the ffmpeg xfade modes, each
 * verified frame-for-frame against a real export (red/green probe):
 *   crossfade/dip/flash → opacity only (byte-identical to the legacy curves)
 *   slide*  → push: both clips translate, abutting exactly at the (1−p) edge
 *   wipe*   → clip the OUTGOING with an inset sweep (incoming sits full beneath)
 *   circleopen  → iris grows on the lifted INCOMING; circleclose → iris shrinks
 *                 on the OUTGOING (hard-edge circle; xfade's smoothstep feather
 *                 is the only approximation)
 *   zoomin  → INCOMING scales 1.6→1 with a late (p²) opacity ramp — a documented
 *             approximation of xfade's zoom-crossfade (no exact cheap CSS mirror)
 * Returns null when the clip needs no special treatment (plain full visibility),
 * e.g. crossfade/wipe/circleclose incoming and circleopen/zoomin outgoing.
 */
export function txPreview(kind: Transition, role: 'out' | 'in', p: number): TxPreview | null {
  const q = Math.min(1, Math.max(0, p));
  // Percent of the box, rounded to 2 dp so accumulated playhead float noise
  // can't leak into the CSS string (sub-pixel; preview==export holds).
  const pct = (v: number) => Math.round(v * 10000) / 100;
  switch (kind) {
    case 'crossfade':
      return role === 'out' ? { opacity: 1 - q } : null;
    case 'dip':
    case 'flash':
      return role === 'out'
        ? { opacity: Math.max(0, 1 - q * 2) }
        : { opacity: Math.max(0, q * 2 - 1) };
    case 'slideleft':
      return role === 'out'
        ? { opacity: 1, transform: `translateX(${pct(-q)}%)` }
        : { opacity: 1, transform: `translateX(${pct(1 - q)}%)` };
    case 'slideright':
      return role === 'out'
        ? { opacity: 1, transform: `translateX(${pct(q)}%)` }
        : { opacity: 1, transform: `translateX(${pct(-(1 - q))}%)` };
    case 'slideup':
      return role === 'out'
        ? { opacity: 1, transform: `translateY(${pct(-q)}%)` }
        : { opacity: 1, transform: `translateY(${pct(1 - q)}%)` };
    case 'slidedown':
      return role === 'out'
        ? { opacity: 1, transform: `translateY(${pct(q)}%)` }
        : { opacity: 1, transform: `translateY(${pct(-(1 - q))}%)` };
    case 'wipeleft':
      return role === 'out' ? { opacity: 1, clipPath: `inset(0 ${pct(q)}% 0 0)` } : null;
    case 'wiperight':
      return role === 'out' ? { opacity: 1, clipPath: `inset(0 0 0 ${pct(q)}%)` } : null;
    case 'wipeup':
      return role === 'out' ? { opacity: 1, clipPath: `inset(0 0 ${pct(q)}% 0)` } : null;
    case 'wipedown':
      return role === 'out' ? { opacity: 1, clipPath: `inset(${pct(q)}% 0 0 0)` } : null;
    case 'circleopen':
      return role === 'in'
        ? {
            opacity: 1,
            clipPath: `circle(${(q * IRIS_R).toFixed(1)}% at 50% 50%)`,
            lift: true,
          }
        : { opacity: 1 };
    case 'circleclose':
      return role === 'out'
        ? { opacity: 1, clipPath: `circle(${((1 - q) * IRIS_R).toFixed(1)}% at 50% 50%)` }
        : null;
    case 'zoomin':
      return role === 'in'
        ? {
            opacity: Math.round(q * q * 1000) / 1000,
            transform: `scale(${(1 + (1 - q) * 0.6).toFixed(3)})`,
            lift: true,
          }
        : { opacity: 1 };
    default:
      return null; // cut
  }
}

/** CSS preview equivalents of the server-side ffmpeg filter chains. */
export const FILTER_CSS: Record<Filter, string> = {
  none: 'none',
  warm: 'saturate(1.12) sepia(0.16) contrast(1.04)',
  cool: 'saturate(1.08) hue-rotate(-8deg) contrast(1.04) brightness(1.02)',
  mono: 'grayscale(1) contrast(1.1)',
  punch: 'saturate(1.32) contrast(1.12)',
};

export const FILTER_LABEL: Record<Filter, string> = {
  none: 'Без',
  warm: 'Тепло',
  cool: 'Холод',
  mono: 'Ч/Б',
  punch: 'Сочный',
};

/** Timeline scale — fixed; 1 second of footage is 28 px of track. */
// S1 left rail — the CapCut library sections. S4 wires every panel; for now only
// Медиа is active (the existing source bin); the rest stake out the roadmap.
export const RAIL_ITEMS: { id: string; label: string; icon: typeof Film }[] = [
  { id: 'media', label: 'Медиа', icon: Film },
  { id: 'audio', label: 'Аудио', icon: Music },
  { id: 'text', label: 'Текст', icon: Type },
  { id: 'captions', label: 'Субтитры', icon: Captions },
  { id: 'effects', label: 'Эффекты', icon: Sparkles },
  { id: 'transitions', label: 'Переходы', icon: ArrowLeftRight },
  { id: 'filters', label: 'Фильтры', icon: SlidersHorizontal },
];
// S4: which rail sections have a real panel today (the rest signal the roadmap).
// Filters + Transitions are render-safe — they apply the existing per-clip
// `filter` / `transition` fields that already render end-to-end.
export const RAIL_ACTIVE = new Set([
  'media',
  'audio',
  'text',
  'captions',
  'effects',
  'transitions',
  'filters',
]);

// S4 Effects — one-click looks over ffmpeg-realizable primitives (filter+grade);
// every field already renders end-to-end, so no new render path.
export const EFFECTS: { id: string; label: string; color: Partial<TColor>; filter?: Filter }[] = [
  { id: 'vintage', label: 'Винтаж', color: { curve: 'vintage', grain: 30, vignette: 25 } },
  { id: 'cinema', label: 'Кино', color: { curve: 'contrast', vignette: 45, contrast: 12 } },
  { id: 'mono', label: 'Ч/Б', color: {}, filter: 'mono' },
  { id: 'warm', label: 'Тёплый', color: { curve: 'warm', temperature: 28 } },
  { id: 'cool', label: 'Холодный', color: { curve: 'cool', temperature: -28 } },
  { id: 'film', label: 'Плёнка', color: { grain: 55, vignette: 30 } },
];

/** Parse an .srt/.vtt cue file into caption overlays (S6). Tolerant of comma or
 * dot millis and a leading WEBVTT header. */
export function parseSrt(
  raw: string,
): { text: string; fromSec: number; toSec: number; position: 'bottom' }[] {
  const toSec = (s: string): number => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s) ?? /(\d+):(\d+)[,.](\d+)/.exec(s);
    if (!m) return 0;
    return m.length === 5
      ? +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +m[4]! / 1000
      : +m[1]! * 60 + +m[2]! + +m[3]! / 1000;
  };
  const out: { text: string; fromSec: number; toSec: number; position: 'bottom' }[] = [];
  for (const block of raw
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0) continue;
    const [a, b] = lines[ti]!.split('-->');
    const text = lines
      .slice(ti + 1)
      .join(' ')
      .trim()
      .slice(0, 200);
    if (text) out.push({ text, fromSec: toSec(a!), toSec: toSec(b!), position: 'bottom' });
  }
  return out;
}

/** Export lifecycle (UI-only state machine for the render flow). */
export type ExportPhase =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'rendering'; renderId: string }
  | { kind: 'done'; url: string }
  | { kind: 'failed'; message: string };

export interface RenderHistoryItem {
  id: string;
  status: string;
  resultUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** What the inspector is bound to (clip / text / overlay), or nothing. */
export type Selection =
  | { kind: 'clip'; uid: string }
  | { kind: 'text'; uid: string }
  | { kind: 'overlay'; uid: string }
  | null;

/** M:SS.d for the playhead/duration readouts. */
export function fmt(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ds = Math.floor((s % 1) * 10);
  return `${m}:${String(sec).padStart(2, '0')}.${ds}`;
}

/** Compact M:SS for badges (no deciseconds). */
export function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** E5 speed-ramp tables — MUST mirror SPEED_CURVES in studio-graph.ts. */
export const SPEED_CURVES_UI: Record<SpeedCurve, { frac: number; rate: number }[]> = {
  montage: [
    { frac: 0.4, rate: 0.6 },
    { frac: 0.6, rate: 1.6 },
  ],
  hero: [
    { frac: 0.3, rate: 1.8 },
    { frac: 0.4, rate: 0.45 },
    { frac: 0.3, rate: 1.8 },
  ],
  flash: [
    { frac: 0.7, rate: 0.6 },
    { frac: 0.3, rate: 2.4 },
  ],
};
export const CURVE_LABEL: Record<SpeedCurve | 'none', string> = {
  none: 'Без',
  montage: 'Монтаж',
  hero: 'Герой',
  flash: 'Вспышка',
};

/** Ramp segments resolved over a clip's trimmed range: source/output bounds. */
export function rampSegments(
  c: TClip,
): { srcStart: number; outStart: number; outEnd: number; rate: number }[] {
  const segs = SPEED_CURVES_UI[c.speedCurve as SpeedCurve] ?? [];
  const srcLen = Math.max(0.1, c.outSec - c.inSec);
  let srcAcc = 0;
  let outAcc = 0;
  return segs.map((s) => {
    const len = srcLen * s.frac;
    const seg = { srcStart: srcAcc, outStart: outAcc, outEnd: outAcc + len / s.rate, rate: s.rate };
    srcAcc += len;
    outAcc = seg.outEnd;
    return seg;
  });
}

export function clipOutDur(c: TClip): number {
  // E4: a freeze clip holds one frame for its own duration — trim/speed moot.
  if (c.freeze) return Math.max(0.5, Math.min(c.freeze.durSec, 10));
  if (c.speedCurve) {
    const segs = rampSegments(c);
    return Math.max(0.1, segs[segs.length - 1]?.outEnd ?? 0.1);
  }
  return Math.max(0.1, (c.outSec - c.inSec) / (c.speed || 1));
}

/** Source time for timeline time t within the clip (E4/E5-aware): freeze
 * pins the frame; reversed plays backwards; ramps invert piecewise. */
export function clipSourceT(c: TClip, tIntoClip: number): number {
  if (c.freeze) return c.freeze.atSec;
  if (c.speedCurve) {
    const segs = rampSegments(c);
    const seg = segs.find((s) => tIntoClip < s.outEnd) ?? segs[segs.length - 1];
    if (!seg) return c.inSec;
    return c.inSec + seg.srcStart + (tIntoClip - seg.outStart) * seg.rate;
  }
  if (c.reversed) return Math.max(c.inSec, c.outSec - tIntoClip * c.speed);
  return c.inSec + tIntoClip * c.speed;
}

/** Momentary playback rate at t (E5): the ramp's active segment, else speed. */
export function clipRateAt(c: TClip, tIntoClip: number): number {
  if (c.speedCurve) {
    const segs = rampSegments(c);
    return (segs.find((s) => tIntoClip < s.outEnd) ?? segs[segs.length - 1])?.rate ?? 1;
  }
  return c.speed;
}

/** dB → linear gain for HTMLMediaElement.volume (clamped to [0,1]). */
export function dbToLin(db: number): number {
  return Math.min(1, Math.max(0, 10 ** (db / 20)));
}

/** Linear fade multiplier mirroring the worker's music/voiceover afades
 * (studio-graph.ts addTrack): `afade=t=in:st=0:d=1` on the pre-delay stream →
 * a 0→1 ramp over the first second AFTER the track starts (`fromSec`), and
 * `afade=t=out:st=total-1:d=1` → a 1→0 ramp over the last second of the whole
 * timeline (`totalDur`). The two afades are SEPARATE filters in series, so their
 * gains MULTIPLY — for a short timeline where the ramps overlap that is NOT the
 * min() of the two (min would read 0.75/0.75→0.75 where ffmpeg renders
 * 0.75·0.75=0.5625). Each ramp clamps to [0,1]; non-overlapping fades keep one
 * factor at 1 so the product equals the active ramp. Preview multiplies el.volume
 * by this so the audible envelope matches export. PURE. */
export function mediaFadeGain(
  t: number,
  fromSec: number,
  totalDur: number,
  fadeIn?: boolean,
  fadeOut?: boolean,
): number {
  let g = 1;
  if (fadeIn) g *= Math.max(0, Math.min(1, (t - fromSec) / 1));
  if (fadeOut) g *= Math.max(0, Math.min(1, (totalDur - t) / 1));
  return g;
}

/** Context-inspector tabs (E1) — the editor's UX backbone. Each is an icon on
 *  the persistent right rail (CapCut), so it carries an icon + label. */
export type InspectorTab =
  | 'main'
  | 'background'
  | 'speed'
  | 'audio'
  | 'animation'
  | 'smart'
  | 'presets';
export const INSPECTOR_TABS: { id: InspectorTab; label: string; icon: typeof Film }[] = [
  // CapCut web folds Color adjustment INSIDE Basic (no separate rail icon), so
  // «Цвет» lives as a section in MainPanel and the rail is 6 icons, not 7.
  { id: 'main', label: 'Основное', icon: SlidersHorizontal },
  { id: 'background', label: 'Фон', icon: Layers },
  { id: 'speed', label: 'Скорость', icon: Gauge },
  { id: 'animation', label: 'Анимация', icon: Zap },
  { id: 'audio', label: 'Звук', icon: Volume2 },
  { id: 'smart', label: 'Смарт', icon: Sparkles },
];

// A text element's rail tab set — Пресеты (template gallery) + Основное (the
// drawtext-renderable fields). CapCut's text tab set also has TTS / AI-avatars /
// motion-tracking; those are GPU/generation features out of our MVP scope, so we
// expose only what the worker's drawtext honours (preview == export).
export const TEXT_TABS: { id: InspectorTab; label: string; icon: typeof Film }[] = [
  { id: 'presets', label: 'Пресеты', icon: Sparkles },
  { id: 'main', label: 'Основное', icon: Type },
];

// S3 subsystem G: background fill palette (neutrals + a few accents). '#000000'
// maps back to the default (null) so the legacy spec stays byte-identical.
export const BG_SWATCHES = [
  '#000000',
  '#101014',
  '#1c1c1e',
  '#3a3a3c',
  '#8e8e93',
  '#ffffff',
  '#e0794a',
  '#7c5cff',
  '#1d4ed8',
  '#15803d',
  '#b91c1c',
  '#0e7490',
];

// S3 Smart-tools (spec §3.5) — GPU/ML operations are Seed-native: they route to
// generation (Boards), never a self-hosted GPU (locked decision §1.5). Honest
// routing, no dead toggles, no fake AI.
export const SMART_ROUTES: { id: string; label: string; desc: string }[] = [
  { id: 'removebg', label: 'Удалить фон', desc: 'Перегенерировать кадр без фона' },
  { id: 'retouch', label: 'Ретушь', desc: 'Улучшить лицо/кожу новой генерацией' },
  { id: 'relight', label: 'Пересвет', desc: 'Сменить свет сцены в «Проектах»' },
  { id: 'slowmo', label: 'Плавное замедление', desc: 'Сгенерировать кадры между' },
];
