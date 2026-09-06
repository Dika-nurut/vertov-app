'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, Lock, ArrowsDownUp } from '@phosphor-icons/react/dist/ssr';
import { cardVisual } from '../../lib/visual-hash';
import { capabilitySigns } from '../../lib/model-capabilities';
import type { ModelCard } from '../../lib/generate-model-cards';
import type { ModelRow, PresetRow } from './GenerateClient';

/**
 * Higgsfield-style model + effect picker, rendered IN the preview panel when the
 * user presses the model button. Model = a grid of cards, ONE per catalog row —
 * including the `-reference-to-video` twins, which are separate tools (frames vs
 * references), not a hidden mode of their base. Effect = ONE motion preset, each
 * a card with its (static PNG) example. Selecting an effect only highlights it;
 * its prompt is folded in at submit time (the visible prompt stays clean).
 */
export function ModelEffectPicker({
  cards,
  currentModelId,
  canUseModel,
  onSelect,
  effects,
  selectedSlug,
  onToggleEffect,
  assetSrc,
  view,
  onClose,
}: {
  cards: ModelCard<ModelRow>[];
  currentModelId: string | null;
  canUseModel: (m: ModelRow) => boolean;
  onSelect: (m: ModelRow) => void;
  effects: PresetRow[];
  selectedSlug: string | null;
  onToggleEffect: (p: PresetRow) => void;
  assetSrc: (url: string) => string;
  /** Which grid the preview shows — driven by the active sidebar card. */
  view: 'model' | 'effect';
  onClose: () => void;
}) {
  // Search + family filter (data-driven from the catalog, no vendor folders).
  const [q, setQ] = useState('');
  const [family, setFamily] = useState('all');
  // Subtle sort — default (catalog order) or cheapest-first.
  const [sort, setSort] = useState<'default' | 'cheap'>('default');
  const families = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) set.add(c.model.family);
    return Array.from(set);
  }, [cards]);
  const shownCards = useMemo(() => {
    const query = q.trim().toLowerCase();
    const filtered = cards.filter((c) => {
      if (family !== 'all' && c.model.family !== family) return false;
      if (!query) return true;
      const hay =
        `${c.name} ${c.tag} ${c.note ?? ''} ${c.model.family} ${c.model.variant}`.toLowerCase();
      return hay.includes(query);
    });
    if (sort === 'cheap') {
      return [...filtered].sort((a, b) => a.model.minUnitCredits - b.model.minUnitCredits);
    }
    return filtered;
  }, [cards, q, family, sort]);
  const kindLabel = cards[0]?.model.kind === 'video' ? 'Видео-движки' : 'Модели';

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b-[2.5px] border-[color:var(--color-line)] px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Назад"
            className="press-inset grid h-9 w-9 place-items-center rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] text-[color:var(--color-muted-foreground)] transition-colors hover:bg-[color:var(--color-surface)] hover:text-[color:var(--color-fg)]"
          >
            <ArrowLeft size={16} weight="bold" />
          </button>
          <span className="font-display text-[16px] font-black uppercase tracking-[-0.01em] text-[color:var(--color-fg)]">
            {view === 'model' ? 'Выбор модели' : 'Эффекты'}
          </span>
        </div>
        {view === 'effect' && (
          <button
            type="button"
            onClick={onClose}
            className="press-inset inline-flex h-9 items-center rounded-[var(--radius-sm)] bg-[color:var(--color-accent)] px-4 text-[13px] font-bold uppercase tracking-[0.02em] text-[color:var(--color-primary-foreground)]"
          >
            Готово
          </button>
        )}
      </div>

      <div className="seed-scroll min-h-0 flex-1 space-y-6 overflow-y-auto p-4 sm:p-5">
        {/* Models — full grid, ALL wired models for the mode */}
        {view === 'model' && (
          <section>
            {/* Search — instant filter over name/vendor/family/variant. */}
            <div className="mb-2.5 flex items-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-3 py-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Поиск: veo, звук, i2v…"
                aria-label="Поиск модели"
                className="w-full bg-transparent text-[13px] text-[color:var(--color-fg)] outline-none placeholder:text-[color:var(--color-faint)]"
              />
            </div>
            {/* Family filter chips — derived from the catalog, not vendor folders. */}
            <div className="mb-3.5 flex flex-wrap gap-2">
              {['all', ...families].map((f) => {
                const on = family === f;
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFamily(f)}
                    className={
                      'rounded-[var(--radius-sm)] border-2 px-3 py-1 font-mono text-[11px] font-bold uppercase tracking-wide transition-colors ' +
                      (on
                        ? 'border-[color:var(--color-accent)] bg-[rgba(var(--accent-rgb),0.14)] text-[color:var(--color-accent)]'
                        : 'border-[color:var(--color-line)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
                    }
                  >
                    {f === 'all' ? 'Все' : f}
                  </button>
                );
              })}
            </div>
            {/* Count + subtle sort toggle. */}
            <div className="mb-2.5 flex items-center justify-between">
              <span className="font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[color:var(--color-faint)]">
                {kindLabel} · {shownCards.length}
              </span>
              <button
                type="button"
                onClick={() => setSort((s) => (s === 'default' ? 'cheap' : 'default'))}
                className="flex items-center gap-1.5 rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] px-2 py-1 font-mono text-[11px] font-bold uppercase text-[color:var(--color-fg)]"
              >
                <ArrowsDownUp size={12} />
                {sort === 'default' ? 'Рекомендуемые' : 'Сначала дешёвые'}
              </button>
            </div>
            {/* Grid — no icon; capability sign badges (standardised EN) + cost. */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
              {shownCards.map((c) => {
                const on = c.model.id === currentModelId;
                const locked = !canUseModel(c.model);
                const signs = capabilitySigns(c.model);
                return (
                  <button
                    key={c.model.id}
                    type="button"
                    data-model-id={c.model.id}
                    title={c.note ?? c.name}
                    onClick={() => {
                      onSelect(c.model);
                      // Model choice is a complete action: apply it and return
                      // to the generator immediately, without a second "Done".
                      onClose();
                    }}
                    className={
                      'flex flex-col gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-2.5 text-left shadow-[3px_3px_0_0_var(--color-shadow)] transition-colors ' +
                      (on
                        ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                        : 'border-[color:var(--color-line)] bg-[color:var(--color-surface2)] hover:bg-[color:var(--color-surface)]')
                    }
                  >
                    {/* The name owns the full card width and wraps: a pair card
                      («… · кадры» / «… · референсы») is only useful if the part
                      that tells the two apart survives the layout. Price/lock
                      moved down beside the vendor tag to make room. */}
                    <span
                      className={
                        'text-[13px] font-semibold leading-tight ' +
                        (on
                          ? 'text-[color:var(--color-primary-foreground)]'
                          : 'text-[color:var(--color-fg)]')
                      }
                    >
                      {c.name}
                    </span>
                    <span className="flex items-baseline justify-between gap-2">
                      <span
                        className={
                          'truncate font-mono text-[11px] uppercase tracking-wide ' +
                          (on
                            ? 'text-[color:var(--color-primary-foreground)]/70'
                            : 'text-[color:var(--color-faint)]')
                        }
                      >
                        {c.tag}
                      </span>
                      {locked && (
                        <Lock
                          size={13}
                          weight="bold"
                          className="shrink-0 text-[color:var(--color-faint)]"
                        />
                      )}
                    </span>
                    {/* Input note — only on rows that share a base/twin pair, where
                      the name alone can't say which tool this is. */}
                    {c.note && (
                      <span
                        className={
                          'text-[11px] leading-tight ' +
                          (on
                            ? 'text-[color:var(--color-primary-foreground)]/80'
                            : 'text-[color:var(--color-muted-foreground)]')
                        }
                      >
                        {c.note}
                      </span>
                    )}
                    {signs.length > 0 && (
                      <span className="flex flex-wrap gap-1.5">
                        {signs.map((s) => (
                          <span
                            key={s}
                            className={
                              'rounded-[var(--radius-xs)] border-[1.5px] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase ' +
                              (s === 'AUDIO'
                                ? 'border-[color:var(--color-accent2)] text-[color:var(--color-accent2)]'
                                : s === 'REF'
                                  ? 'border-[color:var(--color-accent)] text-[color:var(--color-accent)]'
                                  : 'border-[color:var(--color-line)]/40 text-[color:var(--color-muted-foreground)]')
                            }
                          >
                            {s}
                          </span>
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Effects — single select */}
        {view === 'effect' && effects.length > 0 && (
          <section>
            <p className="label-eyebrow mb-2.5">Камера · эффекты · стили</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {effects.map((p) => {
                const on = selectedSlug === p.slug;
                return (
                  <button
                    key={p.id}
                    type="button"
                    data-testid="effect-card"
                    aria-pressed={on}
                    title={p.description || p.title}
                    onClick={() => onToggleEffect(p)}
                    className={
                      'lift-card group relative flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-[var(--radius-sm)] border-2 text-left shadow-[3px_3px_0_0_var(--color-shadow)] ' +
                      (on
                        ? 'border-[color:var(--color-accent)]'
                        : 'border-[color:var(--color-line)]')
                    }
                  >
                    <div
                      className="absolute inset-0"
                      style={{ background: cardVisual(p.slug).background }}
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
                        className="absolute inset-0 h-full w-full object-cover"
                      />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/15 to-transparent" />
                    <span
                      className={
                        'relative z-10 p-2.5 font-display text-[13px] font-bold leading-tight ' +
                        (on
                          ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
                          : 'text-white')
                      }
                    >
                      {p.title}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
