// Floating selection toolbar over the canvas (dup / split / crop / delete)
// — extracted from StudioClient.tsx, split 5j/N.
import { Copy, Crop, PenNib, Scissors, Trash2 } from '../_icons';
import type { TClip } from '../_model';

export function CanvasToolbar({
  clip,
  duplicateClip,
  splitAtPlayhead,
  setCropOpen,
  removeClip,
  penActive,
  onPen,
}: {
  clip: TClip;
  duplicateClip: (uid: string) => void;
  splitAtPlayhead: () => void;
  setCropOpen: (v: boolean) => void;
  removeClip: (uid: string) => void;
  penActive: boolean;
  onPen: () => void;
}) {
  return (
    <div
      data-testid="canvas-toolbar"
      className="glass-menu absolute bottom-2 left-1/2 z-50 flex -translate-x-1/2 items-center gap-0.5 rounded-[var(--radius-md)] p-0.5 ring-1 ring-inset ring-[color:var(--color-line)]/30"
    >
      <button
        type="button"
        title="Дублировать (Ctrl+D)"
        data-testid="canvas-duplicate"
        onClick={() => duplicateClip(clip.uid)}
        className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
      >
        <Copy size={13} />
      </button>
      <button
        type="button"
        title="Разрезать под плейхедом (S)"
        data-testid="canvas-split"
        onClick={splitAtPlayhead}
        className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
      >
        <Scissors size={13} />
      </button>
      <button
        type="button"
        title="Кадрировать"
        data-testid="canvas-crop"
        onClick={() => setCropOpen(true)}
        className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]"
      >
        <Crop size={13} />
      </button>
      <button
        type="button"
        title="Маска пером"
        aria-pressed={penActive}
        data-testid="canvas-pen"
        onClick={onPen}
        className={
          'grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] ' +
          (penActive
            ? 'bg-[color:var(--color-accent)] text-[color:var(--color-bg)]'
            : 'text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-[color:var(--color-fg)]')
        }
      >
        <PenNib size={13} />
      </button>
      <button
        type="button"
        title="Удалить (Del)"
        data-testid="canvas-delete"
        onClick={() => removeClip(clip.uid)}
        className="grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-muted-foreground)] hover:bg-[color:var(--color-surface2)] hover:text-destructive"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}
