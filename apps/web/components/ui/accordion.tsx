'use client';

import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from '@/components/ui/icons';

import * as React from 'react';

import { cn } from '@/lib/utils';

function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />;
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn(
        'rounded-[var(--radius-sm)] overflow-hidden border-2 border-[color:var(--color-line)] shadow-[var(--offset-sm)]',
        className,
      )}
      {...props}
    />
  );
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'flex flex-1 items-center justify-between text-left text-base text-foreground border-[color:var(--color-line)] outline-none focus-visible:border-[color:var(--color-accent)] focus-visible:shadow-[3px_3px_0_0_var(--color-shadow)] bg-[color:var(--color-surface2)] p-4 font-display transition-all [&[data-state=open]>svg]:rotate-180 [&[data-state=open]>svg]:text-[color:var(--color-accent)] data-[state=open]:rounded-b-none data-[state=open]:border-b-2 disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown className="pointer-events-none size-5 shrink-0 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden rounded-b-base bg-[color:var(--color-surface2)] text-sm font-base transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('p-4', className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
}

AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
