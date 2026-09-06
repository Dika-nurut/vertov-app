// Inspector audio-track control — music / voiceover picker + gain/offset/fade
// (extracted from StudioClient.tsx, split 3/N).
import type React from 'react';
import { useRef } from 'react';
import { X } from '../_icons';
import { Row, Toggle, rangePct } from '../_kit/controls';
import type { TAudio } from '../_model';

export function AudioLine({
  label,
  icon,
  value,
  accept,
  onPick,
  onChange,
  onRemove,
  busy,
}: {
  label: string;
  icon: React.ReactNode;
  value: TAudio | null;
  accept: string;
  onPick: (file: File) => void;
  onChange: (a: TAudio) => void;
  onRemove: () => void;
  busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
          e.target.value = '';
        }}
      />
      {value ? (
        <div className="glass space-y-2.5 rounded-[var(--radius-md)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-[13px] text-[color:var(--color-fg)]">
              <span className="text-[color:var(--color-accent)]">{icon}</span>
              <span className="truncate">{value.name}</span>
            </span>
            <button type="button" onClick={onRemove} aria-label={`Удалить: ${label}`}>
              <X
                size={15}
                className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
              />
            </button>
          </div>
          <Row label={`Громкость ${value.gainDb > 0 ? '+' : ''}${value.gainDb} dB`}>
            <input
              type="range"
              min={-30}
              max={10}
              step={1}
              value={value.gainDb}
              onChange={(e) => onChange({ ...value, gainDb: Number(e.target.value) })}
              style={{ ['--pct']: rangePct(value.gainDb, -30, 10) } as React.CSSProperties}
              className="seed-range w-full"
            />
          </Row>
          <Row label={`Старт через ${value.fromSec.toFixed(1)} с`}>
            <input
              type="range"
              min={0}
              max={30}
              step={0.5}
              value={value.fromSec}
              onChange={(e) => onChange({ ...value, fromSec: Number(e.target.value) })}
              style={{ ['--pct']: rangePct(value.fromSec, 0, 30) } as React.CSSProperties}
              className="seed-range w-full"
            />
          </Row>
          <div className="grid grid-cols-2 gap-1.5">
            <Toggle
              label="Фейд-ин"
              on={value.fadeIn}
              onToggle={() => onChange({ ...value, fadeIn: !value.fadeIn })}
            />
            <Toggle
              label="Фейд-аут"
              on={value.fadeOut}
              onToggle={() => onChange({ ...value, fadeOut: !value.fadeOut })}
            />
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="glass glass-hover flex w-full items-center justify-center gap-2 rounded-[var(--radius-md)] py-3 text-[13px] text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)] disabled:opacity-40"
        >
          {icon} {label}
        </button>
      )}
    </div>
  );
}
