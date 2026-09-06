import { describe, expect, it, vi } from 'vitest';
import { drainWorkers, type ClosableWorker } from './shutdown';

// A fake BullMQ worker whose close() resolves after `gracefulMs`, unless forced.
function fakeWorker(name: string, gracefulMs: number): ClosableWorker & { closedForce: boolean } {
  const w = {
    name,
    closedForce: false,
    close(force?: boolean): Promise<void> {
      if (force) {
        w.closedForce = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => setTimeout(resolve, gracefulMs));
    },
  };
  return w;
}

describe('drainWorkers (INF-12 graceful drain)', () => {
  it('waits for in-flight jobs when they finish within the deadline', async () => {
    vi.useFakeTimers();
    const w = fakeWorker('jobs', 50);
    const p = drainWorkers([w], 1000);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toBe('drained');
    expect(w.closedForce).toBe(false);
    vi.useRealTimers();
  });

  it('force-closes when a worker (long render) exceeds the deadline', async () => {
    vi.useFakeTimers();
    const slow = fakeWorker('studio.render', 10_000);
    const warn = vi.fn();
    const p = drainWorkers([slow], 1000, { warn });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('forced');
    expect(slow.closedForce).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('no-ops cleanly with no workers', async () => {
    expect(await drainWorkers([], 1000)).toBe('drained');
  });
});
