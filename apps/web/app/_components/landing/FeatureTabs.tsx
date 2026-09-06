'use client';

import { useCallback, useRef, useState } from 'react';
import { CanvasDemo } from './demos/CanvasDemo';
import { StudioDemo } from './demos/StudioDemo';
import type { DemoProps } from './demos/types';

/** FeatureTabs (v3, revised 2026-07-02): the section itself is a full solid
 *  periwinkle color block spanning its entire height — not a "tape" hint,
 *  the whole "chapter" (owner spec). Periwinkle is the ONLY defensible
 *  decorative secondary per the actual locked palette (docs/design/slate-brutal-colors.md
 *  — lime is the rare spark, never a big fill; mint/coral are status-only).
 *  Text inside is dark ink (the established pairing for periwinkle
 *  backgrounds — see the CTA button in Hero), not bone. No border between
 *  this section and its neighbours — the color change IS the transition
 *  ("should feel like a single history", owner spec); Hero and Showcase
 *  border-tops were removed to match.
 *
 *  Panel composition unchanged from v2: ONE seamless demo panel per tab
 *  (demo fills it as the base layer, caption overlays a scrim, no internal
 *  seam) — that part landed. Pill-free brutal tab bar now lives in its own
 *  dark chip so it still reads as a control against the periwinkle page.
 *
 *  (2026-07-03: owner reported the periwinkle edge not reaching their
 *  screen's left/right edge on some display — full-bleed breakout
 *  (100vw + negative margin) instead of relying on the parent's width,
 *  since that's robust to any ancestor/scrollbar rounding quirk.) */

type Tab = {
  key: string;
  tab: string;
  slate: string;
  title: string;
  lede: string;
  Demo: (p: DemoProps) => React.ReactNode;
};

const TABS: Tab[] = [
  {
    key: 'canvas',
    tab: 'Холст',
    slate: 'КАДР 01 · ДУБЛЬ 01',
    title: 'Собери на холсте',
    lede: 'Свяжи промпт, кадр и видео узлами — один холст, вся раскадровка сцены.',
    Demo: CanvasDemo,
  },
  {
    key: 'studio',
    tab: 'Студия',
    slate: 'КАДР 02 · ДУБЛЬ 01',
    title: 'Смонтируй и озвучь',
    lede: 'Реальный редактор: таймлайн, тримминг, звук — собери фильм и экспортируй в 4K.',
    Demo: StudioDemo,
  },
];

const PAUSE_MS = 16000; // how long a manual click suppresses auto-advance

export function FeatureTabs() {
  const [idx, setIdx] = useState(0);
  const pausedUntil = useRef(0);
  const tab = TABS[idx]!;

  const onLoop = useCallback(() => {
    if (Date.now() > pausedUntil.current) setIdx((i) => (i + 1) % TABS.length);
  }, []);
  const select = (i: number) => {
    pausedUntil.current = Date.now() + PAUSE_MS;
    setIdx(i);
  };

  const ActiveDemo = tab.Demo;

  return (
    <section className="w-screen mx-[calc(50%-50vw)] bg-[color:var(--color-accent)] px-6 py-16 md:px-11 md:py-24">
      <div className="mx-auto w-full max-w-[1320px]">
        <div className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-primary-foreground)]">
          <span className="h-[2px] w-7 bg-[color:var(--color-primary-foreground)]" />
          Как это работает
        </div>
        <h2 className="mt-2 max-w-[640px] font-display text-[clamp(26px,3.6vw,44px)] font-black uppercase leading-[0.95] tracking-[-0.02em] text-[color:var(--color-primary-foreground)]">
          Один сервис — весь фильм
        </h2>

        {/* pill-free brutal tab bar — its own dark chip so it reads as a
            control against the periwinkle page, not lost in it */}
        <div
          role="tablist"
          aria-label="Возможности"
          className="mt-7 grid grid-cols-2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] sm:inline-grid sm:grid-flow-col sm:auto-cols-max"
        >
          {TABS.map((t, i) => {
            const on = i === idx;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                onClick={() => select(i)}
                className={`border-r-[2.5px] border-[color:var(--color-line)] px-3 py-2.5 font-display text-[13px] font-black uppercase tracking-[0.02em] transition-colors last:border-r-0 sm:px-7 sm:text-[15px] ${
                  on
                    ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)]'
                    : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                }`}
              >
                {t.tab}
              </button>
            );
          })}
        </div>

        {/* ONE seamless panel — demo fills it as the base layer, caption
            overlays bottom-left over a scrim. No internal border/seam. */}
        <div className="relative mt-8 h-[520px] overflow-hidden border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] shadow-[10px_10px_0_0_var(--color-bg)] sm:h-[640px]">
          <ActiveDemo key={idx} active onLoop={onLoop} />

          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-[65%]"
            style={{
              background:
                'linear-gradient(0deg, rgba(12,14,18,0.95) 0%, rgba(12,14,18,0.55) 45%, transparent 100%)',
            }}
          />

          <div className="pointer-events-none absolute inset-x-0 bottom-0 p-6 md:p-8">
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-accent)]">
              {tab.slate}
            </div>
            <h3 className="mt-2 max-w-[420px] font-display text-[clamp(22px,2.4vw,30px)] font-black uppercase leading-[0.98] tracking-[-0.02em] text-[color:var(--color-fg)]">
              {tab.title}
            </h3>
            <p className="mt-2 max-w-[420px] text-[13px] font-medium leading-relaxed text-[color:var(--color-muted-foreground)]">
              {tab.lede}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
