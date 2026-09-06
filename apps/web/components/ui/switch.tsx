'use client';

import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '@/lib/utils';

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-[var(--radius-xs)] border-[2.5px] border-[var(--color-line)] px-0.5 outline-none transition-colors duration-150',
      'focus-visible:outline-[3px] focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-[var(--color-accent)] data-[state=unchecked]:bg-[var(--color-surface2)]',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 translate-x-0 rounded-[1px] bg-foreground transition-transform duration-150 data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-[var(--color-primary-foreground)]" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

export { Switch };
