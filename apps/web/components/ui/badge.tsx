import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Brutalist sticker/tag — a sharp, 2px bone-bordered block with the Space-Mono
// micro-label voice (uppercase, letter-spaced). Fills tint with the accent
// (periwinkle, DARK text), mint, or coral. Source of truth: variant-nb.html?p=7.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-[var(--radius-xs)] border-2 px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em] leading-none transition-colors',
  {
    variants: {
      variant: {
        default: 'border-[var(--color-line)] bg-surface text-foreground',
        accent: 'border-[var(--color-line)] bg-primary text-[var(--color-primary-foreground)]',
        mint: 'border-[var(--color-line)] bg-positive text-[var(--color-positive-foreground)]',
        outline: 'border-[var(--color-line)] bg-transparent text-[var(--color-muted-foreground)]',
        destructive:
          'border-[var(--color-line)] bg-destructive text-[var(--color-destructive-foreground)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
