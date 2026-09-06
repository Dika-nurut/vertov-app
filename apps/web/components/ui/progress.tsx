'use client';

import * as ProgressPrimitive from '@radix-ui/react-progress';

import * as React from 'react';

import { cn } from '@/lib/utils';

// Progress never glides — the fill SNAPS in discrete periwinkle blocks
// (SPEC 08-01 / docket D3) via `.seed-step-bar`, driven by `--pct`. Native
// tokens only (docket D9).
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  value?: number;
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        'relative h-4 w-full overflow-hidden rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)]',
        className,
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="seed-step-bar h-full w-full"
        style={{ '--pct': `${value || 0}%` } as React.CSSProperties}
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
