import { describe, expect, it, vi } from 'vitest';
import type IORedis from 'ioredis';
import { checkRateLimit, isRateLimitExempt } from '../src/rate-limit';

/**
 * SF-6 — the prior per-user limiter did `INCR` then a separate `EXPIRE`; a crash
 * between the two left a key with no TTL, permanently locking the user out, and
 * the non-atomic window allowed a burst. `checkRateLimit` runs a single Lua
 * `INCR` + `PEXPIRE`-on-first, so the TTL is set in the same atomic step.
 */
function makeEvalStub() {
  const store = new Map<string, number>();
  const evalFn = vi.fn(async (_script: string, _numKeys: number, key: string) => {
    const next = (store.get(key) ?? 0) + 1;
    store.set(key, next);
    return next;
  });
  return { redis: { eval: evalFn } as unknown as IORedis, evalFn };
}

describe('SF-6: checkRateLimit (atomic fixed window)', () => {
  it('allows up to max then blocks, with correct remaining', async () => {
    const { redis } = makeEvalStub();
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkRateLimit(redis, 'k', 3, 60));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]!.count).toBe(4);
  });

  it('sets the TTL in the SAME eval call (no separate EXPIRE to crash between)', async () => {
    const { redis, evalFn } = makeEvalStub();
    await checkRateLimit(redis, 'k', 10, 30);
    // One round-trip; the Lua script carries both INCR and PEXPIRE.
    expect(evalFn).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, ms] = evalFn.mock.calls[0]!;
    expect(numKeys).toBe(1);
    expect(key).toBe('k');
    expect(String(script)).toContain('PEXPIRE');
    expect(ms).toBe('30000'); // windowSeconds → ms
  });

  it('keys are independent', async () => {
    const { redis } = makeEvalStub();
    await checkRateLimit(redis, 'a', 1, 60);
    const a2 = await checkRateLimit(redis, 'a', 1, 60);
    const b1 = await checkRateLimit(redis, 'b', 1, 60);
    expect(a2.allowed).toBe(false);
    expect(b1.allowed).toBe(true);
  });
});

describe('INF-16/18: ops probes are exempt from the global rate limit', () => {
  it('exempts /health and /ready (incl. with query strings)', () => {
    expect(isRateLimitExempt('/health')).toBe(true);
    expect(isRateLimitExempt('/ready')).toBe(true);
    expect(isRateLimitExempt('/ready?verbose=1')).toBe(true);
  });

  it('does NOT exempt real API routes', () => {
    expect(isRateLimitExempt('/v1/jobs')).toBe(false);
    expect(isRateLimitExempt('/v1/showcase')).toBe(false);
    expect(isRateLimitExempt('/healthcheck-imposter')).toBe(false);
  });
});
