// Library effects panel (extracted from StudioClient.tsx, split 5e/N).
import { colorCss, DEFAULT_COLOR, EFFECTS, FILTER_CSS } from '../_model';
import type { TClip } from '../_model';

export function EffectsPanel({
  clip,
  patchClip,
}: {
  clip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
}) {
  return (
    <section data-testid="lib-effects">
      <p className="label-eyebrow mb-3">Эффекты</p>
      {!clip && (
        <p className="mb-3 text-[13px] leading-relaxed text-[color:var(--color-faint)]">
          Каталог эффектов — выбери клип, чтобы применить.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {EFFECTS.map((e) => {
          const graded = { ...DEFAULT_COLOR, ...e.color };
          const fx =
            colorCss(graded) ||
            (e.filter && e.filter !== 'none' ? FILTER_CSS[e.filter] : undefined);
          return (
            <button
              key={e.id}
              type="button"
              data-testid={`effect-${e.id}`}
              disabled={!clip}
              onClick={() =>
                clip && patchClip(clip.uid, { color: graded, filter: e.filter ?? 'none' })
              }
              className="press-inset overflow-hidden rounded-[var(--radius-sm)] ring-1 ring-inset ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40 disabled:cursor-default"
            >
              <span
                className="studio-swatch block h-12 w-full"
                style={fx ? { filter: fx } : undefined}
              />
              <span className="block py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
                {e.label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
