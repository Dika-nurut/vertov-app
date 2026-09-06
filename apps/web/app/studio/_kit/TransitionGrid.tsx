// Categorized transition picker (CapCut Transitions library §3.9) — shared by
// the inspector «Переход к следующему» section and the left-rail Transitions
// panel so both speak one catalog. Each tile carries a tiny CSS motion glyph
// that animates the transition's geometry on hover, so the grid reads at a
// glance without spending a render. Testids stay `transition-<id>` (floor
// selectors + persist tests depend on them).
import * as React from 'react';
import { TRANSITIONS, TRANSITION_GROUP_LABEL } from '../_model';
import type { Transition, TransitionGroup } from '../_model';

/** Direction/shape glyph per transition — two stacked cells whose motion hints
 * the xfade geometry (slide pushes, wipe sweeps, iris circles, zoom punches). */
function TxGlyph({ id }: { id: Transition }) {
  const base =
    'absolute inset-0 rounded-[3px] transition-[transform,clip-path,opacity] duration-300 ease-out';
  // Resting state; the parent tile's :hover drives the `group-hover` end state.
  const A = 'bg-[color:var(--color-accent)]';
  const B = 'bg-[color:var(--color-line2)]';
  const map: Partial<Record<Transition, React.ReactNode>> = {
    cut: (
      <>
        <span className={`${base} ${A}`} />
      </>
    ),
    crossfade: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A} opacity-100 group-hover:opacity-0`} />
      </>
    ),
    dip: (
      <>
        <span className={`${base} ${A} group-hover:opacity-0`} />
        <span className={`${base} bg-black opacity-0 group-hover:opacity-100`} />
      </>
    ),
    flash: (
      <>
        <span className={`${base} ${A} group-hover:opacity-0`} />
        <span className={`${base} bg-white opacity-0 group-hover:opacity-100`} />
      </>
    ),
    slideleft: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A} translate-x-full group-hover:translate-x-0`} />
      </>
    ),
    slideright: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A} -translate-x-full group-hover:translate-x-0`} />
      </>
    ),
    slideup: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A} translate-y-full group-hover:translate-y-0`} />
      </>
    ),
    slidedown: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A} -translate-y-full group-hover:translate-y-0`} />
      </>
    ),
    wipeleft: (
      <>
        <span className={`${base} ${B}`} />
        <span
          className={`${base} ${A}`}
          style={{ clipPath: 'inset(0 0 0 100%)' }}
          data-wipe="left"
        />
      </>
    ),
    wiperight: (
      <>
        <span className={`${base} ${B}`} />
        <span
          className={`${base} ${A}`}
          style={{ clipPath: 'inset(0 100% 0 0)' }}
          data-wipe="right"
        />
      </>
    ),
    wipeup: (
      <>
        <span className={`${base} ${B}`} />
        <span className={`${base} ${A}`} style={{ clipPath: 'inset(0 0 100% 0)' }} data-wipe="up" />
      </>
    ),
    wipedown: (
      <>
        <span className={`${base} ${B}`} />
        <span
          className={`${base} ${A}`}
          style={{ clipPath: 'inset(100% 0 0 0)' }}
          data-wipe="down"
        />
      </>
    ),
    circleopen: (
      <>
        <span className={`${base} ${B}`} />
        <span
          className={`${base} ${A} scale-0 group-hover:scale-100`}
          style={{ borderRadius: '50%' }}
        />
      </>
    ),
    circleclose: (
      <>
        <span className={`${base} ${A}`} />
        <span
          className={`${base} ${B} scale-100 group-hover:scale-0`}
          style={{ borderRadius: '50%' }}
        />
      </>
    ),
    zoomin: (
      <>
        <span className={`${base} ${B}`} />
        <span
          className={`${base} ${A} scale-150 opacity-40 group-hover:scale-100 group-hover:opacity-100`}
        />
      </>
    ),
  };
  return (
    <span className="relative block h-7 w-full overflow-hidden rounded-[4px] bg-[color:var(--color-surface2)]">
      {map[id] ?? <span className={`${base} ${A}`} />}
    </span>
  );
}

export function TransitionGrid({
  value,
  onPick,
  disabled,
  onTilePointerDown,
}: {
  value: Transition | undefined;
  onPick: (t: Transition) => void;
  disabled?: boolean;
  /** G4: when set, a tile press starts a drag (drop onto a timeline junction).
   *  Click still fires `onPick` (apply to the selected clip) as the fallback. */
  onTilePointerDown?: ((t: Transition, e: React.PointerEvent) => void) | undefined;
}) {
  const groups = (['basic', 'slide', 'wipe', 'zoom'] as TransitionGroup[]).map((g) => ({
    g,
    items: TRANSITIONS.filter((t) => t.group === g),
  }));
  return (
    <div className="space-y-3" data-testid="transition-grid">
      {groups.map(({ g, items }) => (
        <div key={g}>
          <p className="label-eyebrow mb-1.5 text-[11px]">{TRANSITION_GROUP_LABEL[g]}</p>
          <div className="grid grid-cols-2 gap-1.5">
            {items.map((t) => {
              const active = value === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  data-testid={`transition-${t.id}`}
                  disabled={disabled}
                  aria-pressed={active}
                  onPointerDown={(e) => onTilePointerDown?.(t.id, e)}
                  onClick={() => onPick(t.id)}
                  className={
                    'press-inset group flex flex-col items-stretch gap-1 rounded-[var(--radius-sm)] p-1.5 text-left ring-1 ring-inset disabled:cursor-default disabled:opacity-50 ' +
                    (active
                      ? 'ring-2 ring-[color:var(--color-accent)]'
                      : 'ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/35')
                  }
                >
                  <TxGlyph id={t.id} />
                  <span
                    className={
                      'truncate text-[11px] ' +
                      (active
                        ? 'font-semibold text-[color:var(--color-fg)]'
                        : 'text-[color:var(--color-muted-foreground)]')
                    }
                  >
                    {t.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
