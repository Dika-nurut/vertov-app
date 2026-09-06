import type { ReactNode } from 'react';
import Link from 'next/link';
import { WINDOWS } from '../_fmt';

/** 7Д / 30Д / 90Д window selector — plain links carrying ?days=. */
export function WindowPills({ days, basePath }: { days: number; basePath: string }) {
  return (
    <div className="flex border-[2.5px] border-line">
      {WINDOWS.map((w, i) => (
        <Link
          key={w}
          href={`${basePath}?days=${w}`}
          className={
            'px-4 py-2 font-mono text-[11px] tracking-wide ' +
            (i < WINDOWS.length - 1 ? 'border-r-[2.5px] border-line ' : '') +
            (w === days ? 'bg-fg text-[color:var(--color-background)]' : 'text-faint hover:text-fg')
          }
        >
          {w}Д
        </Link>
      ))}
    </div>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-faint">
      {children}
      <span className="h-[2.5px] flex-1 bg-[color:var(--color-line-soft)]" />
    </div>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`border-[2.5px] border-line bg-surface p-5 ${className}`}>{children}</div>;
}

export function Tile({
  label,
  value,
  unit,
  foot,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  foot?: ReactNode;
}) {
  return (
    <div className="border-[2.5px] border-line bg-surface p-4 shadow-[4px_4px_0_0_var(--color-accent)]">
      <div className="font-mono text-[9.5px] uppercase tracking-widest text-faint">{label}</div>
      <div className="my-2 font-display text-[26px] font-black tracking-tight">
        {value}
        {unit ? <span className="text-[14px] text-faint"> {unit}</span> : null}
      </div>
      {foot}
    </div>
  );
}

/** A labelled horizontal bar (subs-by-tier, funnel steps, …). */
export function Bar({
  pctWidth,
  lime = false,
  danger = false,
}: {
  pctWidth: number;
  lime?: boolean;
  danger?: boolean;
}) {
  const fill = danger ? 'bg-destructive' : lime ? 'bg-accent2' : 'bg-accent';
  return (
    <div className="h-5 border-[2.5px] border-line bg-[color:var(--color-surface2)]">
      <div
        className={`h-full ${fill}`}
        style={{ width: `${Math.max(0, Math.min(100, pctWidth))}%` }}
      />
    </div>
  );
}
