import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  computeBackoffMs,
  createAutosaveScheduler,
} from './autosave';

describe('createAutosaveScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a burst into ONE save once editing pauses', () => {
    const flush = vi.fn();
    const s = createAutosaveScheduler(flush, { debounceMs: 900, maxWaitMs: 4000 });

    // five rapid edits, each 100ms apart — well inside the debounce window
    for (let i = 0; i < 5; i++) {
      s.schedule();
      vi.advanceTimersByTime(100);
    }
    expect(flush).not.toHaveBeenCalled(); // still coalescing

    vi.advanceTimersByTime(900); // editing paused → idle save
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('honors the maxWait ceiling during CONTINUOUS editing (no data loss + rate cap)', () => {
    const flush = vi.fn();
    const s = createAutosaveScheduler(flush, { debounceMs: 900, maxWaitMs: 4000 });

    // Edit every 300ms forever — the debounce alone would NEVER fire. The
    // ceiling must force a checkpoint at 4000ms regardless.
    for (let t = 0; t < 4000; t += 300) {
      s.schedule();
      vi.advanceTimersByTime(300);
    }
    expect(flush).toHaveBeenCalledTimes(1); // checkpoint at the ceiling
  });

  it('caps the sustained-editing save rate to ~one per ceiling', () => {
    const flush = vi.fn();
    const s = createAutosaveScheduler(flush, { debounceMs: 900, maxWaitMs: 4000 });

    // 12s of nonstop editing every 200ms
    for (let t = 0; t < 12_000; t += 200) {
      s.schedule();
      vi.advanceTimersByTime(200);
    }
    // 12s / 4s ceiling ≈ 3 forced checkpoints — NOT 60 saves.
    expect(flush.mock.calls.length).toBeLessThanOrEqual(3);
    expect(flush.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('flushNow fires immediately and clears pending timers', () => {
    const flush = vi.fn();
    const s = createAutosaveScheduler(flush, { debounceMs: 900, maxWaitMs: 4000 });
    s.schedule();
    s.flushNow();
    expect(flush).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(flush).toHaveBeenCalledTimes(1); // no stray double-fire
  });

  it('cancel drops a pending save without firing', () => {
    const flush = vi.fn();
    const s = createAutosaveScheduler(flush, { debounceMs: 900, maxWaitMs: 4000 });
    s.schedule();
    s.cancel();
    vi.advanceTimersByTime(5000);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially across attempts', () => {
    // rand fixed at 0 → returns exactly 50% of the window, so growth is visible.
    const r = () => 0;
    expect(computeBackoffMs(0, null, r)).toBe(BASE_BACKOFF_MS / 2); // 500
    expect(computeBackoffMs(1, null, r)).toBe(BASE_BACKOFF_MS); // 1000
    expect(computeBackoffMs(2, null, r)).toBe(BASE_BACKOFF_MS * 2); // 2000
  });

  it('caps at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(20, null, () => 1)).toBe(MAX_BACKOFF_MS);
  });

  it('keeps jitter within the 50–100% band', () => {
    for (const rand of [0, 0.37, 0.99, 1]) {
      const ms = computeBackoffMs(2, null, () => rand); // base 4000
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(4000);
    }
  });

  it('honors a numeric Retry-After header over computed backoff', () => {
    expect(computeBackoffMs(0, '3')).toBe(3000);
  });

  it('caps Retry-After at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(0, '999')).toBe(MAX_BACKOFF_MS);
  });

  it('falls back to computed backoff for a malformed Retry-After', () => {
    expect(computeBackoffMs(0, 'soon', () => 0)).toBe(BASE_BACKOFF_MS / 2);
  });
});
