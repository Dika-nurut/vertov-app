'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { handleModalKeyDown, modalFocusables } from '@/lib/modal-focus';
import { getOnboardingCopy } from '@/lib/onboarding-copy';
import { postOnboarding } from '@/lib/onboarding-state';
import type { Locale } from '@/lib/locale';

const TRANSITION_MS = 180;

/** A server-backed welcome dialog. It only disappears after the server accepts the write. */
export function OnboardingCard({
  apiUrl,
  locale,
  onDone,
  onSkip,
}: {
  apiUrl: string;
  locale: Locale;
  onDone: () => void;
  onSkip: () => void;
}) {
  const copy = getOnboardingCopy(locale).card;
  const [loading, setLoading] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  function close(after: () => void) {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(after, TRANSITION_MS);
  }

  const requestSkip = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(onSkip, TRANSITION_MS);
  }, [closing, onSkip]);

  // Dialog contract: focus the confirm action on mount, trap Tab inside,
  // Escape skips (session-only — the server flag stays null for next time).
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestSkip();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = modalFocusables(panelRef.current);
      if (focusable.length === 0) return;
      const active = document.activeElement;
      if (!panelRef.current?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? focusable.at(-1) : focusable[0])?.focus();
        return;
      }
      handleModalKeyDown(event, panelRef.current, requestSkip);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [panelRef, requestSkip]);

  async function markOnboarded() {
    if (loading || closing) return;
    setLoading(true);
    setError(null);
    const saved = await postOnboarding(apiUrl, {});
    setLoading(false);
    if (!saved) {
      setError(copy.retryError);
      return;
    }
    close(onDone);
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-card-title"
      aria-busy={loading}
      className={
        'fixed left-1/2 top-1/2 z-40 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[5px_5px_0_0_var(--color-shadow)] onboarding-surface ' +
        (closing ? 'onboarding-card-exit' : 'onboarding-card-enter')
      }
      data-testid="onboarding-card"
    >
      <div className="flex items-start gap-3">
        <p
          id="onboarding-card-title"
          className="min-w-0 flex-1 text-sm leading-snug text-[color:var(--color-fg)]"
        >
          {copy.lead}
          {/* Lime is the one-spark badge accent, never body text: bone-bold gift
              copy with a small lime dot beside it. */}
          <strong className="font-black text-[color:var(--color-fg)]">
            <span
              aria-hidden="true"
              className="mr-1 inline-block size-2 rounded-full bg-[color:var(--color-accent2)]"
            />
            {copy.gift}
          </strong>
          {copy.tail}
          {error && (
            <span
              className="mt-2 block text-[12px] text-[color:var(--color-destructive)]"
              role="alert"
            >
              {error}
            </span>
          )}
        </p>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void markOnboarded()}
            disabled={loading || closing}
            className="press shrink-0 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="onboarding-submit"
          >
            {loading ? copy.saving : copy.confirm}
          </button>
          <button
            type="button"
            onClick={requestSkip}
            disabled={loading || closing}
            className="px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)] underline decoration-[color:var(--color-line-soft)] underline-offset-2 hover:text-[color:var(--color-fg)] disabled:opacity-50"
            data-testid="onboarding-skip"
          >
            {copy.skip}
          </button>
        </div>
      </div>
    </div>
  );
}
