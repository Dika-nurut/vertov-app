import { TriangleAlert } from '@/components/ui/icons';

/**
 * Error state — a CONTAINED panel (DS), coral-keyed: bone border, coral icon
 * chip, casts the signature offset shadow so it reads as a plane on the canvas.
 */
export function ErrorState({
  message = 'Произошла ошибка. Попробуй обновить страницу.',
  onRetry,
}: {
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex min-h-[42vh] items-center justify-center px-4 py-10">
      <div
        data-testid="error-state"
        className="flex w-full max-w-md flex-col items-center gap-4 rounded-[var(--radius-lg)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-8 py-12 text-center shadow-[6px_6px_0_0_var(--color-shadow)]"
      >
        <div
          aria-hidden
          className="grid h-14 w-14 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] shadow-[3px_3px_0_0_var(--color-shadow)]"
          style={{
            background: 'var(--color-destructive)',
            color: 'var(--color-destructive-foreground)',
          }}
        >
          <TriangleAlert size={24} />
        </div>
        <p className="max-w-xs text-sm text-[color:var(--color-muted-foreground)]">{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="press inline-flex items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] px-4 py-2 text-sm font-bold shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            Попробовать снова
          </button>
        )}
      </div>
    </div>
  );
}
