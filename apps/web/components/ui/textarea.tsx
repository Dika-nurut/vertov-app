import * as React from 'react';

import { cn } from '@/lib/utils';

// Brutalist field — inset well, a hard 2.5px bone border, sharp corners, a
// periwinkle caret. Focus snaps the border to periwinkle + a small hard offset,
// matching the Input primitive. No Tailwind ring (SPEC 06-03 / docket D1); native
// tokens only (docket D9).
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex min-h-[80px] w-full rounded-[var(--radius-sm)] border-[2.5px] border-[var(--color-line)] bg-[var(--color-surface2)] px-3 py-2 text-sm text-foreground',
        'caret-[var(--color-accent)] placeholder:text-[var(--color-faint)]',
        'transition-[border-color,box-shadow] duration-100',
        'outline-none focus:border-[var(--color-accent)] focus:shadow-[3px_3px_0_0_var(--color-shadow)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
