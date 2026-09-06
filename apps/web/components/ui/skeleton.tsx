import * as React from 'react';

import { cn } from '@/lib/utils';

// Canonical skeleton — a surface2 block with a periwinkle-tinted shimmer sweep
// (SPEC 08-03 / docket D2). Never the frozen `animate-pulse`, which reads as
// "stuck" rather than "loading". Native tokens only (docket D9). Respects
// prefers-reduced-motion (the sweep is disabled in globals.css).
function Skeleton({ className, children, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-xs)] border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)]',
        className,
      )}
      {...props}
    >
      <span className="seed-shimmer-sweep absolute inset-0 bg-gradient-to-r from-transparent via-[rgba(var(--paper-rgb),0.1)] to-transparent" />
      {children}
    </div>
  );
}

export { Skeleton };
