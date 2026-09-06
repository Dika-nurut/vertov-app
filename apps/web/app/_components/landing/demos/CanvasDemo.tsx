'use client';

import { useEffect, useRef } from 'react';
import { ChevronDown, GripVertical, Play, Settings } from '@/components/ui/icons';
import type { DemoProps } from './types';

/** Холст demo (goal §4): a fan-IN vignette composed to FIT the panel (no camera,
 *  no zoom). Prompt node + кадр node stamp in → edges draw → they feed a video
 *  node that "generates" (periwinkle shimmer → resolved clip with a lime pulse).
 *  Node visual reuses the v6 NODE_RECT card style, rescaled to the stage.
 *  Stage is now the FULL demo panel (FeatureTabs v2 — single seamless panel,
 *  no separate text box), so the graph is composed into the right ~55% of a
 *  1140x480 stage, keeping the left/bottom clear for the caption + scrim
 *  overlaid on top of this component by FeatureTabs. */

const SW = 1140;
const SH = 480;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ramp = (p: number, a: number, b: number) => clamp((p - a) / (b - a), 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const LOOP_MS = 9000;

// bezier between two points with a horizontal control handle
const bez = (a: [number, number], b: [number, number]) => {
  const mx = (a[0] + b[0]) / 2;
  return `M ${a[0]} ${a[1]} C ${mx} ${a[1]}, ${mx} ${b[1]}, ${b[0]} ${b[1]}`;
};
const E1 = bez([760, 115], [900, 155]);
const E2 = bez([740, 315], [900, 285]);

export function CanvasDemo({ active, onProgress, onLoop }: DemoProps) {
  const fitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const kadrRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLDivElement>(null);
  const e1Ref = useRef<SVGPathElement>(null);
  const e2Ref = useRef<SVGPathElement>(null);
  const p1Ref = useRef<HTMLDivElement>(null);
  const p2Ref = useRef<HTMLDivElement>(null);
  const p3Ref = useRef<HTMLDivElement>(null);
  const p4Ref = useRef<HTMLDivElement>(null);
  const vloadRef = useRef<HTMLDivElement>(null);
  const vresRef = useRef<HTMLDivElement>(null);
  const vpulseRef = useRef<HTMLDivElement>(null);

  const cbRef = useRef({ onProgress, onLoop });
  cbRef.current = { onProgress, onLoop };

  // fit the fixed stage into the panel
  useEffect(() => {
    const fit = () => {
      const box = fitRef.current;
      const stage = stageRef.current;
      if (!box || !stage) return;
      const k = Math.min(box.clientWidth / SW, box.clientHeight / SH);
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
    const L1 = e1Ref.current?.getTotalLength() ?? 300;
    const L2 = e2Ref.current?.getTotalLength() ?? 300;

    const stamp = (el: HTMLElement | null, t: number) => {
      if (!el) return;
      el.style.opacity = String(ease(clamp(t, 0, 1)));
      // land with ~2px overshoot then settle (goal §3.4 stamp landing)
      const over = t < 1 ? 1 + 0.05 * Math.sin(clamp(t, 0, 1) * Math.PI) : 1;
      el.style.transform = `translateY(${lerp(10, 0, ease(clamp(t, 0, 1)))}px) scale(${over})`;
    };

    const render = (p: number) => {
      // all three nodes stamp in fast and STAY — the graph is full for most of
      // the loop (no half-empty panel), then the video node re-generates
      stamp(promptRef.current, ramp(p, 0.02, 0.12));
      stamp(kadrRef.current, ramp(p, 0.07, 0.17));
      stamp(videoRef.current, ramp(p, 0.12, 0.22));

      const d1 = ease(ramp(p, 0.24, 0.4));
      const d2 = ease(ramp(p, 0.32, 0.48));
      const e1In = ease(ramp(p, 0.24, 0.28));
      const e2In = ease(ramp(p, 0.32, 0.36));
      if (e1Ref.current) {
        e1Ref.current.style.strokeDasharray = `${L1}`;
        e1Ref.current.style.strokeDashoffset = `${L1 * (1 - d1)}`;
        e1Ref.current.style.opacity = String(e1In);
      }
      if (e2Ref.current) {
        e2Ref.current.style.strokeDasharray = `${L2}`;
        e2Ref.current.style.strokeDashoffset = `${L2 * (1 - d2)}`;
        e2Ref.current.style.opacity = String(e2In);
      }
      // ports light up with their edge — real board ports are typed
      // (text/image/video), not generic dots (goal: match GraphBoard.tsx)
      if (p1Ref.current) p1Ref.current.style.opacity = String(e1In);
      if (p2Ref.current) p2Ref.current.style.opacity = String(e2In);
      if (p3Ref.current) p3Ref.current.style.opacity = String(e1In);
      if (p4Ref.current) p4Ref.current.style.opacity = String(e2In);

      // video node generates: periwinkle shimmer → resolved clip
      const vres = ease(ramp(p, 0.72, 0.85));
      if (vloadRef.current)
        vloadRef.current.style.opacity = String(ease(ramp(p, 0.5, 0.6)) * (1 - vres));
      if (vresRef.current) vresRef.current.style.opacity = String(vres);
      const pulse = Math.sin(ramp(p, 0.74, 0.96) * Math.PI);
      if (vpulseRef.current) vpulseRef.current.style.opacity = String(pulse * 0.85);
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
    <div ref={fitRef} className="relative h-full w-full overflow-hidden">
      <div
        ref={stageRef}
        className="absolute left-1/2 top-1/2"
        style={{ width: SW, height: SH, transformOrigin: 'center' }}
      >
        {/* edges (under the nodes) — coloured by payload type, same mapping
            as the real board (GraphBoard.tsx PORT_COLOR): text=green,
            image=blue. Generic periwinkle-for-everything read as fake. */}
        <svg className="absolute inset-0 overflow-visible" width={SW} height={SH}>
          <path
            ref={e1Ref}
            d={E1}
            fill="none"
            stroke="var(--color-port-text)"
            strokeWidth={2.5}
            strokeLinecap="round"
            style={{ opacity: 0 }}
          />
          <path
            ref={e2Ref}
            d={E2}
            fill="none"
            stroke="var(--color-port-image)"
            strokeWidth={2.5}
            strokeLinecap="round"
            style={{ opacity: 0 }}
          />
        </svg>

        {/* typed port dots — the real board's most recognisable node detail;
            the previous version had edges sprout from nowhere. */}
        <Port portRef={p1Ref} x={760} y={115} color="var(--color-port-text)" />
        <Port portRef={p2Ref} x={740} y={315} color="var(--color-port-image)" />
        <Port portRef={p3Ref} x={900} y={155} color="var(--color-port-text)" />
        <Port portRef={p4Ref} x={900} y={285} color="var(--color-port-image)" />

        {/* prompt node */}
        <NodeCard
          nodeRef={promptRef}
          x={500}
          y={40}
          w={260}
          h={150}
          label="AI-промпт"
          pill="Промпт"
          shadow="var(--color-accent)"
        >
          <div className="absolute inset-x-3 bottom-3 top-[52px] overflow-hidden rounded-[4px] bg-[color:var(--color-surface2)] p-2.5 font-sans text-[13px] font-semibold leading-snug text-[color:var(--color-muted-foreground)]">
            неоновый мегаполис под дождём, пролёт дрона над крышами
          </div>
        </NodeCard>

        {/* кадр node */}
        <NodeCard
          nodeRef={kadrRef}
          x={520}
          y={230}
          w={220}
          h={170}
          label="Кадр"
          pill="Кадр"
          shadow="var(--color-accent)"
        >
          <div
            className="absolute inset-x-3 bottom-3 top-[52px] rounded-[4px] bg-cover bg-center"
            style={{ backgroundImage: "url('/landing/kadr-neon-city.webp')" }}
          />
        </NodeCard>

        {/* video node — generates */}
        <NodeCard
          nodeRef={videoRef}
          x={900}
          y={60}
          w={220}
          h={320}
          label="Генерация видео"
          pill="Видео"
          shadow="var(--color-accent)"
        >
          <div className="absolute inset-x-3 bottom-3 top-[52px] overflow-hidden rounded-[4px] bg-[color:var(--color-bg)]">
            <div className="absolute inset-0 flex items-center justify-center text-[color:var(--color-faint)]">
              <Play size={24} aria-hidden />
            </div>
            <div
              ref={vloadRef}
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color:var(--color-surface2)]"
              style={{ opacity: 0 }}
            >
              <span
                className="seed-shimmer-sweep absolute inset-0"
                style={{
                  background:
                    'linear-gradient(90deg,transparent,rgba(var(--accent-rgb),0.35),transparent)',
                }}
              />
              <span className="seed-pulse-dot z-[1] h-2.5 w-2.5 rounded-full bg-[color:var(--color-accent)]" />
              <span className="z-[1] font-display text-[13px] font-black text-[color:var(--color-fg)]">
                Снимаем ролик…
              </span>
            </div>
            <div
              ref={vresRef}
              className="absolute inset-0 bg-cover bg-center"
              style={{ backgroundImage: "url('/landing/kadr-neon-city.webp')", opacity: 0 }}
            >
              <span className="absolute left-1/2 top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white">
                <Play size={16} aria-hidden />
              </span>
              {/* Pref 11: the ONE lime spark — borderless lime pill, no bone border. */}
              <span className="absolute right-1.5 top-1.5 bg-[color:var(--color-accent2)] px-1.5 py-[1px] font-mono text-[11px] font-bold text-[color:var(--color-primary-foreground)]">
                готово
              </span>
            </div>
            <div
              ref={vpulseRef}
              className="pointer-events-none absolute inset-0 border-[2.5px] border-[color:var(--color-accent)]"
              style={{ opacity: 0 }}
            />
          </div>
        </NodeCard>
      </div>
    </div>
  );
}

function Port({
  portRef,
  x,
  y,
  color,
}: {
  portRef: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  color: string;
}) {
  return (
    <div
      ref={portRef}
      className="absolute h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[color:var(--color-line)]"
      style={{
        left: x,
        top: y,
        opacity: 0,
        background: color,
        boxShadow: `2px 2px 0 0 var(--color-accent)`,
      }}
    />
  );
}

function NodeCard({
  nodeRef,
  x,
  y,
  w,
  h,
  label,
  pill,
  shadow,
  children,
}: {
  nodeRef: React.RefObject<HTMLDivElement | null>;
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  pill: string;
  shadow: string;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={nodeRef}
      className="absolute"
      style={{ left: x, top: y, width: w, height: h, opacity: 0 }}
    >
      <div
        className="relative h-full w-full overflow-hidden rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]"
        style={{ boxShadow: `6px 6px 0 0 ${shadow}` }}
      >
        <div className="absolute inset-x-3 top-3 flex h-8 items-center gap-2 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-2.5 font-sans text-[13px] font-extrabold text-[color:var(--color-fg)]">
          <Settings size={14} className="text-[color:var(--color-faint)]" aria-hidden /> {pill}
          <ChevronDown size={12} className="ml-auto text-[color:var(--color-faint)]" aria-hidden />
        </div>
        {children}
      </div>
      <div className="absolute left-0.5 -top-[22px] flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.1em] text-[color:var(--color-faint)]">
        <GripVertical size={12} className="text-[color:var(--color-line-soft)]" aria-hidden />{' '}
        {label}
      </div>
    </div>
  );
}
