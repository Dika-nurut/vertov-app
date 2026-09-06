// Timeline toolbar — undo/redo + magnet-snap + zoom group (extracted from
// StudioClient.tsx, split 5n/N).
import type React from 'react';
import { Loader2, Magnet, Maximize2, Redo2, Undo2, Zap, ZoomIn, ZoomOut } from '../_icons';
import { rangePct } from '../_kit/controls';

const PPS_MIN = 4;
const PPS_MAX = 240;

export function TimelineToolbar({
  canUndo,
  undo,
  canRedo,
  redo,
  snapOn,
  setSnapOn,
  pps,
  userZoomed,
  zoomTo,
  fitZoom,
  beatsOn,
  bpm,
  beatBusy,
  musicUrl,
  toggleBeats,
}: {
  canUndo: boolean;
  undo: () => void;
  canRedo: boolean;
  redo: () => void;
  snapOn: boolean;
  setSnapOn: React.Dispatch<React.SetStateAction<boolean>>;
  pps: number;
  userZoomed: React.MutableRefObject<boolean>;
  zoomTo: (next: number) => void;
  fitZoom: () => void;
  beatsOn: boolean;
  bpm: number | null;
  beatBusy: boolean;
  musicUrl: string | null;
  toggleBeats: (musicUrl: string | null) => void;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
      <div className="flex items-center gap-2">
        <span className="label-eyebrow text-[color:var(--color-faint)]">Таймлайн</span>
        {/* Undo / redo (§5.2) — ⌘Z / ⌘⇧Z. */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            title="Отменить (⌘Z)"
            data-testid="undo"
            disabled={!canUndo}
            onClick={undo}
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-30 disabled:hover:text-[color:var(--color-muted-foreground)]"
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            title="Повторить (⌘⇧Z)"
            data-testid="redo"
            disabled={!canRedo}
            onClick={redo}
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)] disabled:opacity-30 disabled:hover:text-[color:var(--color-muted-foreground)]"
          >
            <Redo2 size={14} />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className="hidden text-[11px] text-[color:var(--color-faint)] lg:inline">
          пробел — плей · S — разрезать · Del — удалить
        </span>
        {/* Magnetic snap toggle (CapCut "Attach", spec §5.1). */}
        <button
          type="button"
          title={snapOn ? 'Магнит включён' : 'Магнит выключен'}
          data-testid="snap-toggle"
          aria-pressed={snapOn}
          onClick={() => setSnapOn((v) => !v)}
          className={
            'press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] ' +
            (snapOn
              ? 'text-[color:var(--color-accent)]'
              : 'text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]')
          }
        >
          <Magnet size={14} />
        </button>
        {/* Beat markers — analyzes the music track once and snaps edits to it
          (adapted from OpenReel's onset detector, see lib/beat-detect.ts). */}
        <button
          type="button"
          title={
            !musicUrl
              ? 'Добавь музыку, чтобы включить биты'
              : beatsOn
                ? 'Биты выключить'
                : 'Найти биты в музыке'
          }
          data-testid="beats-toggle"
          aria-pressed={beatsOn}
          disabled={!musicUrl || beatBusy}
          onClick={() => toggleBeats(musicUrl)}
          className={
            'press-inset flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 disabled:opacity-30 ' +
            (beatsOn
              ? 'text-[color:var(--color-accent)]'
              : 'text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]')
          }
        >
          {beatBusy ? <Loader2 size={14} className="seed-spin" /> : <Zap size={14} />}
          {beatsOn && bpm != null && (
            <span className="font-mono text-[11px] tabular-nums">{Math.round(bpm)} BPM</span>
          )}
        </button>
        {/* Zoom group (CapCut spec §5.1): − · slider · + · fit. */}
        <div className="flex items-center gap-1.5" data-testid="timeline-zoom">
          <button
            type="button"
            title="Отдалить"
            data-testid="zoom-out"
            onClick={() => {
              userZoomed.current = true;
              zoomTo(pps / 1.3);
            }}
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <ZoomOut size={14} />
          </button>
          <input
            type="range"
            min={PPS_MIN}
            max={PPS_MAX}
            step={1}
            value={pps}
            aria-label="Масштаб таймлайна"
            onChange={(e) => {
              userZoomed.current = true;
              zoomTo(Number(e.target.value));
            }}
            style={{ ['--pct']: rangePct(pps, PPS_MIN, PPS_MAX) } as React.CSSProperties}
            className="seed-range w-24"
          />
          <span
            data-testid="zoom-pct"
            title="Масштаб таймлайна"
            className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-[color:var(--color-faint)]"
          >
            {Math.round(((pps - PPS_MIN) / (PPS_MAX - PPS_MIN)) * 100)}%
          </span>
          <button
            type="button"
            title="Приблизить"
            data-testid="zoom-in"
            onClick={() => {
              userZoomed.current = true;
              zoomTo(pps * 1.3);
            }}
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <ZoomIn size={14} />
          </button>
          <button
            type="button"
            title="Вместить весь ролик"
            data-testid="zoom-fit"
            onClick={fitZoom}
            className="press-inset grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
