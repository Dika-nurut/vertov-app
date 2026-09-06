// Inspector background panel (extracted from StudioClient.tsx, split 5b/N).
import { RotateCcw } from '../_icons';
import { BG_SWATCHES } from '../_model';

export function BackgroundPanel({
  bgColor,
  setBgColor,
}: {
  bgColor: string | null;
  setBgColor: (value: string | null) => void;
}) {
  return (
    <div className="space-y-3" data-testid="insp-pane-background">
      <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Фон заполняет поля, когда клип не покрывает кадр (после смены формата). Применяется ко всей
        композиции.
      </p>
      <div className="grid grid-cols-6 gap-2">
        {BG_SWATCHES.map((c) => {
          // Intentional canvas-black default (null sentinel) — video black, not
          // a design token; keep the '#000000' literal so null-mapping stays exact. // bible-ok
          const on = (bgColor ?? '#000000').toLowerCase() === c.toLowerCase();
          return (
            <button
              key={c}
              type="button"
              data-testid={`bg-${c.slice(1)}`}
              aria-pressed={on}
              title={c}
              onClick={() => setBgColor(c === '#000000' ? null : c)}
              className={
                'h-8 rounded-[var(--radius-sm)] ring-inset transition-shadow ' +
                (on
                  ? 'ring-2 ring-[color:var(--color-accent)]'
                  : 'ring-1 ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
              }
              style={{ backgroundColor: c }}
            />
          );
        })}
      </div>
      <label className="flex items-center justify-between rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-2.5 ring-1 ring-inset ring-[color:var(--color-line)]/15">
        <span className="text-[13px] text-[color:var(--color-muted-foreground)]">Свой цвет</span>
        <input
          type="color"
          data-testid="bg-custom"
          value={bgColor ?? '#000000'}
          onChange={(e) => setBgColor(e.target.value)}
          className="h-7 w-10 cursor-pointer rounded bg-transparent"
        />
      </label>
      {bgColor && (
        <button
          type="button"
          data-testid="bg-reset"
          onClick={() => setBgColor(null)}
          className="inline-flex items-center gap-1 text-[11px] text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
        >
          <RotateCcw size={12} /> Сбросить на чёрный
        </button>
      )}
    </div>
  );
}
