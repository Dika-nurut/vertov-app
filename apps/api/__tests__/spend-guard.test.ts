import 'dotenv/config';
import IORedis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { currentDailySpend, releaseDailyBudget, reserveDailyBudget } from '../src/spend-guard';

// Fixed far-future day bucket so the test never collides with real spend keys.
const day = new Date('2031-01-02T00:00:00Z');
const key = 'seed:spend:daily:2031-01-02';
const redis = new IORedis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', {
  maxRetriesPerRequest: null,
});

beforeEach(async () => {
  await redis.del(key);
});
afterAll(async () => {
  await redis.del(key);
  await redis.quit();
});

describe('M1: reserveDailyBudget is atomic against the daily cap', () => {
  it('allows up to the cap and rejects what would exceed it', async () => {
    expect((await reserveDailyBudget(redis, 60, 100, day)).allowed).toBe(true);
    expect((await reserveDailyBudget(redis, 50, 100, day)).allowed).toBe(false); // 60+50 > 100
    expect((await reserveDailyBudget(redis, 40, 100, day)).allowed).toBe(true); // 60+40 = 100
    expect(await currentDailySpend(redis, day)).toBe(100);
  });

  it('concurrent reservations never overshoot the cap (the TOCTOU fix)', async () => {
    const cap = 100;
    const cost = 10;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => reserveDailyBudget(redis, cost, cap, day)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(10); // exactly cap/cost — not 50
    expect(await currentDailySpend(redis, day)).toBe(100); // counter never exceeds the cap
  });

  it('release gives the reserved budget back', async () => {
    await reserveDailyBudget(redis, 80, 100, day);
    await releaseDailyBudget(redis, 80, day);
    expect(await currentDailySpend(redis, day)).toBe(0);
    expect((await reserveDailyBudget(redis, 90, 100, day)).allowed).toBe(true);
  });

  it('cap <= 0 disables the gate (always allowed, no counting)', async () => {
    expect((await reserveDailyBudget(redis, 1000, 0, day)).allowed).toBe(true);
    expect(await currentDailySpend(redis, day)).toBe(0);
  });
});
