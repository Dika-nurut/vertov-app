'use client';

import { useEffect, useRef, useState } from 'react';
import { FilmSlate, ImageSquare, Play } from '@phosphor-icons/react/dist/ssr';
import { cardVisual } from '../../lib/visual-hash';
import { assetSrc } from '@/lib/asset-src';
import {
  fmtClock,
  fmtEtaHint,
  inflightProgressPct,
  inflightStageLabel,
  type InflightGeneration,
} from '@/lib/inflight-generations';

/**
 * Gif-like preview for a video tile: muted, looping the first ~3s. Plays only
 * while on screen (IntersectionObserver) so a long grid doesn't stream every
 * clip at once; the poster (first frame) shows until playback starts.
 */
function VideoPreview({
  src,
  poster,
  className,
}: {
  src: string;
  poster?: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cap = () => {
      if (el.currentTime >= 3) el.currentTime = 0; // loop just the first 3s
    };
    el.addEventListener('timeupdate', cap);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void el.play().catch(() => {});
          else el.pause();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      el.removeEventListener('timeupdate', cap);
      io.disconnect();
    };
  }, []);
  return (
    <video
      ref={ref}
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      className={className}
    />
  );
}

export interface GenerationTile {
  id: string;
  /** Display source (same-origin). Caller passes the already-proxied URL. */
  src: string;
  kind: 'image' | 'video';
  prompt?: string | null;
  /** Raw asset URL — used by the parent's onSelect to open the full result. */
  assetUrl?: string | null;
  /** Source job for restoring the generation's own recipe in the detail area. */
  jobId?: string | null;
  /** The freshest tile gets the single lime «новое» spark. */
  isNew?: boolean;
}

export type GenFilter = 'all' | 'image' | 'video';

const FILTERS: { id: GenFilter; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'image', label: 'Фото' },
  { id: 'video', label: 'Видео' },
];

/**
 * Preview "has-history" state — «Твои генерации».
 *
 * A grid of the user's OWN past outputs (not example prompts). Each tile is a
 * neobrutalism card: colour-block thumb + a neutral ФОТО/ВИДЕО sticker; the
 * single lime spark is the «новое» badge on the freshest result. Filter
 * segmented (Все/Фото/Видео) sits in the header next to the count.
 *
 * Presentational only — the parent owns data + filter state.
 */
