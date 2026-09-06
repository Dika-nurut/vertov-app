'use client';

import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '@/lib/utils';

// Brutalist: a blocky bone-bordered rail, periwinkle range, a square bone-
// bordered thumb that carries a small hard offset shadow.
const Slider = React.forwardRef<
  React.ElementRef<typeof SliderPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumbLabel?: string }
>(({ className, thumbLabel = 'Значение', ...props }, ref) => (
  <SliderPrimitive.Root
    ref={ref}
    className={cn('group relative flex w-full touch-none select-none items-center', className)}
    {...props}
  >
    <SliderPrimitive.Track className="relative h-2 w-full grow overflow-hidden rounded-[1px] border-2 border-[var(--color-line)] bg-[var(--color-surface2)]">
      <SliderPrimitive.Range className="absolute h-full bg-[var(--color-accent)]" />
    </SliderPrimitive.Track>
    {/* a11y: the thumb is role=slider and needs an accessible name; consumers can
        override via `thumbLabel` (e.g. «Сила», «Громкость»). */}
    <SliderPrimitive.Thumb
      aria-label={thumbLabel}
      className="block h-[18px] w-3.5 rounded-[1px] border-2 border-[var(--color-line)] bg-foreground shadow-[2px_2px_0_0_var(--color-shadow)] outline-none transition-transform duration-100 hover:-translate-y-px focus-visible:outline-[3px] focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50"
    />
  </SliderPrimitive.Root>
));
Slider.displayName = 'Slider';

export { Slider };
