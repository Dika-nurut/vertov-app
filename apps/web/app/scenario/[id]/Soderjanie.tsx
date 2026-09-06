'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from '@/components/ui/icons';
import type { SceneNavItem } from '../scenario-nav';

/** Show the filter only once the list is long enough to need it (keep short
 *  scripts uncluttered — the declutter ethos). */
const FILTER_MIN_SCENES = 8;

export type SceneDragProps = (scene: SceneNavItem) => {
  draggable: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  isDropTarget: boolean;
};

interface SoderjanieProps {
  scenes: SceneNavItem[];
  /** 1-based index of the scene under the caret (0 = none). */
  currentIndex: number;
  onJump: (offset: number) => void;
  onAddScene: (after: SceneNavItem | null) => void;
  onAddSynopsis: (scene: SceneNavItem) => void;
  /** Drag-reorder (Phase B4); when omitted rows aren't draggable. */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  dragProps?: SceneDragProps;
}

/**
 * СОДЕРЖАНИЕ — the scene navigator (spec §4a, the verified industry rudiment):
 * one row per scene with a duration estimate, live from the text; the current
 * scene tracks the caret; click jumps; «+ Сцена» only once a scene exists.
 */
export function Soderjanie(props: SoderjanieProps) {
  const { scenes, currentIndex, onJump, onAddScene, onAddSynopsis, dragProps } = props;
  const current = scenes.find((s) => s.index === currentIndex) ?? null;

  // Scene filter/search: matches slugline OR synopsis (case-insensitive). Only
  // offered on longer scripts; while filtering, drag-reorder is suppressed
  // (reordering a filtered subset has no unambiguous meaning).
  const [query, setQuery] = useState('');
  const showFilter = scenes.length >= FILTER_MIN_SCENES;
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!q) return scenes;
    return scenes.filter(
      (s) =>
        (s.heading ?? '').toLowerCase().includes(q) || (s.synopsis ?? '').toLowerCase().includes(q),
    );
  }, [scenes, q]);
  const filtering = q.length > 0;

  // Keep the current scene visible as the caret moves — on a long doc the active
  // row is otherwise below the fold and the tracking indicator is invisible.
  // `block: 'nearest'` = minimal scroll (no-op when already in view), so it never
  // jerks the list around while you type within one scene. (Adversarial finding W1.)
  const activeRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentIndex]);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]"
      data-testid="scenario-soderjanie"
    >
      <div className="flex items-center gap-2 border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-widest text-[color:var(--color-muted-foreground)]">
          Содержание
        </span>
        <span className="border-[2px] border-[color:var(--color-line-soft)] px-1 font-mono text-[11px] leading-4 text-[color:var(--color-muted-foreground)]">
          {filtering ? `${visible.length}/${scenes.length}` : scenes.length}
        </span>
      </div>

      {showFilter && (
        <div className="border-b-[2px] border-[color:var(--color-line-soft)] px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            placeholder="Поиск по сценам…"
            data-testid="scenario-scene-filter"
            className="w-full bg-transparent font-mono text-[11px] text-[color:var(--color-fg)] placeholder:text-[color:var(--color-muted-foreground)] focus:outline-none"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {scenes.length === 0 ? (
          <div className="p-3">
            <div className="flex items-baseline gap-2 opacity-50">
              <span className="font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                1
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
                ИНТ. МЕСТО — ВРЕМЯ
              </span>
            </div>
            <p className="mt-1 pl-4 text-[11px] italic leading-relaxed text-[color:var(--color-muted-foreground)]">
              соберётся само из текста — начни на листе →
            </p>
          </div>
        ) : filtering && visible.length === 0 ? (
          <p
            className="p-4 text-center text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]"
            data-testid="scenario-scene-filter-empty"
          >
            Ничего не найдено
          </p>
        ) : (
          <ul>
            {visible.map((s) => {
              const dp = filtering ? undefined : dragProps?.(s);
              const active = s.index === currentIndex;
              return (
                <li
                  key={s.index}
                  ref={active ? activeRef : undefined}
                  data-testid="scenario-scene-row"
                  draggable={dp?.draggable ?? false}
                  onDragStart={dp?.onDragStart}
                  onDragOver={dp?.onDragOver}
                  onDrop={dp?.onDrop}
                  className={`border-b-[2px] border-[color:var(--color-line-soft)] ${
                    dp?.isDropTarget ? 'border-t-[2px] border-t-[color:var(--color-accent)]' : ''
                  } ${active ? 'bg-[color:var(--color-surface2)]' : ''} group`}
                >
                  <button
                    onClick={() => onJump(s.from)}
                    className="sp-btn-ghost group flex w-full items-start gap-2 px-3 py-2 text-left"
                    data-testid="scenario-scene-jump"
                  >
                    {/* current-scene periwinkle bar */}
                    <span
                      aria-hidden
                      className={`mt-0.5 h-4 w-[3px] shrink-0 ${
                        active ? 'bg-[color:var(--color-accent)]' : 'bg-transparent'
                      }`}
                    />
                    <span className="font-mono text-[11px] leading-4 text-[color:var(--color-muted-foreground)]">
                      {s.index}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-wide text-[color:var(--color-fg)]">
                          {s.heading || '(без заголовка)'}
                        </span>
                        <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-muted-foreground)]">
                          ({s.duration})
                        </span>
                      </span>
                    </span>
                    {dp?.draggable && (
                      <span
                        aria-hidden
                        className="mt-0.5 shrink-0 cursor-grab select-none font-mono text-[13px] leading-4 text-[color:var(--color-muted-foreground)]"
                        onClick={(e) => e.stopPropagation()}
                      >
                        ≡
                      </span>
                    )}
                  </button>
                  {s.synopsis ? (
                    <p className="-mt-1 ml-12 truncate px-3 pb-2 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
                      {s.synopsis}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onAddSynopsis(s)}
                      data-testid="scenario-add-synopsis"
                      className="-mt-1 ml-12 block px-3 pb-2 font-mono text-[11px] text-[color:var(--color-muted-foreground)] opacity-0 hover:text-[color:var(--color-accent)] focus-visible:opacity-100 focus-visible:text-[color:var(--color-accent)] focus-visible:outline-none group-hover:opacity-100 touch:opacity-100"
                    >
                      + синопсис
                    </button>
                  )}
                  {props.onReorder && !filtering && scenes.length > 1 && (
                    <div
                      className="flex justify-end gap-1 px-3 pb-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch:opacity-100"
                      aria-label={`Переместить сцену ${s.index}`}
                    >
                      <button
                        type="button"
                        disabled={s.index === 1}
                        onClick={() => props.onReorder?.(s.index, s.index - 1)}
                        data-testid="scenario-scene-move-up"
                        className="cursor-pointer border-[1.5px] border-[color:var(--color-line-soft)] px-1.5 py-0.5 text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] focus-visible:border-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30"
                        aria-label="Переместить сцену выше"
                      >
                        <ChevronUp size={12} aria-hidden />
                      </button>
                      <button
                        type="button"
                        disabled={s.index === scenes.length}
                        onClick={() => props.onReorder?.(s.index, s.index + 1)}
                        data-testid="scenario-scene-move-down"
                        className="cursor-pointer border-[1.5px] border-[color:var(--color-line-soft)] px-1.5 py-0.5 text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-accent)] hover:text-[color:var(--color-fg)] focus-visible:border-[color:var(--color-accent)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-30"
                        aria-label="Переместить сцену ниже"
                      >
                        <ChevronDown size={12} aria-hidden />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* «+ Сцена» only once a scene exists (spec §4a) */}
      {scenes.length > 0 && (
        <div className="border-t-[2px] border-[color:var(--color-line-soft)] p-2.5">
          <button
            onClick={() => onAddScene(current)}
            data-testid="scenario-add-scene"
            className="sp-btn w-full border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-2 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-fg)]"
          >
            <span className="text-[color:var(--color-accent)]">+</span> Сцена
          </button>
        </div>
      )}
    </section>
  );
}
