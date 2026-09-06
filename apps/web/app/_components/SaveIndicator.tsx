'use client';

import { useCallback, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2 } from '@/components/ui/icons';

/**
 * Honest autosave status. Surfaces that silently `fetch().catch(() => {})`
 * leave the user believing work is saved when it isn't — the #1 trust bug.
 * This hook drives a small indicator (saving → saved → idle, or error with
 * a retry) and serialises saves: a newer save supersedes an older one's
 * outcome, so a slow in-flight PUT can't flip the badge back to «saved»
 * after a later edit failed.
 *
 * The save fn returns Promise<boolean> — true means persisted.
 */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export function useSaveStatus(resetMs = 1600): {
  state: SaveState;
  run: (fn: () => Promise<boolean>) => void;
  retry: () => void;
} {
  const [state, setState] = useState<SaveState>('idle');
  const seqRef = useRef(0);
  const lastFnRef = useRef<null | (() => Promise<boolean>)>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = useCallback(
    (fn: () => Promise<boolean>) => {
      lastFnRef.current = fn;
      const my = ++seqRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      setState('saving');
      void fn()
        .then((ok) => {
          if (my !== seqRef.current) return; // a newer save owns the badge now
          setState(ok ? 'saved' : 'error');
          if (ok) {
            timerRef.current = setTimeout(() => {
              if (my === seqRef.current) setState('idle');
            }, resetMs);
          }
        })
        .catch(() => {
          if (my === seqRef.current) setState('error');
        });
    },
    [resetMs],
  );

  const retry = useCallback(() => {
    if (lastFnRef.current) run(lastFnRef.current);
  }, [run]);

  return { state, run, retry };
}

export function SaveIndicator({
  state,
  onRetry,
  className,
}: {
  state: SaveState;
  onRetry?: () => void;
  className?: string;
}) {
  if (state === 'idle') return null;
  const base = 'inline-flex items-center gap-1.5 text-[11px] font-medium ' + (className ?? '');
  if (state === 'saving') {
    return (
      <span className={base + ' text-[color:var(--color-faint)]'} data-testid="save-indicator">
        <Loader2 size={11} className="seed-spin" /> Сохранение…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span
        className={base + ' text-[color:var(--color-muted-foreground)]'}
        data-testid="save-indicator"
      >
        <Check size={11} className="text-[color:var(--color-accent)]" /> Сохранено
      </span>
    );
  }
  return (
    <span className={base + ' text-destructive'} data-testid="save-indicator-error">
      <AlertCircle size={11} /> Не сохранено
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-0.5 underline underline-offset-2 hover:text-destructive/80"
        >
          повторить
        </button>
      )}
    </span>
  );
}
