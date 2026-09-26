'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { LoopVideo } from '../LoopVideo';
import { PRODUCT_LOOPS, type ProductLoopKey } from '../product-loops';

/** FeatureTabs (v4, 2026-09-26): the periwinkle "chapter" that continues the hero's
 *  violet floor (full-bleed solid block, dark-ink text, no border to its
 *  neighbours — owner spec since v3). v4 swaps the two coded demos for the four
 *  owner-approved product loops (Генерация / Сценарий / Борды / Студия).
 *
 *  - The loop owns the panel at its native 16:9 with nothing laid over it: each loop
 *    carries its own on-screen captions, so the title, lede and «Открыть …» moved
 *    below the panel.
 *  - The tab bar is the progress bar: the active tab fills while its loop plays and
 *    the section moves to the next tab only when a loop ENDS — never mid-shot.
 *  - A click takes over: that tab repeats and auto-advance waits PAUSE_MS.
 *  - Loops load only near the viewport and keep their poster under reduced motion
 *    (see LoopVideo). */

const COPY: Record<ProductLoopKey, { slate: string; title: string; lede: string; cta: string }> = {
  generate: {
    slate: 'КАДР 01 · ДУБЛЬ 01',
    title: 'Одна строка — любая модель',
    lede: 'Seedance, Veo, Wan, Kling и HappyHorse в одном окне. Цена в токенах видна до нажатия «Снять».',
    cta: 'Открыть генерацию',
  },
  scenario: {
    slate: 'КАДР 02 · ДУБЛЬ 01',
    title: 'Идея становится сценарием',
    lede: 'Фраза раскладывается на сцены с хронометражем, каждая сцена — готовый кадр.',
    cta: 'Открыть сценарий',
  },
  boards: {
    slate: 'КАДР 03 · ДУБЛЬ 01',
    title: 'Собери фильм на холсте',
    lede: 'Персонаж, локация и промпт подключаются к кадру. Экспорт — печатная раскадровка.',
    cta: 'Открыть борды',
  },
  studio: {
    slate: 'КАДР 04 · ДУБЛЬ 01',
    title: 'Смонтируй и выгрузи',
    lede: 'Дубли на таймлайн, титр и музыка, экспорт в MP4 — прямо в браузере.',
    cta: 'Открыть студию',
  },
};

const PAUSE_MS = 16000; // how long a manual click suppresses auto-advance

export function FeatureTabs() {
  const [idx, setIdx] = useState(0);
  const [take, setTake] = useState(0); // remount key: replays the active loop
  const pausedUntil = useRef(0);
  const fill = useRef<HTMLSpanElement>(null);
  const loop = PRODUCT_LOOPS[idx]!;
  const copy = COPY[loop.key];

  const onProgress = useCallback((p: number) => {
    if (fill.current) fill.current.style.width = `${Math.min(100, p * 100)}%`;
  }, []);
  const onEnded = useCallback(() => {
    if (Date.now() > pausedUntil.current) setIdx((i) => (i + 1) % PRODUCT_LOOPS.length);
    else setTake((t) => t + 1);
  }, []);
  const select = (i: number) => {
    pausedUntil.current = Date.now() + PAUSE_MS;
    setIdx(i);
    setTake((t) => t + 1);
  };

  return (
    <section className="w-screen mx-[calc(50%-50vw)] bg-[color:var(--color-accent)] px-4 py-12 sm:px-6 sm:py-16 md:px-11 md:py-24">
      <div className="mx-auto w-full max-w-[1320px]">
        <div className="inline-flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-[color:var(--color-primary-foreground)]">
          <span className="h-[2px] w-7 bg-[color:var(--color-primary-foreground)]" />
          Как это работает
        </div>
        <h2 className="mt-2 max-w-[640px] font-display text-[clamp(26px,3.6vw,44px)] font-black uppercase leading-[0.95] tracking-[-0.02em] text-[color:var(--color-primary-foreground)]">
          Один сервис — весь фильм
        </h2>

        {/* brutal tab bar in its own dark chip; the active tab fills as its loop plays */}
        <div
          role="tablist"
          aria-label="Возможности"
          className="mt-6 grid grid-cols-4 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] sm:mt-7 sm:inline-grid sm:grid-flow-col sm:auto-cols-max"
        >
          {PRODUCT_LOOPS.map((t, i) => {
            const on = i === idx;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={on}
                aria-controls="feature-panel"
                onClick={() => select(i)}
                className={`relative overflow-hidden border-r-[2.5px] border-[color:var(--color-line)] px-1 py-2 font-display text-[10px] font-black uppercase tracking-[0.01em] transition-colors last:border-r-0 sm:px-7 sm:py-2.5 sm:text-[15px] sm:tracking-[0.02em] ${
                  on
                    ? 'bg-[color:var(--color-fg)] text-[color:var(--color-bg)]'
                    : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]'
                }`}
              >
                {t.label}
                {on && (
                  <span
                    ref={fill}
                    aria-hidden
                    className="absolute bottom-0 left-0 h-[4px] w-0 bg-[color:var(--color-accent)]"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* the loop, full panel, native 16:9, nothing laid over it */}
        <div
          id="feature-panel"
          role="tabpanel"
          aria-label={loop.label}
          className="relative mt-5 aspect-video sm:mt-8 w-full max-w-full overflow-hidden border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-bg)] shadow-[5px_5px_0_0_var(--color-shadow)]"
        >
          <LoopVideo
            key={`${loop.key}-${take}`}
            webm={loop.webm}
            src={loop.src}
            poster={loop.poster}
            loop={false}
            onEnded={onEnded}
            onProgress={onProgress}
            className="absolute inset-0 h-full w-full object-cover"
          />
        </div>

        {/* caption row under the panel */}
        <div className="mt-5 flex flex-col gap-4 sm:mt-6 sm:gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--color-primary-foreground)] opacity-70">
              {copy.slate}
            </div>
            <h3 className="mt-2 font-display text-[clamp(19px,2.4vw,30px)] font-black uppercase leading-[0.98] tracking-[-0.02em] text-[color:var(--color-primary-foreground)]">
              {copy.title}
            </h3>
            <p className="mt-2 max-w-[560px] text-[13px] font-medium sm:text-[14px] leading-relaxed text-[color:var(--color-primary-foreground)] opacity-80">
              {copy.lede}
            </p>
          </div>
          <Link
            href={loop.href}
            className="press inline-flex shrink-0 items-center justify-center gap-2 self-start border-[2.5px] border-[color:var(--color-primary-foreground)] bg-[color:var(--color-bg)] px-3.5 py-2 font-display text-[12px] font-black uppercase text-[color:var(--color-fg)] shadow-[3px_3px_0_0_var(--color-primary-foreground)] sm:px-5 sm:py-3 sm:text-[14px] sm:shadow-[4px_4px_0_0_var(--color-primary-foreground)] md:self-auto"
          >
            {copy.cta} →
          </Link>
        </div>
      </div>
    </section>
  );
}
