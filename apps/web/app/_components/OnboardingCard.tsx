'use client';

import { useEffect, useRef, useState } from 'react';
import { getOnboardingCopy } from '@/lib/onboarding-copy';
import { postOnboarding } from '@/lib/onboarding-state';
import type { Locale } from '@/lib/locale';

const TRANSITION_MS = 180;

/** A server-backed welcome card. It only disappears after the server accepts the write. */
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
      role="status"
      aria-live="polite"
      aria-busy={loading}
      className={
        'fixed left-1/2 top-1/2 z-40 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[5px_5px_0_0_var(--color-shadow)] onboarding-surface ' +
        (closing ? 'onboarding-card-exit' : 'onboarding-card-enter')
      }
      data-testid="onboarding-card"
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-snug text-[color:var(--color-fg)]">
          {copy.lead}
          <strong className="font-bold text-[color:var(--color-accent2)]">{copy.gift}</strong>
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
            onClick={() => close(onSkip)}
            disabled={loading || closing}
            className="font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)] underline decoration-[color:var(--color-line-soft)] underline-offset-2 hover:text-[color:var(--color-fg)] disabled:opacity-50"
            data-testid="onboarding-skip"
          >
            {copy.skip}
          </button>
        </div>
      </div>
    </div>
  );
}
