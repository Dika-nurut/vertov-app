import type IORedis from 'ioredis';

/**
 * BL-1 — platform-wide spend ceiling + kill-switch.
 *
 * Per-job credit reservation is the only thing gating provider spend today; a
 * pricing/grant bug or coordinated abuse could run unbounded real spend. This
 * adds two fail-closed controls in front of `POST /v1/jobs`:
 *  - a hard KILL-SWITCH env that refuses ALL new generation immediately, and
 *  - a rolling DAILY credit-cost ceiling (Redis counter) that refuses new jobs
 *    once the platform's daily generation cost would exceed the cap.
 * Both short-circuit BEFORE any credit reservation or provider enqueue.
 */

/** True when generation is hard-disabled via `GENERATION_KILL_SWITCH`. */
export function generationKilled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.GENERATION_KILL_SWITCH ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** The daily platform spend ceiling in credits (`DAILY_SPEND_CAP_CREDITS`); 0 = disabled. */
export function dailySpendCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DAILY_SPEND_CAP_CREDITS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The scene-object extraction sub-ceiling. There is intentionally no default:
 * the free-to-user route fails closed until an operator explicitly chooses a
 * smaller cap than the platform-wide generation ceiling.
 */
export function sceneObjectsDailySpendCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SCENE_OBJECTS_DAILY_SPEND_CAP_CREDITS ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** UTC day-bucket key so the ceiling resets at midnight UTC. */
function dailyKey(now: Date, bucket = 'generation'): string {
  const day = now.toISOString().slice(0, 10);
  return bucket === 'generation' ? `seed:spend:daily:${day}` : `seed:spend:daily:${bucket}:${day}`;
}

/**
 * Would accepting a `cost`-credit job keep the platform under the daily cap?
 * Read-only (no increment) so a rejected/erroring job never consumes budget —
 * `recordSpend` is called only after a job is actually reserved.
 */
export async function checkDailyBudget(
  redis: IORedis,
  cost: number,
  cap: number,
  now: Date = new Date(),
  bucket = 'generation',
): Promise<{ allowed: boolean; current: number; cap: number }> {
  if (cap <= 0) return { allowed: true, current: 0, cap };
  const current = Number(await redis.get(dailyKey(now, bucket))) || 0;
  return { allowed: current + cost <= cap, current, cap };
}

/**
 * Today's platform spend so far (credits). Read-only — used by the metrics
 * surface (INF-17) to gauge spend vs. cap for the daily-spend-approach alert.
 */
export async function currentDailySpend(
  redis: IORedis,
  now: Date = new Date(),
  bucket = 'generation',
): Promise<number> {
  return Number(await redis.get(dailyKey(now, bucket))) || 0;
}

/** Add an accepted job's credit cost to today's platform spend counter. */
export async function recordSpend(
  redis: IORedis,
  cost: number,
  now: Date = new Date(),
  bucket = 'generation',
): Promise<void> {
  if (cost <= 0) return;
  const key = dailyKey(now, bucket);
  const total = await redis.incrby(key, cost);
  // Set a 48h TTL once, on the first write of the day, so stale buckets expire.
  if (total === cost) await redis.expire(key, 48 * 60 * 60);
}

// M1: atomic reserve. GET+compare+INCRBY in one Lua script runs atomically in
// Redis, closing the TOCTOU where N concurrent jobs each pass a read-only check
// and collectively overshoot the cap. Returns the new total, or -1 (no increment)
// when accepting the job would exceed the cap.
const RESERVE_DAILY_BUDGET = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if cur + cost > cap then return -1 end
local total = redis.call('INCRBY', KEYS[1], cost)
if total == cost then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3])) end
return total
`;

/**
 * Atomically reserve `cost` against the daily cap. Unlike `checkDailyBudget`
 * (read-only), this increments the counter in the same critical section as the
 * check, so concurrent callers can't overshoot. Release with `releaseDailyBudget`
 * if the job is ultimately NOT created.
 */
export async function reserveDailyBudget(
  redis: IORedis,
  cost: number,
  cap: number,
  now: Date = new Date(),
  bucket = 'generation',
): Promise<{ allowed: boolean; current: number; cap: number }> {
  if (cap <= 0) return { allowed: true, current: 0, cap };
  if (cost <= 0) {
    return { allowed: true, current: await currentDailySpend(redis, now, bucket), cap };
  }
  const res = Number(
    await redis.eval(
      RESERVE_DAILY_BUDGET,
      1,
      dailyKey(now, bucket),
      String(cost),
      String(cap),
      String(48 * 60 * 60),
    ),
  );
  if (res === -1) {
    return { allowed: false, current: await currentDailySpend(redis, now, bucket), cap };
  }
  return { allowed: true, current: res - cost, cap };
}

/** Give back budget reserved by `reserveDailyBudget` when the job isn't created. */
export async function releaseDailyBudget(
  redis: IORedis,
  cost: number,
  now: Date = new Date(),
  bucket = 'generation',
): Promise<void> {
  if (cost <= 0) return;
  await redis.decrby(dailyKey(now, bucket), cost);
}
