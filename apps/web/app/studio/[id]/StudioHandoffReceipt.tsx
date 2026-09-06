'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Check, X } from '@/components/ui/icons';
import { withProjectContext } from '@/lib/project-context';
import { useProjectContext } from '../../_components/ProjectContextProvider';

export function StudioHandoffReceipt({
  status,
  sourceBoardId,
  clipCount,
  projectId,
}: {
  status: 'created' | 'updated' | 'replayed';
  sourceBoardId: string;
  clipCount: number;
  projectId: string;
}) {
  const [open, setOpen] = useState(true);
  const projectContext = useProjectContext();
  const projectTitle =
    projectContext.mode === 'valid' && projectContext.project.id === projectId
      ? projectContext.project.title
      : 'Среда';
  if (!open) return null;
  const label =
    status === 'created'
      ? 'Монтаж создан'
      : status === 'replayed'
        ? 'Повторный запрос распознан'
        : 'Монтаж обновлён';

  return (
    <aside
      data-testid="studio-handoff-receipt"
      className="fixed right-4 top-4 z-[90] w-[min(380px,calc(100vw-2rem))] rounded-[var(--radius-md)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4 shadow-[4px_4px_0_0_var(--color-shadow)]"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[color:var(--color-accent)] text-[color:var(--color-accent-foreground)]">
          <Check size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold">{label}</p>
          <p className="mt-1 text-[11px] leading-relaxed text-[color:var(--color-muted-foreground)]">
            Борд передал {clipCount} {clipCount === 1 ? 'клип' : 'клипов'} в открытый монтаж.
            {status === 'replayed' ? ' Дубликат не создан.' : ''}
          </p>
          <p className="mt-1 text-[11px] text-[color:var(--color-muted-foreground)]">
            Проект: «{projectTitle}».
          </p>
          <Link
            href={withProjectContext(`/boards/${sourceBoardId}`, projectId)}
            className="mt-2 inline-block text-[11px] font-semibold underline decoration-2 underline-offset-4"
          >
            Вернуться к исходному борду
          </Link>
        </div>
        <button
          type="button"
          aria-label="Скрыть уведомление"
          onClick={() => setOpen(false)}
          className="text-[color:var(--color-faint)] hover:text-[color:var(--color-fg)]"
        >
          <X size={14} />
        </button>
      </div>
    </aside>
  );
}
