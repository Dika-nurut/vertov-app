'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  SceneContinuityLimits,
  SceneContinuityOverflowItem,
} from '../../../lib/scene-continuity-bridge';

/* The board's own dialog idiom: dimmed canvas, one `glass-menu` panel, hard
 * Slate-Brutal buttons. No native window.prompt/confirm ever reaches the user. */

function useDialogEscape(onCancel: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);
}

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function DialogShell({
  testId,
  titleId,
  children,
}: {
  testId: string;
  titleId: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  /* `aria-modal` is a claim, not a behaviour: without this, focus stays on the
   * board control behind the dimmer and Tab walks the whole canvas. */
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const restoreTo = document.activeElement as HTMLElement | null;
    panel.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (stops.length === 0) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onKeyDown);
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      restoreTo?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/65" />
      <div
        ref={panelRef}
        tabIndex={-1}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="glass-menu relative w-full max-w-[560px] p-5 outline-none"
      >
        {children}
      </div>
    </div>
  );
}

const PRIMARY_BUTTON =
  'press inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40';
const SECONDARY_BUTTON =
  'press-inset rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-muted-foreground)]';

/* --------------------- per-shot object subset sheet --------------------- */

export interface SceneObjectSubsetSheetProps {
  reason: string;
  items: readonly SceneContinuityOverflowItem[];
  limits: SceneContinuityLimits;
  onCancel: () => void;
  onConfirm: (selectedIds: string[]) => void;
}

