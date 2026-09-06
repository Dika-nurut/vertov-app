// Tiny, dependency-free haptics. `navigator.vibrate` is honoured on Android /
// Chrome touch devices and is a silent no-op everywhere else (iOS Safari ignores
// it), so this only ever ADDS tactility where the platform supports it — never
// errors, never buzzes a desktop. Keep the patterns short and gentle; a heavy
// buzz reads as "error", a light tick reads as "crafted".
type Pattern = number | number[];

function fire(pattern: Pattern): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { vibrate?: (p: Pattern) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(pattern);
  } catch {
    /* unsupported / blocked — ignore */
  }
}

export const haptics = {
  /** Light tick — buttons, chips, taps. */
  tap: () => fire(8),
  /** A touch firmer — selection / toggle commit. */
  select: () => fire(12),
  /** Two-beat confirm — a job submitted, a render done. */
  success: () => fire([10, 40, 16]),
  /** Buzz pair — a soft warning / blocked action. */
  warn: () => fire([20, 60, 20]),
};
