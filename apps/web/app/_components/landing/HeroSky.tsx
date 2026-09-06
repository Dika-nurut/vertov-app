'use client';

import { useEffect, useRef } from 'react';

/** Hero backdrop — «звёздное небо → фиолетовое свечение» (owner-approved on
 *  the live tuner, 2026-07-05: 9 tones; re-tuned on the sky tuner 2026-07-06:
 *  denser/brighter stars + hard-cut twinkle + comet falling star). One
 *  continuous stochastic dither over a 9-step tone ladder (graphite →
 *  periwinkle): every pixel picks between the two adjacent tones of its
 *  position, so the ramp has no layer seams by construction. The glow front is
 *  a soft parabolic dome (highest mid-screen, per the poster reference), grain
 *  starts at mid-screen and the solid lands only at the hero's bottom edge.
 *  Drawn at device resolution — grain is 1 physical pixel. The solid bottom is
 *  exactly #8d76f6 (--color-accent), so when the periwinkle FeatureTabs
 *  chapter follows the hero the transition is seamless.
 *
 *  Stars live on their own canvas layer: ~a third of them twinkle by stepping
 *  between brightness levels at random moments (hard cuts, per the motion
 *  rule — no smooth pulsing), and a pixel-trail comet falls every ~9s (0.45s
 *  life, hard cut out). Both run regardless of prefers-reduced-motion and
 *  paused while the hero is offscreen. */

/* The 5 anchor colours of the ramp (graphite bg → --color-accent periwinkle);
   the 9-tone ladder is sampled along them. Hex values are the design tokens'
   — the canvas cannot read CSS vars per-pixel, so they are pinned here. */
const ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [12, 14, 18], // #0c0e12 --color-bg
  [43, 35, 84],
  [75, 61, 143],
  [108, 88, 196],
  [141, 118, 246], // #8d76f6 --color-accent
];
const TONE_STEPS = 9;

/* Owner-tuned on the sky tuner, 2026-07-06 («Твой выбор» preset). */
const STAR_DENSITY = 24000; // device px² per star candidate (was 34000)
const STAR_BRIGHT = 1.6; // alpha multiplier over the original ramp
const BIG_SHARE = 0.1; // share of 2.5px stars
const TW_SHARE = 0.32; // share of stars that twinkle
const TW_DEPTH = 0.6; // dim-to level: alpha × (1 − 0.6) at the low step
const FALL_EVERY_MS = 9000; // mean pause between comets (±: ×0.8–1.3)
const FALL_LIFE_MS = 450;
const FALL_SCALE = 1.2;

function ladder(): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < TONE_STEPS; k++) {
    const f = (k / (TONE_STEPS - 1)) * (ANCHORS.length - 1);
    const i = Math.min(ANCHORS.length - 2, Math.floor(f));
    const u = f - i;
    out.push(
      [0, 1, 2].map((ch) => Math.round(ANCHORS[i]![ch]! * (1 - u) + ANCHORS[i + 1]![ch]! * u)),
    );
  }
  return out;
}

/* Deterministic PRNG so every repaint (resize) yields the same sky. */
function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

type Star = {
  x: number;
  y: number;
  big: boolean;
  a: number; // base alpha
  tw: boolean; // participates in twinkle
  state: number; // current alpha multiplier (hard-cut steps)
  next: number; // seconds timestamp of the next state flip
};

type Geo = { W: number; H: number; dpr: number };

function paintSky(canvas: HTMLCanvasElement): Geo | null {
  const host = canvas.parentElement;
  if (!host) return null;
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const W = Math.max(1, Math.round(host.clientWidth * dpr));
  const H = Math.max(1, Math.round(host.clientHeight * dpr));
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rnd = mulberry32(20260705);
  const TONES = ladder();
  const img = ctx.createImageData(W, H);
  const d = img.data;

  // dome front: parabola (1 centre → 0 edges); grain from mid-screen,
  // solid periwinkle at the very bottom edge
  const crest = (x: number) => {
    const u = (x / W) * 2 - 1;
    return 1 - u * u;
  };
  const yStartC = 0.5 * H,
    yStartE = 0.62 * H;
  const yEndC = 0.93 * H,
    yEndE = 1.04 * H;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = crest(x);
      const y0 = yStartE - (yStartE - yStartC) * c;
      const y1 = yEndE - (yEndE - yEndC) * c;
      const t = smooth((y - y0) / (y1 - y0));
      const pos = t * (TONES.length - 1);
      const base = Math.min(TONES.length - 2, Math.floor(pos));
      const tone = TONES[rnd() < pos - base ? base + 1 : base]!;
      const i = (y * W + x) * 4;
      d[i] = tone[0]!;
      d[i + 1] = tone[1]!;
      d[i + 2] = tone[2]!;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { W, H, dpr };
}

/* Star field — same thinning-under-the-glow rule as before, but kept as data
   so the twinkle loop can redraw it on its own layer. */
function buildStars(geo: Geo): Star[] {
  const { W, H } = geo;
  const rnd = mulberry32(987654);
  const crest = (x: number) => {
    const u = (x / W) * 2 - 1;
    return 1 - u * u;
  };
  const yStartC = 0.5 * H,
    yStartE = 0.62 * H;
  const yEndC = 0.93 * H,
    yEndE = 1.04 * H;
  const stars: Star[] = [];
  const N = Math.round((W * H) / STAR_DENSITY);
  for (let i = 0; i < N; i++) {
    const x = rnd() * W,
      y = rnd() * H;
    const c = crest(x);
    const y0 = yStartE - (yStartE - yStartC) * c;
    const y1 = yEndE - (yEndE - yEndC) * c;
    const t = smooth((y - y0) / (y1 - y0));
    if (rnd() < t * 1.4) continue;
    const big = rnd() < BIG_SHARE;
    const a = Math.min(0.95, (big ? 0.35 + rnd() * 0.3 : 0.08 + rnd() * 0.26) * STAR_BRIGHT);
    stars.push({ x, y, big, a, tw: rnd() < TW_SHARE, state: 1, next: rnd() * 2 });
  }
  return stars;
}

