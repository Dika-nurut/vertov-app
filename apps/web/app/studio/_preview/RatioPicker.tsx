// On-canvas aspect-ratio picker (chip + menu) — extracted from
// StudioClient.tsx, split 5j/N.
import type React from 'react';
import { useRef } from 'react';
import { Check, Proportions } from '../_icons';
import { PortalMenu } from '../_kit/PortalMenu';
import { FORMATS } from '../_model';
import type { Format } from '../_model';

export function RatioPicker({
  format,
  setFormat,
  ratioOpen,
  setRatioOpen,
}: {
  format: Format;
  setFormat: (f: Format) => void;
  ratioOpen: boolean;
  setRatioOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const chipRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="absolute left-2 top-2 z-50">
      <button
        ref={chipRef}
        type="button"
        data-testid="ratio-chip"
        aria-haspopup="menu"
        aria-expanded={ratioOpen}
        onClick={() => setRatioOpen((v) => !v)}
        className="glass-menu flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-fg)] ring-1 ring-inset ring-[color:var(--color-line)]/30"
      >
        <Proportions size={13} /> {format.label}
      </button>
      <PortalMenu
        anchorRef={chipRef}
        open={ratioOpen}
        onClose={() => setRatioOpen(false)}
        testid="ratio-menu"
      >
        <div className="space-y-0.5">
          {FORMATS.map((f) => {
            const on = f.id === format.id;
            const gr = f.width / f.height;
            const gw = gr >= 1 ? 16 : Math.max(4, Math.round(16 * gr));
            const gh = gr >= 1 ? Math.max(4, Math.round(16 / gr)) : 16;
            return (
              <button
                key={f.id}
                type="button"
                data-testid={`ratio-${f.id}`}
                onClick={() => {
                  setFormat(f);
                  setRatioOpen(false);
                }}
                className={
                  'flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-1.5 text-left ' +
                  (on
                    ? 'bg-[color:var(--color-surface2)] text-[color:var(--color-fg)] ring-1 ring-inset ring-[color:var(--color-accent)]'
                    : 'text-[color:var(--color-muted-foreground)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
                }
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center">
                  <span
                    className="rounded-[1px] border-[1.5px] border-current"
                    style={{ width: gw, height: gh }}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">{f.label}</span>
                  <span className="block text-[11px] text-[color:var(--color-faint)]">
                    {f.hint}
                  </span>
                </span>
                {on && <Check size={13} className="text-[color:var(--color-accent)]" />}
              </button>
            );
          })}
        </div>
      </PortalMenu>
    </div>
  );
}
