'use client';

import { useEffect } from 'react';
import { haptics } from '@/lib/haptics';

// Global, tasteful tactility: a light tick on TOUCH-press of any button-like
// control. One mount in the root layout gives the whole app haptics without
// threading a handler through every component. Touch-only (pointerType guard)
// so mouse and keyboard never fire a phantom buzz, and disabled controls are
// skipped. Capture phase + passive so it can't interfere with the real handler.
const SELECTOR = 'button, [role="button"], a[data-haptic], .press, [data-haptic]';

export function Haptics() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const target = e.target as Element | null;
      const hit = target?.closest<HTMLElement>(SELECTOR);
      if (!hit) return;
      if (hit.hasAttribute('disabled') || hit.getAttribute('aria-disabled') === 'true') return;
      haptics.tap();
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true });
  }, []);

  return null;
}
