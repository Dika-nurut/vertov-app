'use client';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check } from '@/components/ui/icons';

import * as React from 'react';

import { cn } from '@/lib/utils';

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer size-4 shrink-0 outline-2 outline-border focus-visible:outline-[color:var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[color:var(--color-accent)] data-[state=checked]:text-[color:var(--color-primary-foreground)]',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className={cn('flex items-center justify-center text-current')}
      >
        <Check className="size-4 text-[color:var(--color-primary-foreground)]" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
