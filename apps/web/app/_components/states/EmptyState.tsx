import Link from 'next/link';
import { Inbox } from '@/components/ui/icons';

/**
 * Empty state — a CONTAINED dashed panel (an «empty slot» card) that floats on
 * the canvas, not bare icon+text in a void (DS: every surface is a plane). The
 * dashed bone border reads as «nothing here yet»; the offset shadow lifts it.
 */
export function EmptyState({
  message = 'Ничего не найдено.',
  actionLabel,
  actionHref,
}: {
  message?: string;
  actionLabel?: string;
  actionHref?: string;
}) {
  return (
    <div className="flex min-h-[42vh] items-center justify-center px-4 py-10">
      <div
        data-testid="empty-state"
        className="flex w-full max-w-md flex-col items-center gap-4 rounded-[var(--radius-lg)] border-[2.5px] border-dashed border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-8 py-12 text-center shadow-[6px_6px_0_0_var(--color-shadow)]"
      >
        <div
          aria-hidden
          className="grid h-14 w-14 place-items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] shadow-[3px_3px_0_0_var(--color-shadow)]"
        >
          <Inbox size={24} className="text-[color:var(--color-muted-foreground)]" />
        </div>
        <p className="max-w-xs text-sm text-[color:var(--color-muted-foreground)]">{message}</p>
        {actionLabel && actionHref && (
          <Link
            href={actionHref}
            className="press inline-flex items-center rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-4 py-2 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)]"
          >
            {actionLabel}
          </Link>
        )}
      </div>
    </div>
  );
}
