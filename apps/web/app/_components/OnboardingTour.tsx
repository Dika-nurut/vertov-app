'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { handleModalKeyDown, modalFocusables } from '@/lib/modal-focus';
import { getOnboardingCopy, type TourStepKey } from '@/lib/onboarding-copy';
import type { Locale } from '@/lib/locale';
import { useAnchoredPosition } from '@/lib/use-anchored-position';

const SPOTLIGHT_PADDING = 8;
const TRANSITION_MS = 180;

const DESKTOP_STEPS: TourStepKey[] = ['model', 'prompt', 'submit', 'done'];
const MOBILE_STEPS: TourStepKey[] = ['model', 'prompt', 'submit'];

function Backdrop({
  anchor,
  label,
  onDismiss,
}: {
  anchor: { top: number; right: number; bottom: number; left: number } | null;
  label: string;
  onDismiss: () => void;
}) {
  if (!anchor) {
    return (
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-0 cursor-default bg-black/40"
        data-testid="onboarding-backdrop"
        onClick={onDismiss}
      />
    );
  }

  const top = Math.max(0, anchor.top - SPOTLIGHT_PADDING);
  const right = Math.min(window.innerWidth, anchor.right + SPOTLIGHT_PADDING);
  const bottom = Math.min(window.innerHeight, anchor.bottom + SPOTLIGHT_PADDING);
  const left = Math.max(0, anchor.left - SPOTLIGHT_PADDING);
  const common = {
    position: 'fixed' as const,
  };
  // Keep one stable test/accessibility hook on a non-zero dim region. The
  // target can sit against the top edge, so the top strip is not always the
  // region a programmatic backdrop click should use.
  const clickRegion =
    top > 0 ? 'top' : window.innerHeight - bottom > 0 ? 'bottom' : left > 0 ? 'left' : 'right';
  const corners = [
    { top, left, borderBottomRightRadius: SPOTLIGHT_PADDING },
    { top, left: right - SPOTLIGHT_PADDING, borderBottomLeftRadius: SPOTLIGHT_PADDING },
    { top: bottom - SPOTLIGHT_PADDING, left, borderTopRightRadius: SPOTLIGHT_PADDING },
    {
      top: bottom - SPOTLIGHT_PADDING,
      left: right - SPOTLIGHT_PADDING,
      borderTopLeftRadius: SPOTLIGHT_PADDING,
    },
  ];

  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-x-0 top-0 cursor-default bg-black/40"
        data-testid={clickRegion === 'top' ? 'onboarding-backdrop' : undefined}
        onClick={onDismiss}
        style={{ ...common, height: top }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute left-0 cursor-default bg-black/40"
        data-testid={clickRegion === 'left' ? 'onboarding-backdrop' : undefined}
        data-onboarding-backdrop-region="left"
        onClick={onDismiss}
        style={{ ...common, top, width: left, height: Math.max(0, bottom - top) }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute right-0 cursor-default bg-black/40"
        data-testid={clickRegion === 'right' ? 'onboarding-backdrop' : undefined}
        data-onboarding-backdrop-region="right"
        onClick={onDismiss}
        style={{
          ...common,
          top,
          width: Math.max(0, window.innerWidth - right),
          height: bottom - top,
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-auto absolute inset-x-0 bottom-0 cursor-default bg-black/40"
        data-testid={clickRegion === 'bottom' ? 'onboarding-backdrop' : undefined}
        data-onboarding-backdrop-region="bottom"
        onClick={onDismiss}
        style={{ ...common, top: bottom, height: Math.max(0, window.innerHeight - bottom) }}
      />
      {corners.map((style, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="pointer-events-auto absolute cursor-default bg-black/40"
          data-onboarding-backdrop-region="corner"
          onClick={onDismiss}
          style={{
            ...common,
            width: SPOTLIGHT_PADDING,
            height: SPOTLIGHT_PADDING,
            ...style,
          }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </>
  );
}

export function OnboardingTour({
  step,
  mobile,
  locale,
  onAdvance,
  onDismiss,
}: {
  step: number;
  mobile: boolean;
  locale: Locale;
  onAdvance: () => void;
  onDismiss: () => void;
}) {
  const copy = getOnboardingCopy(locale);
  const steps = mobile ? MOBILE_STEPS : DESKTOP_STEPS;
  const stepIndex = Math.min(Math.max(step, 0), steps.length - 1);
  const stepKey = steps[stepIndex]!;
  const content = copy.tour[stepKey];
  const target = stepKey === 'done' ? null : stepKey;
  const { panelRef, placement } = useAnchoredPosition(target, true);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<number | null>(null);

  const requestDismiss = useCallback(() => {
    if (closing) return;
    setClosing(true);
    timerRef.current = window.setTimeout(onDismiss, TRANSITION_MS);
  }, [closing, onDismiss]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    nextRef.current?.focus();
  }, [stepIndex]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestDismiss();
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
      handleModalKeyDown(event, panelRef.current, requestDismiss);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [panelRef, requestDismiss]);

  const style = placement ? { top: placement.top, left: placement.left } : { top: 0, left: 0 };
  const anchor = placement?.anchor
    ? {
        top: placement.anchor.top - SPOTLIGHT_PADDING,
        right: placement.anchor.right + SPOTLIGHT_PADDING,
        bottom: placement.anchor.bottom + SPOTLIGHT_PADDING,
        left: placement.anchor.left - SPOTLIGHT_PADDING,
      }
    : null;
  const arrowStyle =
    placement?.arrowX === null || placement?.arrowX === undefined
      ? undefined
      : { left: placement.arrowX };
  const isLast = stepIndex === steps.length - 1;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[100]"
      data-testid="onboarding-tour-layer"
      data-mobile={mobile ? 'true' : 'false'}
    >
      <Backdrop anchor={anchor} label={copy.tour.dismissBackdrop} onDismiss={requestDismiss} />
      {anchor && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[101] rounded-[var(--radius-md)] border-[2.5px] border-[color:var(--color-accent)]"
          data-testid="onboarding-spotlight"
          style={{
            top: anchor.top,
            left: anchor.left,
            width: Math.max(0, anchor.right - anchor.left),
            height: Math.max(0, anchor.bottom - anchor.top),
          }}
        />
      )}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-tour-title"
        aria-describedby="onboarding-tour-body"
        aria-live="polite"
        data-testid="onboarding-tour"
        data-mobile={mobile ? 'true' : 'false'}
        data-tour-step={stepKey}
        data-placement={placement?.side ?? 'center'}
        className={`pointer-events-auto fixed z-[102] w-[min(92vw,380px)] max-h-[calc(100dvh-24px-env(safe-area-inset-bottom))] overflow-y-auto border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-[5px_5px_0_0_var(--color-shadow)] onboarding-surface ${closing ? 'onboarding-surface-exit' : 'onboarding-surface-enter'}`}
        style={{ ...style, visibility: placement ? 'visible' : 'hidden' }}
      >
        {placement && placement.side !== 'center' && (
          <span
            aria-hidden="true"
            data-testid="onboarding-tour-arrow"
            className={
              placement?.side === 'bottom'
                ? 'absolute -top-[7px] h-3.5 w-3.5 rotate-45 border-l-[2.5px] border-t-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]'
                : 'absolute -bottom-[7px] h-3.5 w-3.5 rotate-45 border-b-[2.5px] border-r-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface)]'
            }
            style={arrowStyle}
          />
        )}
        <p id="onboarding-tour-title" className="label-eyebrow mb-1.5" aria-live="polite">
          {content.title}
        </p>
        <p
          id="onboarding-tour-body"
          className="text-sm leading-relaxed text-[color:var(--color-fg)]"
        >
          {content.body}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={requestDismiss}
            data-testid="onboarding-tour-skip"
            className="sp-btn-ghost border-[2px] border-[color:var(--color-line-soft)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]"
          >
            {copy.tour.skip}
          </button>
          <span className="font-mono text-[10px] text-[color:var(--color-muted-foreground)]">
            {stepIndex + 1}/{steps.length}
          </span>
          <button
            ref={nextRef}
            type="button"
            onClick={isLast ? requestDismiss : onAdvance}
            data-testid="onboarding-tour-next"
            className="sp-btn border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-wider text-[color:var(--color-primary-foreground)]"
          >
            {isLast ? copy.tour.finish : copy.tour.next}
          </button>
        </div>
      </div>
    </div>
  );
}
