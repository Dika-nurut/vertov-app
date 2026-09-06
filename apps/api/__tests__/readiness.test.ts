import { describe, expect, it, vi } from 'vitest';
import { boundedReadinessProbe } from '../src/readiness';

describe('bounded readiness probes', () => {
  it('reports success and ordinary rejection', async () => {
    await expect(boundedReadinessProbe(async () => 'pong', 20)).resolves.toBe(true);
    await expect(
      boundedReadinessProbe(async () => {
        throw new Error('down');
      }, 20),
    ).resolves.toBe(false);
  });

  it('fails a dependency that retries forever within the deadline', async () => {
    vi.useFakeTimers();
    const result = boundedReadinessProbe(() => new Promise(() => {}), 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toBe(false);
    vi.useRealTimers();
  });
});
