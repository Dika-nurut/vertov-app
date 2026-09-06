/**
 * The hand-rolled-modal keyboard contract, extracted from ProjectDesktop so the
 * desk's folder dialogs get the same proven behaviour instead of a second,
 * weaker copy. `aria-modal="true"` is a promise that focus cannot leave the
 * dialog — Escape and the Tab cycle are what make that promise true, so they
 * ship together.
 */

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]';

export function modalFocusables(root: HTMLElement | null | undefined): HTMLElement[] {
  return Array.from(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
}

export interface ModalKeyEvent {
  key: string;
  shiftKey: boolean;
  preventDefault: () => void;
}

/**
 * Handles Escape (cancel) and Tab/Shift+Tab (wrap inside the modal). Returns
 * true when the event was consumed.
 */
export function handleModalKeyDown(
  event: ModalKeyEvent,
  root: HTMLElement | null | undefined,
  close: () => void,
): boolean {
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return true;
  }
  if (event.key !== 'Tab') return false;
  const focusable = modalFocusables(root);
  if (focusable.length === 0) return false;
  const first = focusable[0];
  const last = focusable.at(-1);
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last?.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first?.focus();
    return true;
  }
  return false;
}
