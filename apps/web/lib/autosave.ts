/**
 * Autosave timing primitives — the "good for the user AND good for us" core.
 *
 * Two industry-standard pieces, kept pure/timer-only so they unit-test with fake
 * timers and inject no React:
 *
 *  1. `createAutosaveScheduler` — the **hybrid "action + inaction" with a
 *     throttle ceiling** pattern. A short *debounce* (save once editing pauses)
 *     keeps idle work cheap; a *maxWait* ceiling forces a checkpoint at least
 *     every `maxWaitMs` of CONTINUOUS activity so an impatient user who keeps
 *     dragging and then navigates away never loses more than one ceiling's worth
 *     of edits. The ceiling also caps our request rate: continuous editing emits
 *     at most one save per `maxWaitMs`, which is what keeps us under the API's
 *     per-IP rate limit instead of melting it down into a 429 storm.
 *
 *  2. `computeBackoffMs` — exponential backoff WITH jitter for retrying a failed
 *     save (429 / network blip). Honors a server `Retry-After` when present
 *     (it's more precise than anything we'd guess); otherwise grows 1s→2s→4s…
 *     with a random component so concurrent clients don't resynchronise into a
 *     fresh burst. This is the half that stops the storm from re-arming itself.
 */

export interface AutosaveScheduler {
  /** Note a change; (re)arm the debounce, and the ceiling if not already armed. */
  schedule(): void;
  /** Fire now (e.g. teardown) and clear both timers. */
  flushNow(): void;
  /** Drop any pending save without firing (component unmount). */
  cancel(): void;
}

export function createAutosaveScheduler(
  flush: () => void,
  opts: { debounceMs: number; maxWaitMs: number },
): AutosaveScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;

  const clearAll = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  };

  const fire = () => {
    clearAll();
    flush();
  };

  return {
    schedule() {
      // Debounce: every change pushes the idle-save back out…
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fire, opts.debounceMs);
      // …but the ceiling, armed once when the first dirty edit lands and NOT
      // reset by later edits, guarantees we still flush mid-burst.
      if (!maxWaitTimer) maxWaitTimer = setTimeout(fire, opts.maxWaitMs);
    },
    flushNow: fire,
    cancel: clearAll,
  };
}

export const BASE_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 10_000;

/**
 * Backoff delay (ms) before retrying save attempt `attempt` (0-based).
 *
 * `retryAfter` is the raw `Retry-After` response header (seconds form only,
 * which is what our Fastify limiter emits). `rand` is injectable for tests.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfter?: string | null,
  rand: () => number = Math.random,
): number {
  if (retryAfter != null && retryAfter !== '') {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, MAX_BACKOFF_MS);
    }
  }
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Equal jitter: wait 50–100% of the window. Enough randomness to desync
  // concurrent clients without ever dropping to a near-zero (hammering) wait.
  return Math.round(base * (0.5 + 0.5 * rand()));
}
