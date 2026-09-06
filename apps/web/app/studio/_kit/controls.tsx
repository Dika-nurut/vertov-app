// Studio cross-cutting primitives (build once, reuse everywhere). The four
// CapCut atoms that make the editor feel coherent live here so S2 (timeline
// lanes) and S3 (inspector depth) compound on one implementation instead of
// re-deriving sliders/segments per panel.
import type React from 'react';
import { useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { CaretDown, RotateCcw } from '../_icons';

/** Fill ratio (0–100%) for a `.seed-range` slider — drives the periwinkle fill
 * via the inline `--pct` custom property (webkit has no native range-progress). */
export const rangePct = (v: number, lo: number, hi: number): string =>
  `${hi > lo ? Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)) : 0}%`;

/** Calm property-label grammar (sentence-case, quiet). The brutalist mono
 * `label-eyebrow` is RESERVED for SECTION headers (see {@link Section}) so the
 * inspector reads as grouped sections, not a wall of equal-weight ALL-CAPS
 * labels. Every control row uses this one treatment for consistency. */
export const FIELD_LABEL =
  'text-[13px] font-medium leading-none text-[color:var(--color-muted-foreground)]';

/**
 * A titled inspector section — the unit of grouping that gives the panel its
 * hierarchy. The mono eyebrow header is the ONLY uppercase voice inside a panel;
 * everything below it is calm. Optional per-section reset on the right.
 */
export function Section({
  title,
  children,
  onReset,
  canReset,
  testid,
  collapsible,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  onReset?: () => void;
  canReset?: boolean;
  testid?: string;
  /** When set, the header toggles the body. Use to tuck ADVANCED sections away
   *  by default (progressive disclosure) so a selection isn't a wall of controls. */
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = collapsible ? open : true;
  const Header = collapsible ? 'button' : 'div';
  return (
    <section
      data-testid={testid}
      className="rounded-[var(--radius-md)] bg-[color:var(--color-surface2)]/35 p-3 ring-1 ring-inset ring-[color:var(--color-line)]/10"
    >
      <div className={'flex items-center justify-between ' + (shown ? 'mb-3' : '')}>
        <Header
          {...(collapsible
            ? {
                type: 'button' as const,
                onClick: () => setOpen((o) => !o),
                'aria-expanded': open,
                'data-testid': testid ? `${testid}-toggle` : undefined,
                className:
                  'flex flex-1 items-center gap-1.5 text-left transition-colors hover:opacity-80',
              }
            : { className: 'flex flex-1 items-center' })}
        >
          {collapsible && (
            <CaretDown
              size={11}
              className={
                'shrink-0 text-[color:var(--color-faint)] transition-transform ' +
                (open ? '' : '-rotate-90')
              }
            />
          )}
          <span className="label-eyebrow text-[color:var(--color-muted-foreground)]">{title}</span>
        </Header>
        {shown && canReset && onReset && (
          <button
            type="button"
            title="Сбросить раздел"
            aria-label="Сбросить раздел"
            data-testid={testid ? `${testid}-reset` : undefined}
            onClick={onReset}
            className="press-inset inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[11px] font-medium text-[color:var(--color-faint)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
          >
            <RotateCcw size={11} />
            Сброс
          </button>
        )}
      </div>
      {shown && <div className="space-y-3">{children}</div>}
    </section>
  );
}

/** Labelled block wrapper (calm property-label grammar). */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={FIELD_LABEL}>{label}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

/** Segmented single-select (the chip-group used across export/format/speed). A
 * filled `surface2` well split into options; the active one takes the calm
 * bone-ink fill (`.selected-neutral`) — accent is reserved for true CTAs. */
export function Seg<T extends string>({
  options,
  value,
  onChange,
  cols,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Lay options out in a grid (e.g. cols=2) instead of one flex row — use when
   *  labels are long enough to clip in a 3–4-up single row. */
  cols?: 2;
}) {
  return (
    <div
      className={
        (cols === 2 ? 'grid grid-cols-2 ' : 'flex ') +
        'gap-1 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-1'
      }
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          data-selected={o.id === value}
          aria-pressed={o.id === value}
          onClick={() => onChange(o.id)}
          className={
            'press-inset flex-1 rounded-[var(--radius-xs)] px-1.5 py-1.5 text-[11px] font-semibold transition-colors ' +
            (o.id === value
              ? 'selected-neutral'
              : 'text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** CapCut-style triple input (spec §3.1): slider + editable value box + reset.
 * The pattern EVERY numeric clip prop uses. An optional `right` slot carries the
 * per-prop keyframe diamond (S2/S3) so the control stays one component. */
export function TripleInput({
  label,
  value,
  min,
  max,
  step,
  def,
  unit,
  disabled,
  onChange,
  testid,
  right,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Default — the reset target; reset button shows only when value ≠ def. */
  def: number;
  unit?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  testid?: string;
  /** Optional trailing control (e.g. a keyframe diamond) on the label row. */
  right?: React.ReactNode;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="block" data-testid={testid}>
      <div className="flex items-center justify-between">
        <span className={FIELD_LABEL}>{label}</span>
        <span className="flex items-center gap-1.5">
          {value !== def && !disabled && (
            <button
              type="button"
              title="Сбросить"
              aria-label="Сбросить"
              data-testid={testid ? `${testid}-reset` : undefined}
              onClick={() => onChange(def)}
              className="press-inset grid h-5 w-5 place-items-center rounded-[var(--radius-xs)] text-[color:var(--color-faint)] transition-colors hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
            >
              <RotateCcw size={12} />
            </button>
          )}
          {right}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(clamp(Number(e.target.value)))}
          style={{ ['--pct']: rangePct(value, min, max) } as React.CSSProperties}
          className="seed-range w-full disabled:opacity-40"
        />
        <span className="flex shrink-0 items-center gap-0.5">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={value}
            data-testid={testid ? `${testid}-value` : undefined}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(clamp(n));
            }}
            className="tnum w-14 rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-1.5 py-1 text-right text-[11px] text-[color:var(--color-fg)] outline-none ring-1 ring-inset ring-[color:var(--color-line)]/15 [appearance:textfield] focus:border-[color:var(--color-accent)] focus:shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          {unit && <span className="text-[11px] text-[color:var(--color-faint)]">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

/** Inline labelled toggle (the app's switch grammar). */
export function Toggle({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex w-full cursor-pointer items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] px-3 py-2 text-[13px] ring-1 ring-inset ring-[color:var(--color-line)]/15 transition-colors hover:bg-[color:var(--color-surface)]">
      <span className="text-[color:var(--color-muted-foreground)]">{label}</span>
      <Switch
        checked={on}
        onCheckedChange={() => onToggle()}
        className="h-5 w-9 [&>span]:size-4 [&>span]:data-[state=checked]:translate-x-[18px]"
      />
    </label>
  );
}

/** Audio waveform from normalized 0–1 peaks (S2). `preserveAspectRatio=none`
 * stretches the fixed viewBox to whatever lane width it's dropped into. Uses
 * currentColor so the caller tints it per track. */
export function Waveform({ peaks, className }: { peaks: number[]; className?: string }) {
  const n = Math.max(1, peaks.length);
  return (
    <svg
      viewBox={`0 0 ${n} 100`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      {peaks.map((p, i) => {
        const h = Math.max(2, p * 92);
        return (
          <rect
            key={i}
            x={i + 0.12}
            y={(100 - h) / 2}
            width={0.76}
            height={h}
            fill="currentColor"
          />
        );
      })}
    </svg>
  );
}
