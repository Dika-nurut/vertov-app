'use client';

import { useEffect, useRef, useState } from 'react';
import { X } from '@/components/ui/icons';
import { getOnboardingCopy, type FeatureHintSurface } from '@/lib/onboarding-copy';
import { readClientLocale, type Locale } from '@/lib/locale';
import { useAnchoredPosition } from '@/lib/use-anchored-position';

const TRANSITION_MS = 180;

/** A once-per-browser hint, anchored when a surface exposes a useful target. */
export function FeatureHint({
  surface,
  target = null,
  locale,
}: {
  surface: FeatureHintSurface;
  /** A data-tour-target value; absent means a centered fallback. */
  target?: string | null;
  locale?: Locale;
}) {
  const storageKey = 'seed:hint:' + surface;
  const [activeLocale, setActiveLocale] = useState<Locale>(locale ?? 'ru');
  const [visible, setVisible] = useState(false);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);
  // Keep the anchor alive during the exit animation so the panel does not
  // disappear before its 180ms fade/slide completes.
  const { panelRef, placement } = useAnchoredPosition(target, visible);
  const copy = getOnboardingCopy(activeLocale);

  useEffect(() => {
    setActiveLocale(locale ?? readClientLocale());
    try {
      if (!localStorage.getItem(storageKey)) setVisible(true);
    } catch {
      // Private mode: show once per mount, never persist.
      setVisible(true);
    }
  }, [locale, storageKey]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  function dismiss() {
    if (closing) return;
    try {
      localStorage.setItem(storageKey, '1');
    } catch {
      // The in-memory dismissal still applies.
    }
    setClosing(true);
    timerRef.current = window.setTimeout(() => setVisible(false), TRANSITION_MS);
  }

  if (!visible) return null;

  const style = placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0 };

  return (
    <div
      ref={panelRef}
      role="status"
      aria-live="polite"
      className={
        'fixed z-40 w-[min(92vw,440px)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[5px_5px_0_0_var(--color-shadow)] onboarding-surface ' +
        (closing ? 'onboarding-surface-exit' : 'onboarding-surface-enter')
      }
      data-testid={'feature-hint-' + surface}
      data-placement={placement?.side ?? 'center'}
      style={{ ...style, visibility: placement ? 'visible' : 'hidden' }}
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-sm leading-snug text-[color:var(--color-fg)]">
          {copy.featureHints[surface]}
        </p>
        <button
          type="button"
          onClick={dismiss}
          aria-label={copy.featureHintDismiss}
          className="press shrink-0 border-[2px] border-[color:var(--color-line-soft)] p-1 text-[color:var(--color-muted-foreground)]"
        >
          <X size={12} aria-hidden />
        </button>
      </div>
    </div>
  );
}