export function SceneObjectSubsetSheet({
  reason,
  items,
  limits,
  onCancel,
  onConfirm,
}: SceneObjectSubsetSheetProps) {
  useDialogEscape(onCancel);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.filter((item) => item.selected && !item.disabledReason).map((i) => i.id)),
  );
  const totals = useMemo(() => {
    const chosen = items.filter((item) => selected.has(item.id) && !item.disabledReason);
    return {
      cards: chosen.length,
      // The de-duplicated union, exactly as the planner counts it: summing pack
      // sizes would refuse a selection whose cards share a still.
      stills: new Set(chosen.flatMap((item) => item.stillUrls)).size,
    };
  }, [items, selected]);
  const fits = totals.cards <= limits.slots && totals.stills <= limits.stills;

  return (
    <DialogShell testId="scene-subset-sheet" titleId="scene-subset-title">
      <h3 id="scene-subset-title" className="font-display text-[19px] text-[color:var(--color-fg)]">
        Слишком много референсов
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {reason} Выберите объекты целиком — часть пачки подключить нельзя.
      </p>

      <ul className="mt-4 max-h-[46vh] space-y-1.5 overflow-y-auto">
        {items.map((item) => {
          const disabled = Boolean(item.disabledReason);
          const checked = selected.has(item.id) && !disabled;
          return (
            <li key={item.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                disabled={disabled}
                data-testid={`scene-subset-item-${item.id}`}
                onClick={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })
                }
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-2 text-left text-[13px] ${
                  checked
                    ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                    : 'border-[color:var(--color-line-soft)] text-[color:var(--color-muted-foreground)]'
                } disabled:opacity-50`}
              >
                <span
                  aria-hidden
                  className={`grid h-3.5 w-3.5 shrink-0 place-items-center border-2 ${
                    checked
                      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]'
                      : 'border-[color:var(--color-line-soft)]'
                  }`}
                />
                <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-faint)]">
                  {disabled ? item.disabledReason : `${item.stillCount} реф.`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p
        data-testid="scene-subset-total"
        className="mt-3 font-mono text-[11px] uppercase text-[color:var(--color-faint)]"
      >
        объектов {totals.cards} / {limits.slots} · референсов {totals.stills} / {limits.stills}
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-testid="scene-subset-cancel"
          onClick={onCancel}
          className={SECONDARY_BUTTON}
        >
          Отмена
        </button>
        <button
          type="button"
          data-testid="scene-subset-confirm"
          disabled={!fits || totals.cards === 0}
          onClick={() => onConfirm([...selected])}
          className={PRIMARY_BUTTON}
        >
          Продолжить · {totals.stills} / {limits.stills}
        </button>
      </div>
    </DialogShell>
  );
}

/* ------------------------- object promotion ------------------------- */

export interface SceneObjectPromotionCandidate {
  id: string;
  name: string;
  castKind: string;
  stillCount: number;
}

export type SceneObjectPromotionRequest =
  | { kind: 'create-product'; name: string }
  | { kind: 'reuse-product'; name: string; candidate: SceneObjectPromotionCandidate }
  | { kind: 'choose'; name: string; candidates: SceneObjectPromotionCandidate[] };

const CAST_KIND_LABEL: Record<string, string> = {
  character: 'человек',
  location: 'место',
  product: 'товар',
};

export function SceneObjectPromotionDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: SceneObjectPromotionRequest;
  onCancel: () => void;
  /** `null` creates a new card; a string reuses that existing cast node. */
  onConfirm: (castNodeId: string | null) => void;
}) {
  useDialogEscape(onCancel);
  const [chosen, setChosen] = useState<string | null>(null);

  if (request.kind === 'choose') {
    return (
      <DialogShell testId="scene-promote-choose" titleId="scene-promote-title">
        <h3
          id="scene-promote-title"
          className="font-display text-[19px] text-[color:var(--color-fg)]"
        >
          Выберите объект
        </h3>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
          На борде несколько карточек «{request.name}». Подключим ту, которую выберете.
        </p>
        <ul className="mt-4 max-h-[46vh] space-y-1.5 overflow-y-auto">
          {request.candidates.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="radio"
                aria-checked={chosen === candidate.id}
                data-testid={`scene-promote-candidate-${candidate.id}`}
                onClick={() => setChosen(candidate.id)}
                className={`flex w-full items-center gap-2 rounded-[var(--radius-sm)] border-2 px-3 py-2 text-left text-[13px] ${
                  chosen === candidate.id
                    ? 'border-[color:var(--color-accent)] text-[color:var(--color-fg)]'
                    : 'border-[color:var(--color-line-soft)] text-[color:var(--color-muted-foreground)]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-semibold">{candidate.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-[color:var(--color-faint)]">
                  {CAST_KIND_LABEL[candidate.castKind] ?? candidate.castKind} ·{' '}
                  {candidate.stillCount} реф.
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            data-testid="scene-promote-cancel"
            onClick={onCancel}
            className={SECONDARY_BUTTON}
          >
            Отмена
          </button>
          <button
            type="button"
            data-testid="scene-promote-confirm"
            disabled={chosen === null}
            onClick={() => onConfirm(chosen)}
            className={PRIMARY_BUTTON}
          >
            Выбрать
          </button>
        </div>
      </DialogShell>
    );
  }

  const reuse = request.kind === 'reuse-product';
  return (
    <DialogShell testId="scene-promote-product" titleId="scene-promote-title">
      <h3
        id="scene-promote-title"
        className="font-display text-[19px] text-[color:var(--color-fg)]"
      >
        {reuse ? 'Использовать товар?' : 'Создать как товар?'}
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        {reuse
          ? `«${request.name}» уже есть на борде как товар. Подключим существующую карточку.`
          : `«${request.name}» — вещь. Отдельной роли для реквизита нет, поэтому карточка будет создана как товар.`}
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-testid="scene-promote-cancel"
          onClick={onCancel}
          className={SECONDARY_BUTTON}
        >
          Не добавлять
        </button>
        <button
          type="button"
          data-testid="scene-promote-confirm"
          onClick={() => onConfirm(reuse ? request.candidate.id : null)}
          className={PRIMARY_BUTTON}
        >
          {reuse ? 'Использовать' : 'Создать как товар'}
        </button>
      </div>
    </DialogShell>
  );
}

/* --------------- detaching a card whose pack ran empty --------------- */

export function CastPackDetachDialog({
  shotCount,
  onCancel,
  onConfirm,
}: {
  shotCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useDialogEscape(onCancel);
  return (
    <DialogShell testId="cast-detach-dialog" titleId="cast-detach-title">
      <h3 id="cast-detach-title" className="font-display text-[19px] text-[color:var(--color-fg)]">
        Удалить последний референс?
      </h3>
      <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-muted-foreground)]">
        Объект подключён к {shotCount} кадрам. Удалить референс и отсоединить объект от этих кадров?
      </p>
      <div className="mt-5 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-testid="cast-detach-cancel"
          onClick={onCancel}
          className={SECONDARY_BUTTON}
        >
          Отмена
        </button>
        <button
          type="button"
          data-testid="cast-detach-confirm"
          onClick={onConfirm}
          className="press inline-flex items-center justify-center rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-destructive)] px-3 py-2 text-[13px] font-semibold text-[color:var(--color-destructive-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
        >
          Удалить и отсоединить
        </button>
      </div>
    </DialogShell>
  );
}
