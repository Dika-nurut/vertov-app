'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import type { DemoProps } from './types';

/** Студия demo (goal §4/§5): the REAL 2x editor screenshot shown fitted inside
 *  the panel (never zoomed past 1:1 of its displayed size — the v7 edge problem
 *  came from scaling a stage, not a contained image). The validated cover-rect
 *  trim gesture plays over it (constants relative to the 1500×950 logical
 *  screenshot). No corner timecode — owner flagged it as a gimmick, removed
 *  2026-07-02. */

const IW = 1500; // logical width of editor-shot.webp (3000×1900 @2x)
const IH = 950;
const STRIP_END = 1494;
const TRIM_PX = 117;
const STRIP_TOP = 769;
const STRIP_H = 62;
const TRACK_BG = 'var(--color-surface)';

const LOOP_MS = 8200;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ramp = (p: number, a: number, b: number) => clamp((p - a) / (b - a), 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export function StudioDemo({ active, onProgress, onLoop }: DemoProps) {
  const fitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const trimRef = useRef<HTMLDivElement>(null);

  const cbRef = useRef({ onProgress, onLoop });
  cbRef.current = { onProgress, onLoop };

  // fit the fixed 1500×950 stage into the panel (contain — never up-scale past fit)
  useEffect(() => {
    const fit = () => {
      const box = fitRef.current;
      const stage = stageRef.current;
      if (!box || !stage) return;
      const k = Math.min(box.clientWidth / IW, box.clientHeight / IH);
      stage.style.transform = `translate(-50%,-50%) scale(${k})`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (fitRef.current) ro.observe(fitRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let start: number | null = null;

    const render = (p: number) => {
      const grab = ramp(p, 0.34, 0.44);
      const trim = ease(ramp(p, 0.44, 0.8));
      const cx = STRIP_END - TRIM_PX * trim;
      if (cursorRef.current) {
        cursorRef.current.style.left = `${cx - 6}px`;
        cursorRef.current.style.top = `${lerp(756, 784, grab)}px`;
        cursorRef.current.style.opacity = String(ease(ramp(p, 0.24, 0.32)));
        cursorRef.current.style.transform = `scale(${1 - 0.15 * Math.sin(grab * Math.PI)})`;
      }
      if (coverRef.current) {
        coverRef.current.style.left = `${cx}px`;
        coverRef.current.style.width = `${Math.max(0, STRIP_END - cx + 4)}px`;
        coverRef.current.style.opacity = trim > 0.01 ? '1' : '0';
      }
      if (trimRef.current) {
        const land = Math.sin(ramp(p, 0.78, 0.98) * Math.PI);
        trimRef.current.style.opacity = trim > 0.03 ? '1' : '0';
        trimRef.current.style.left = `${cx}px`;
        trimRef.current.style.top = `${STRIP_TOP + 2}px`;
        trimRef.current.style.height = `${STRIP_H - 4}px`;
        trimRef.current.style.boxShadow = `0 0 ${3 + 4 * land}px var(--color-accent)`;
      }
    };

    const tick = (now: number) => {
      if (start === null) start = now;
      let p = (now - start) / LOOP_MS;
      if (p >= 1) {
        cbRef.current.onLoop?.();
        start = now;
        p = 0;
      }
      render(p);
      cbRef.current.onProgress?.(p);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div ref={fitRef} className="relative h-full w-full overflow-hidden p-3">
      <div
        ref={stageRef}
        className="absolute left-1/2 top-1/2 overflow-hidden border-[2.5px] border-[color:var(--color-line)]"
        style={{
          width: IW,
          height: IH,
          transformOrigin: 'center',
          boxShadow: '9px 9px 0 0 var(--color-accent)',
        }}
      >
        <Image
          src="/landing/editor-shot.webp"
          alt="Редактор Вертов"
          fill
          sizes="1500px"
          priority={false}
        />

        {/* «КЛИПЫ (1)» patch — cover the real label so the strip reads as a single clip */}
        <span
          className="absolute flex items-center font-mono text-[14px] font-bold"
          style={{
            left: 152,
            top: 291,
            width: 46,
            height: 20,
            background: TRACK_BG,
            color: 'var(--color-muted-foreground)',
            letterSpacing: '2px',
          }}
        >
          (1)
        </span>

        {/* trim cover: shortens the filmstrip in the cursor's wake */}
        <div
          ref={coverRef}
          className="absolute"
          style={{ opacity: 0, top: STRIP_TOP, height: STRIP_H, background: TRACK_BG }}
        />
        <div
          ref={trimRef}
          className="absolute z-[2] w-1 bg-[color:var(--color-accent)]"
          style={{ opacity: 0 }}
        />

        {/* trim cursor */}
        <div
          ref={cursorRef}
          className="pointer-events-none absolute z-[3]"
          style={{
            width: 26,
            height: 26,
            opacity: 0,
            filter: 'drop-shadow(1px 2px 2px rgba(0,0,0,.6))',
          }}
        >
          <svg viewBox="0 0 24 24" width={26} height={26}>
            <path
              d="M4 2 L4 20 L9 15 L12 22 L15 21 L12 14 L19 14 Z"
              fill="#eceef3"
              stroke="#141414"
              strokeWidth={1.2}
            />
          </svg>
        </div>
      </div>
    </div>
  );
}
