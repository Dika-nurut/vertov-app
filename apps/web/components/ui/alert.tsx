import { cva, type VariantProps } from 'class-variance-authority';

import * as React from 'react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative w-full rounded-[var(--radius-sm)] border-2 border-[color:var(--color-line)] px-4 py-3 text-sm grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] grid-cols-[0_1fr] has-[>svg]:gap-x-3 gap-y-0.5 items-start [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current shadow-[var(--offset-sm)]',
  {
    variants: {
      variant: {
        default: 'bg-[color:var(--color-surface2)] text-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 line-clamp-1 min-h-4 font-display tracking-tight', className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-1 text-sm font-base [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