export function GenerationsGrid({
  items,
  filter,
  onFilterChange,
  onSelect,
  total,
  inflight = [],
  onSelectInflight,
}: {
  items: GenerationTile[];
  filter: GenFilter;
  onFilterChange: (f: GenFilter) => void;
  onSelect?: (item: GenerationTile) => void;
  total?: number;
  inflight?: InflightGeneration[];
  onSelectInflight?: (generation: InflightGeneration) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const visibleInflight =
    filter === 'all' ? inflight : inflight.filter((generation) => generation.kind === filter);
  const count = (total ?? items.length) + inflight.length;

  useEffect(() => {
    if (inflight.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [inflight.length]);

  return (
    <div className="flex h-full w-full flex-col gap-4 px-4 py-4 sm:px-5">
      {/* Header — title + count + filter */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-display text-[20px] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-fg)]">
          Твои генерации{' '}
          <span className="tnum align-baseline font-mono text-[13px] font-bold text-[color:var(--color-faint)]">
            · {count}
          </span>
        </h2>
        <div className="flex rounded-[var(--radius-sm)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] p-0.5">
          {FILTERS.map((f) => {
            const on = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onFilterChange(f.id)}
                aria-pressed={on}
                className={
                  'press-inset rounded-[var(--radius-xs)] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] transition-colors ' +
                  (on
                    ? 'selected-neutral'
                    : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                }
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Grid */}
      <div className="seed-scroll grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-3 overflow-y-auto pb-1 sm:grid-cols-3 xl:grid-cols-4">
        {visibleInflight.map((generation) => {
          const elapsedSec = Math.max(0, Math.floor((now - generation.startedAt) / 1000));
          const progressPct = inflightProgressPct(elapsedSec, generation.etaSec, generation.status);
          return (
            <button
              key={generation.jobId}
              type="button"
              data-testid="inflight-generation-tile"
              onClick={() => onSelectInflight?.(generation)}
              title={generation.modelLabel}
              className="lift-card relative flex aspect-[3/4] flex-col justify-between overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-accent)] bg-[color:var(--color-surface)] p-3 text-left shadow-[3px_3px_0_0_var(--color-shadow)]"
            >
              <span className="label-eyebrow text-[color:var(--color-faint)]">
                {generation.modelLabel}
              </span>
              <span className="flex flex-col gap-3">
                <span className="flex items-center gap-2">
                  <span className="seed-pulse-dot h-3 w-3 shrink-0 rounded-full bg-[color:var(--color-accent)]" />
                  <span className="font-display text-[18px] font-black uppercase leading-none tracking-[-0.01em] text-[color:var(--color-fg)]">
                    {inflightStageLabel(generation.status, generation.kind)}
                  </span>
                </span>
                <span
                  className="seed-step-bar h-3 w-full border-2 border-[color:var(--color-line)]"
                  style={{ ['--pct']: `${progressPct}%` } as React.CSSProperties}
                />
                <span className="tnum font-mono text-[11px] text-[color:var(--color-faint)]">
                  {fmtClock(elapsedSec)}
                  {elapsedSec < generation.etaSec
                    ? ` · обычно ${fmtEtaHint(generation.etaSec)}`
                    : ' · почти готово'}
                </span>
              </span>
            </button>
          );
        })}
        {items.map((it) => {
          const isVideo = it.kind === 'video';
          return (
            <button
              key={it.id}
              type="button"
              data-testid="generation-tile"
              onClick={() => onSelect?.(it)}
              title={it.prompt ?? undefined}
              className="lift-card group relative flex aspect-[3/4] flex-col justify-end overflow-hidden rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-left shadow-[3px_3px_0_0_var(--color-shadow)]"
            >
              {/* Colour-block base — a real thumbnail covers it when present. */}
              <div
                className="absolute inset-0"
                style={{ background: cardVisual(it.id).background }}
              />
              {/* Media covers the colour-block when present; without a src we
                  fall back to the gradient so a thumbnail-less row still reads. */}
              {it.src &&
                (isVideo ? (
                  <VideoPreview
                    src={it.assetUrl ? assetSrc(it.assetUrl) : it.src}
                    poster={it.src}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.src}
                    alt={it.prompt ?? ''}
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ))}
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />

              {/* Kind sticker — neutral dark; lime stays reserved for «новое». */}
              <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-bg)] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[color:var(--color-fg)]">
                {isVideo ? (
                  <FilmSlate size={12} weight="bold" />
                ) : (
                  <ImageSquare size={12} weight="bold" />
                )}
                {isVideo ? 'Видео' : 'Фото'}
              </span>
              {it.isNew && (
                <span
                  className="absolute right-2 top-2 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.06em]"
                  style={{
                    background: 'var(--color-accent2)',
                    color: 'var(--color-accent2-foreground)',
                  }}
                >
                  Новое
                </span>
              )}
              {isVideo && (
                <span className="pointer-events-none absolute inset-0 grid place-items-center">
                  <span className="grid h-11 w-11 place-items-center rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] text-[color:var(--color-fg)] shadow-[2px_2px_0_0_var(--color-shadow)] transition-transform duration-200 group-hover:-translate-y-0.5">
                    {/* fill triangle is left-heavy → nudge 1px right to optically centre */}
                    <Play size={16} weight="fill" className="relative left-[1px]" />
                  </span>
                </span>
              )}

              {it.prompt && (
                <p className="relative z-10 line-clamp-2 p-2.5 font-mono text-[11px] leading-snug text-white/90">
                  {it.prompt}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
