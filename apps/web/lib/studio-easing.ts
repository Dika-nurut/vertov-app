// Easing presets for clip animations — compiled to dense LINEAR keyframes so the
// existing preview (kfValueAt) and worker (kfExpr) piecewise-linear interpolators
// render eased motion with zero worker changes (preview==export stays free).
import { buildAnimKeyframes } from '../app/studio/_model';
import type { AnimPreset, KfProp, TKeyframes } from '../app/studio/_model';

export type EasingId = 'linear' | 'smooth' | 'in' | 'out' | 'spring';
export const EASING_LABEL: Record<EasingId, string> = {
  linear: 'Линейно',
  smooth: 'Плавно',
  in: 'Разгон',
  out: 'Торможение',
  spring: 'Пружина',
};

/** Cubic-bezier(x1,y1,x2,y2) evaluator — CSS timing-function semantics.
 * Adapted from OpenCut (MIT): Newton-Raphson solve for t at given x, then eval y(t). */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;

  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  const solveT = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleDX(t);
      if (Math.abs(dx) < 1e-6) break;
      t -= (sampleX(t) - x) / dx;
    }
    return Math.min(1, Math.max(0, t));
  };

  return (x: number) => sampleY(solveT(x));
}

const CURVES: Record<Exclude<EasingId, 'linear'>, (x: number) => number> = {
  smooth: cubicBezier(0.4, 0, 0.2, 1),
  in: cubicBezier(0.55, 0, 1, 0.45),
  out: cubicBezier(0, 0.55, 0.45, 1),
  spring: cubicBezier(0.175, 0.885, 0.32, 1.275),
};

const clamp = (v: number, min?: number, max?: number) => {
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
};

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Sample from→to over [t0,t1] through the easing curve. Linear = 2 endpoint
 * keys (matches buildAnimKeyframes exactly); others sample 8 points inclusive. */
export function easeSegment(
  from: number,
  to: number,
  t0: number,
  t1: number,
  easing: EasingId,
  opts?: { min?: number; max?: number },
): { t: number; v: number }[] {
  if (easing === 'linear') {
    return [
      { t: round3(t0), v: clamp(from, opts?.min, opts?.max) },
      { t: round3(t1), v: clamp(to, opts?.min, opts?.max) },
    ];
  }
  const curve = CURVES[easing];
  const n = 8;
  const out: { t: number; v: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = i / (n - 1);
    const eased = curve(p);
    const t = t0 + (t1 - t0) * p;
    const v = from + (to - from) * eased;
    out.push({ t: round3(t), v: clamp(v, opts?.min, opts?.max) });
  }
  return out;
}

const CHANNEL_RANGE: Record<KfProp, { min?: number; max?: number }> = {
  opacity: { min: 0, max: 1 },
  scale: { min: 1, max: 3 },
  posX: { min: -100, max: 100 },
  posY: { min: -100, max: 100 },
  rotate: { min: -180, max: 180 },
};

/** Mirrors buildAnimKeyframes's exact in/out windowing, routing each segment
 * through easeSegment instead of emitting bare endpoint keys. Worst case per
 * channel: 8 (in) + 8 (out) = 16 keys — under the API's 24-key cap. */
export function buildAnimKeyframesEased(
  p: AnimPreset,
  clipDur: number,
  durSec: number,
  easing: EasingId,
): TKeyframes {
  if (easing === 'linear') return buildAnimKeyframes(p, clipDur, durSec);
  const kf: TKeyframes = {};
  const add = (ch: KfProp, pts: { t: number; v: number }[]) => {
    (kf[ch] ??= []).push(...pts);
  };
  const dIn = Math.max(0.1, Math.min(durSec, clipDur / 2));
  for (const s of p.in ?? []) {
    add(s.ch, easeSegment(s.from, s.to, 0, dIn, easing, CHANNEL_RANGE[s.ch]));
  }
  const dOut = Math.max(0.1, Math.min(durSec, clipDur / 2));
  const tOut = Math.max(dIn + 0.05, clipDur - dOut);
  for (const s of p.out ?? []) {
    add(s.ch, easeSegment(s.from, s.to, tOut, clipDur, easing, CHANNEL_RANGE[s.ch]));
  }
  return kf;
}
