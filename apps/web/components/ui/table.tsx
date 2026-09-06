import * as React from 'react';

import { cn } from '@/lib/utils';

// Table canon — SPEC 07-04 (docket D4). Borderless engraved: no table frame, no
// per-cell borders, no zebra fill. A faint mono uppercase header sits over a single
// 2.5px bone rule; rows are divided only by --color-line-soft hairlines; row hover
// is a quiet bone-tint STATE (not a fill); status is a borderless plate at the call
// site. The table's frame is the parent window. Native tokens only (docket D9).

function Table({ className, ...props }: React.ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-auto">
      <table
        data-slot="table"
        className={cn('w-full caption-bottom border-collapse text-sm text-foreground', className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
  return (
    <thead
      data-slot="table-header"
      className={cn('[&>tr]:border-b-[2.5px] [&>tr]:border-[color:var(--color-line)]', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  return (
    <tbody
      data-slot="table-body"
      className={cn(
        '[&>tr]:border-b-[2.5px] [&>tr]:border-[color:var(--color-line-soft)] [&>tr:last-child]:border-0',
        className,
      )}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        'border-t-[2.5px] border-[color:var(--color-line)] font-medium text-foreground',
        className,
      )}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        'transition-colors hover:bg-[color:var(--color-surface2)] data-[state=selected]:bg-[color:var(--color-surface2)]',
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        'px-3 py-2 text-left align-middle font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-[color:var(--color-faint)] [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
  return (
    <td
      data-slot="table-cell"
      className={cn('px-3 py-2.5 align-middle [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  );
}

function TableCaption({ className, ...props }: React.ComponentProps<'caption'>) {
  return (
    <caption
      data-slot="table-caption"
      className={cn('mt-4 text-sm text-[color:var(--color-muted-foreground)]', className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