function drawStars(canvas: HTMLCanvasElement, geo: Geo, stars: Star[], nowSec: number) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, geo.W, geo.H);
  for (const s of stars) {
    let a = s.a;
    if (s.tw) {
      if (nowSec > s.next) {
        // hard cut between three levels: dimmed / base / slightly boosted
        s.state = s.state === 1 ? (Math.random() < 0.5 ? 1 - TW_DEPTH : 1 + TW_DEPTH * 0.35) : 1;
        s.next = nowSec + 0.4 + Math.random() * 1.6;
      }
      a = Math.min(0.95, s.a * s.state);
    }
    ctx.fillStyle = `rgba(236,238,243,${a.toFixed(3)})`;
    const sz = (s.big ? 2.5 : 1.5) * geo.dpr;
    if (s.big) {
      // Large stars are «крест-искра» (owner, 2026-07-06 — the tuner's cross
      // shape): a plus of two crossed bars, small stars stay 1px squares.
      ctx.fillRect(s.x - sz, s.y, sz * 3, sz);
      ctx.fillRect(s.x, s.y - sz, sz, sz * 3);
    } else {
      ctx.fillRect(s.x, s.y, sz, sz);
    }
  }
}

/* Comet: bright square head + tapering pixel trail, linear flight down-left,
   hard cut out at end of life (owner-picked «комета с хвостом», 2026-07-06). */
function launchComet(canvas: HTMLCanvasElement, geo: Geo, onDone: () => void) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return onDone();
  const { W, H, dpr } = geo;
  const x0 = W * (0.35 + Math.random() * 0.55);
  const y0 = H * (0.06 + Math.random() * 0.22);
  const len = 190 * FALL_SCALE * dpr;
  const ang = Math.PI - 0.42; // ← and slightly ↓
  const dx = Math.cos(ang),
    dy = Math.sin(0.42);
  const x1 = x0 + dx * len,
    y1 = y0 + dy * len;
  const t0 = performance.now();
  const u = 2.5 * dpr;
  let raf = 0;
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / FALL_LIFE_MS);
    ctx.clearRect(0, 0, W, H);
    if (t >= 1) return onDone(); // hard cut out
    const hx = x0 + (x1 - x0) * t,
      hy = y0 + (y1 - y0) * t;
    const TR = Math.round(30 * FALL_SCALE);
    for (let k = 0; k < TR; k++) {
      const f = k / TR;
      const tx = hx - dx * f * len * 0.5,
        ty = hy - dy * f * len * 0.5;
      const a = (1 - f) * (1 - f) * 0.85 * (t < 0.15 ? t / 0.15 : 1);
      const s = Math.max(1, u * (1.4 - f));
      ctx.fillStyle = `rgba(236,238,243,${a.toFixed(3)})`;
      ctx.fillRect(tx - s / 2, ty - s / 2, s, s);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(hx - u * 0.9, hy - u * 0.9, u * 1.8, u * 1.8);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

export function HeroSky() {
  const skyRef = useRef<HTMLCanvasElement>(null);
  const starRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const sky = skyRef.current,
      starC = starRef.current,
      fxC = fxRef.current;
    if (!sky || !starC || !fxC) return;
    // NOT gated on prefers-reduced-motion (owner decision 2026-07-06, same
    // rule as the headline cycle 2026-07-02): the sky's twinkle/comet are an
    // ambient backdrop, treated like an autoplaying muted video — a frozen sky
    // read as broken on machines with OS-level «reduce motion» (it silently
    // kills the animations in every browser at once).

    let geo: Geo | null = null;
    let stars: Star[] = [];
    let visible = true;
    let raf = 0;
    let fallTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelComet: (() => void) | undefined | void;

    const repaint = () => {
      geo = paintSky(sky);
      if (!geo) return;
      starC.width = geo.W;
      starC.height = geo.H;
      fxC.width = geo.W;
      fxC.height = geo.H;
      stars = buildStars(geo);
      drawStars(starC, geo, stars, 0);
    };

    const loop = (now: number) => {
      if (!geo) return;
      drawStars(starC, geo, stars, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    const startLoop = () => {
      if (visible && !raf) raf = requestAnimationFrame(loop);
    };
    const stopLoop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const scheduleFall = () => {
      clearTimeout(fallTimer);
      fallTimer = setTimeout(
        () => {
          if (geo && visible) {
            cancelComet = launchComet(fxC, geo, scheduleFall);
          } else {
            scheduleFall();
          }
        },
        FALL_EVERY_MS * (0.8 + Math.random() * 0.5),
      );
    };

    repaint();
    startLoop();
    scheduleFall();

    // pause all motion while the hero is scrolled out of view
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible) startLoop();
      else stopLoop();
    });
    io.observe(sky);

    let rz: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rz);
      rz = setTimeout(repaint, 150);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(rz);
      clearTimeout(fallTimer);
      stopLoop();
      if (typeof cancelComet === 'function') cancelComet();
      io.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <canvas ref={skyRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={starRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={fxRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}
