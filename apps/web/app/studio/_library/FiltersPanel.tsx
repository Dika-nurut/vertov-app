// Library filters panel (extracted from StudioClient.tsx, split 5e/N).
import { FILTER_CSS, FILTER_LABEL } from '../_model';
import type { Filter, TClip } from '../_model';

export function FiltersPanel({
  clip,
  patchClip,
}: {
  clip: TClip | null;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
}) {
  return (
    <section data-testid="lib-filters">
      <p className="label-eyebrow mb-3">Фильтры</p>
      {!clip && (
        <p className="mb-3 text-[13px] leading-relaxed text-[color:var(--color-faint)]">
          Каталог фильтров — выбери клип на таймлайне, чтобы применить.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {(['none', 'warm', 'cool', 'mono', 'punch'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            data-testid={`filter-${f}`}
            disabled={!clip}
            aria-pressed={clip?.filter === f}
            onClick={() => clip && patchClip(clip.uid, { filter: f })}
            className={
              'press-inset overflow-hidden rounded-[var(--radius-sm)] ring-1 ring-inset transition-shadow disabled:cursor-default ' +
              (clip?.filter === f
                ? 'ring-2 ring-[color:var(--color-accent)]'
                : 'ring-[color:var(--color-line)]/15 hover:ring-[color:var(--color-line)]/40')
            }
          >
            <span className="studio-swatch block h-12 w-full" style={{ filter: FILTER_CSS[f] }} />
            <span className="block py-1 text-[11px] font-medium text-[color:var(--color-muted-foreground)]">
              {FILTER_LABEL[f]}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
