import { describe, expect, it, vi } from 'vitest';
import { checkSlidingWindowRateLimit } from './rate-limit';

describe('sliding-window rate limit', () => {
  it('reports remaining capacity and server retry time from the atomic result', async () => {
    const evalMock = vi.fn().mockResolvedValueOnce([3, 0]).mockResolvedValueOnce([120, 12]);
    const redis = { eval: evalMock } as never;
    await expect(
      checkSlidingWindowRateLimit(redis, 'board:user', 120, 300, 1_000),
    ).resolves.toEqual({
      allowed: true,
      count: 3,
      remaining: 117,
      retryAfterSeconds: 0,
    });
    await expect(
      checkSlidingWindowRateLimit(redis, 'board:user', 120, 300, 2_000),
    ).resolves.toEqual({
      allowed: false,
      count: 120,
      remaining: 0,
      retryAfterSeconds: 12,
    });
    expect(evalMock).toHaveBeenCalledTimes(2);
  });
});
