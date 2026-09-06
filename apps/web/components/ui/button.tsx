'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

// Brutalist buttons — solid fills, hard 2.5px bone border, a HARD periwinkle
// offset shadow (no blur), and a tactile press: hover nudges up-left into a
// bigger offset, :active drives the key into its shadow. `default` is the one
// periwinkle CTA (DARK text for AA); the rest are surface + bone border.
// Source of truth: mockups/variant-nb.html?p=7.
const press =
  'hover:-translate-x-px hover:-translate-y-px active:translate-x-[2px] active:translate-y-[2px]';
const offset = 'shadow-[3px_3px_0_0_var(--color-shadow)]';
const offsetHover = 'hover:shadow-[5px_5px_0_0_var(--color-shadow)]';
const offsetPressed = 'active:shadow-[2px_2px_0_0_var(--color-shadow)]'; // --offset-pressed (ladder, D5)

const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-sm font-bold tracking-tight select-none',
    'transition-[transform,box-shadow,background-color,color] duration-100',
    'outline-none focus-visible:outline-[3px] focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2',
    'disabled:pointer-events-none disabled:bg-[color:var(--color-surface2)] disabled:text-[color:var(--color-faint)] disabled:shadow-none disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        default: cn(
          'border-[2.5px] border-[var(--color-line)] bg-primary text-primary-foreground',
          offset,
          offsetHover,
          offsetPressed,
          press,
        ),
        secondary: cn(
          'border-[2.5px] border-[var(--color-line)] bg-secondary text-foreground',
          offset,
          offsetHover,
          offsetPressed,
          press,
        ),
        outline: cn(
          'border-[2.5px] border-[var(--color-line)] bg-transparent text-foreground hover:bg-secondary',
          offset,
          offsetHover,
          offsetPressed,
          press,
        ),
        ghost: cn(
          'border-[2.5px] border-transparent bg-transparent text-[var(--color-muted-foreground)]',
          'hover:bg-secondary hover:text-foreground active:translate-x-px active:translate-y-px',
        ),
        destructive: cn(
          'border-[2.5px] border-[var(--color-line)] bg-destructive text-destructive-foreground',
          offset,
          offsetHover,
          offsetPressed,
          press,
        ),
        link: 'border-[2.5px] border-transparent bg-transparent text-[var(--color-accent)] underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        default: 'h-10 px-[18px]',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'size-10',
        'icon-sm': 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size, className }))} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
