'use client';

import { useState, type ReactNode } from 'react';
import { X } from '@/components/ui/icons';

/**
 * Mobile-only (`lg:hidden`) access layer for the scenario canvas. Below `lg` the
 * desktop side panels (`LeftPanel`/`RightRail`) are `hidden`, so on phones/tablets
 * this floating dock is the only way to reach СОДЕРЖАНИЕ / МИР ПРОЕКТА / РЕДАКТОР.
 * The panels are passed in as ready elements and mounted ON DEMAND (only while a
 * drawer is open) so there's no permanent second instance. Desktop is untouched.
 */
export function ScenarioMobileDock({
  scenesCount,
  canonCount,
  soderjanie,
  mir,
  editor,
}: {
  scenesCount: number;
  canonCount: number;
  soderjanie: ReactNode;
  mir: ReactNode;
  editor: ReactNode;
}) {
  const [open, setOpen] = useState<null | 'scenes' | 'mir' | 'editor'>(null);
  const close = () => setOpen(null);

  return (
    <>
      {/* full-screen Редактор — the AI co-author gets the whole screen (chat) */}
      {open === 'editor' && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-[color:var(--color-bg)] lg:hidden"
          data-testid="scenario-meditor"
        >
          <div className="flex shrink-0 items-center gap-3 border-b-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-3 py-2.5">
            <button
              onClick={close}
              aria-label="Закрыть редактор"
              data-testid="scenario-meditor-close"
              className="sp-btn-ghost inline-flex items-center gap-1.5 border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px]"
            >
              <X size={14} aria-hidden />
              Свернуть
            </button>
          </div>
          <div className="min-h-0 flex-1">{editor}</div>
        </div>
      )}

      {/* bottom-sheet — Содержание / Мир проекта */}
      {(open === 'scenes' || open === 'mir') && (
        <div className="fixed inset-0 z-[60] lg:hidden" data-testid="scenario-msheet">
          <div className="absolute inset-0 bg-black/55" onClick={close} aria-hidden />
          <div className="absolute inset-x-0 bottom-0 flex max-h-[82%] flex-col rounded-t-[6px] border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]">
            <button
              onClick={close}
              aria-label="Закрыть"
              className="sp-btn-ghost mx-3 mb-1 mt-1 self-end border-[2px] border-[color:var(--color-line-soft)] px-2 py-1 text-[13px] text-[color:var(--color-muted-foreground)]"
            >
              <X size={14} aria-hidden />
            </button>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 pt-0">
              {open === 'scenes' ? soderjanie : mir}
            </div>
          </div>
        </div>
      )}

      {/* the dock itself — floating brutalist bar */}
      <nav
        className="fixed inset-x-3 bottom-3 z-50 flex h-14 overflow-hidden border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] shadow-[4px_4px_0_0_var(--color-shadow)] lg:hidden"
        data-testid="scenario-mdock"
      >
        <DockBtn
          label="Сцены"
          badge={scenesCount}
          active={open === 'scenes'}
          onClick={() => setOpen('scenes')}
          testid="scenario-mtab-scenes"
        />
        <DockBtn
          label="Мир"
          badge={canonCount}
          active={open === 'mir'}
          onClick={() => setOpen('mir')}
          testid="scenario-mtab-mir"
        />
        <DockBtn
          label="Редактор"
          active={open === 'editor'}
          onClick={() => setOpen('editor')}
          testid="scenario-mtab-editor"
        />
      </nav>
    </>
  );
}

function DockBtn({
  label,
  badge,
  active,
  onClick,
  testid,
}: {
  label: string;
  badge?: number;
  active: boolean;
  onClick: () => void;
  testid: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={
        'flex flex-1 items-center justify-center gap-1.5 border-r-[2px] border-[color:var(--color-line-soft)] font-mono text-[11px] uppercase tracking-wider last:border-r-0 ' +
        (active
          ? 'bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]'
          : 'text-[color:var(--color-muted-foreground)]')
      }
    >
      {label}
      {badge != null && badge > 0 && (
        <span
          className={
            'rounded-[2px] border-[1.5px] px-1 text-[11px] ' +
            (active
              ? 'border-[color:var(--color-line-soft)] bg-black/15 text-[color:var(--color-primary-foreground)]'
              : 'border-[color:var(--color-line-soft)] bg-[color:var(--color-surface2)]')
          }
        >
          {badge}
        </span>
      )}
    </button>
  );
}
