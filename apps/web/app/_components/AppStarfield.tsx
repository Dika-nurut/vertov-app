'use client';

import { useEffect, useRef } from 'react';

/**
 * App-wide night sky (2026-07-07 follow-up): the landing hero's canvas-drawn
 * stars (small squares + big «крест-искра» crosses, HeroSky.tsx) read as our
 * actual night sky; the plain CSS radial-gradient speckle every other screen
 * had (body::before) reads flat/generic by comparison. This reuses the same
 * star SHAPES and the same deterministic seed as HeroSky, minus the glow dome
 * and the twinkle/comet animation (owner: "i do not demand live stars and
 * falling stars... i demand the same good looking star shapes") — paints once
 * per full page load, no per-frame redraw. Mounted in the root layout (not
 * per-page), so client-side navigation between app screens never repaints or
 * reshuffles it — the sky stays put for the whole anonymous session, exactly
 * like a real backdrop, until a hard reload (e.g. the anon-session bootstrap)
 * repaints it fresh at the same density/shape.
 */
const STAR_DENSITY = 24000; // device px² per star candidate — matches HeroSky
const STAR_BRIGHT = 1.6;
const BIG_SHARE = 0.1;
const SEED = 987654; // same seed as HeroSky.buildStars — same sky "look"

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paint(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(window.innerWidth * dpr));
  const H = Math.max(1, Math.round(window.innerHeight * dpr));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  const rnd = mulberry32(SEED);
  const n = Math.round((W * H) / STAR_DENSITY);
  for (let i = 0; i < n; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    const big = rnd() < BIG_SHARE;
    const a = Math.min(0.95, (big ? 0.35 + rnd() * 0.3 : 0.08 + rnd() * 0.26) * STAR_BRIGHT);
    ctx.fillStyle = `rgba(236,238,243,${a.toFixed(3)})`;
    const sz = (big ? 2.5 : 1.5) * dpr;
    if (big) {
      // «крест-искра» — same cross shape as the landing hero's big stars.
      ctx.fillRect(x - sz, y, sz * 3, sz);
      ctx.fillRect(x, y - sz, sz, sz * 3);
    } else {
      ctx.fillRect(x, y, sz, sz);
    }
  }
}

export function AppStarfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    paint(canvas);
    let rz: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(() => paint(canvas), 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(rz);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
      }}
    />
  );
}
