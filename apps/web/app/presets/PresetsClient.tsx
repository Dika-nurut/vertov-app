'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Camera,
  Clapperboard,
  ImageIcon,
  Sparkles,
  Wand2,
} from '@/components/ui/icons';
import type { PresetRow } from '../generate/GenerateClient';
import { cardVisual } from '@/lib/visual-hash';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { assetSrc } from '@/lib/asset-src';

/**
 * Preset catalog — the Higgsfield-style browse surface. Camera moves and
 * effects are i2v presets («загрузите фото — мы сделаем crash zoom»);
 * scenes are the editorial image packs from the generate idle stage.
 */
const CATEGORIES = [
  { id: 'all', label: 'Все' },
  { id: 'camera', label: 'Камера' },
  { id: 'effect', label: 'Эффекты' },
  { id: 'style', label: 'Стили' },
  { id: 'scene', label: 'Сцены' },
] as const;

type CategoryId = (typeof CATEGORIES)[number]['id'];

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  camera: <Camera size={13} aria-hidden />,
  effect: <Sparkles size={13} aria-hidden />,
  style: <Wand2 size={13} aria-hidden />,
  scene: <ImageIcon size={13} aria-hidden />,
};

/** Large translucent glyph watermark for preview-less cards. */
const CATEGORY_GLYPH: Record<
  string,
  React.ComponentType<{ size?: number | string; className?: string; strokeWidth?: number }>
> = {
  camera: Camera,
  effect: Sparkles,
  style: Wand2,
  scene: ImageIcon,
};

const CATEGORY_LABEL: Record<string, string> = {
  camera: 'Камера',
  effect: 'Эффект',
  style: 'Стиль',
  scene: 'Сцена',
};

export function PresetsClient({ items }: { items: PresetRow[] }) {
  const [category, setCategory] = useState<CategoryId>('all');

  const filtered = useMemo(
    () => (category === 'all' ? items : items.filter((p) => (p.category ?? 'scene') === category)),
    [items, category],
  );

  return (
    <div className="w-full px-6 py-8 pb-16">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="label-eyebrow mb-2.5">Каталог · Vertov</p>
          <h1 className="text-h2 uppercase">
            Пресеты{' '}
            <span
              className="box-decoration-clone px-1.5"
              style={{
                background: 'var(--color-accent)',
                color: 'var(--color-primary-foreground)',
              }}
            >
              движения
            </span>{' '}
            и стиля
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-[color:var(--color-muted-foreground)]">
            Готовые камера-движения, эффекты и сцены. Выбери пресет — мы заполним промпт и
            настройки; для движений достаточно загрузить одно фото.
          </p>
        </div>
        {/* Category filter — a flat neutral segmented control matching the Tabs
            grammar from the styleguide (bg-white/[0.04] + inset hairline). Kept
            as buttons (not Radix Tabs) so the existing data-testid clicks the
            control directly; active uses the neutral selected state so amber
            stays reserved for the single CTA. */}
        <div className="inline-flex flex-wrap items-center gap-1 rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-surface p-1">
          {CATEGORIES.map((c) => {
            const on = category === c.id;
            return (
              <button
                key={c.id}
                type="button"
                data-testid={`preset-cat-${c.id}`}
                aria-pressed={on}
                onClick={() => setCategory(c.id)}
                className={cn(
                  'press-inset inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-xs)] px-3.5 font-mono text-[12px] font-bold uppercase tracking-wide outline-none transition-colors duration-100',
                  on
                    ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                    : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]',
                )}
              >
                {c.id !== 'all' && CATEGORY_ICON[c.id]}
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card className="grid h-48 place-items-center gap-2 text-center text-sm text-[color:var(--color-faint)]">
          <span>В этой категории пока пусто.</span>
          <button
            type="button"
            onClick={() => setCategory('all')}
            className="font-semibold text-[color:var(--color-accent)] underline-offset-2 hover:underline"
          >
            Показать все пресеты
          </button>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {filtered.map((p) => {
            const cat = p.category ?? 'scene';
            const needsPhoto = p.inputKind === 'image';
            const Glyph = CATEGORY_GLYPH[cat] ?? ImageIcon;
            return (
              <Link
                key={p.id}
                href={`/generate?preset=${encodeURIComponent(p.slug)}`}
                data-testid="preset-card"
                className="lift-card group relative flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-card shadow-[var(--shadow-card)] outline-none"
              >
                {/* Per-slug duotone identity + watermark glyph — every card
                    distinct without a single produced asset; a loadable
                    preview covers it, broken URLs self-remove. */}
                <div
                  className="absolute inset-0"
                  style={{ background: cardVisual(p.slug).background }}
                />
                <Glyph
                  aria-hidden
                  size={104}
                  strokeWidth={1.1}
                  className="absolute -right-4 top-6 rotate-[8deg] text-white/[0.07]"
                />
                {p.samplePreviewUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetSrc(p.samplePreviewUrl)}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                    className="absolute inset-0 h-full w-full object-cover opacity-90"
                  />
                )}

                {/* Category chip — a label scrim over the media (not a content
                    surface), so a faint blur for legibility is fine here. */}
                <span className="absolute left-2.5 top-2.5 z-10 inline-flex items-center gap-1 rounded-[var(--radius-xs)] border-[1.5px] border-[color:var(--color-line)] bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wide text-white">
                  {CATEGORY_ICON[cat]}
                  {CATEGORY_LABEL[cat] ?? cat}
                </span>

                <div className="relative z-10 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-3 pt-10">
                  <p className="text-[14px] font-semibold leading-tight text-white">{p.title}</p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/65">
                    {p.description}
                  </p>
                  <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-[color:var(--color-accent)]">
                    {needsPhoto ? (
                      <>
                        <Clapperboard size={11} aria-hidden /> Загрузи фото — оживим
                      </>
                    ) : (
                      <>Использовать</>
                    )}
                    <ArrowRight
                      size={11}
                      className="transition-transform duration-150 group-hover:translate-x-0.5"
                      aria-hidden
                    />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
