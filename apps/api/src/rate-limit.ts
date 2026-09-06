import type IORedis from 'ioredis';

/**
 * Atomic fixed-window rate-limit counter.
 *
 * `INCR` the key and set the TTL only on the first hit, in ONE Redis round-trip
 * (a Lua script runs atomically). This fixes the SF-6 class of bug — the
 * non-atomic `INCR` then `EXPIRE` could crash between the two calls and leave a
 * key with no TTL, permanently locking the bucket — and keeps a true fixed
 * window (later hits don't push the expiry out).
 */
const FIXED_WINDOW_LUA =
  "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; return c";

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
}

export interface SlidingWindowRateLimitResult extends RateLimitResult {
  /** Whole seconds until the oldest retained hit leaves the window. */
  retryAfterSeconds: number;
}

// Unlike a fixed bucket, this removes timestamps at the left edge before
// counting the current request. Blocked attempts are not inserted, so a
// caller that respects Retry-After can recover without extending its own
// penalty forever. The random suffix prevents two same-millisecond requests
// from replacing one another in the sorted set.
const SLIDING_WINDOW_LUA = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, member)
  count = count + 1
  redis.call('PEXPIRE', KEYS[1], window)
  return { count, 0 }
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = 1
if oldest[2] ~= nil then
  retry = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000))
end
redis.call('PEXPIRE', KEYS[1], window)
return { count, retry }
`;

/** Atomic per-key sliding-window limiter for bursty user actions. */
export async function checkSlidingWindowRateLimit(
  redis: IORedis,
  key: string,
  max: number,
  windowSeconds: number,
  nowMs = Date.now(),
): Promise<SlidingWindowRateLimitResult> {
  const windowMs = Math.max(1_000, Math.round(windowSeconds * 1_000));
  const raw = (await redis.eval(
    SLIDING_WINDOW_LUA,
    1,
    key,
    String(nowMs),
    String(windowMs),
    String(Math.max(1, Math.floor(max))),
    `${nowMs}-${Math.random().toString(36).slice(2)}`,
  )) as unknown;
  const values = Array.isArray(raw) ? raw : [raw, 0];
  const count = Number(values[0]) || 0;
  const retryAfterSeconds = Math.max(0, Number(values[1]) || 0);
  return {
    allowed: retryAfterSeconds === 0,
    count,
    remaining: Math.max(0, Math.floor(max) - count),
    retryAfterSeconds,
  };
}

/**
 * Ops liveness/readiness paths that must NEVER be rate-limited (INF-16/17/18): a
 * load balancer or uptime monitor polls these continuously, so a 429 would read
 * as "service down" and stall health-gated rollout. `/metrics` is on a separate
 * 127.0.0.1 listener, so only the app-served probes need exempting here.
 */
export function isRateLimitExempt(url: string): boolean {
  const path = url.split('?')[0];
  return path === '/health' || path === '/ready';
}

/**
 * Increment `key`'s counter within a `windowSeconds` fixed window and report
 * whether the caller is still under `max`. Fail-open is NOT used: callers must
 * treat a thrown Redis error as their policy decides (we let it propagate).
 */
export async function checkRateLimit(
  redis: IORedis,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const ms = String(Math.max(1, Math.round(windowSeconds * 1000)));
  const raw = await redis.eval(FIXED_WINDOW_LUA, 1, key, ms);
  const count = Number(raw);
  return { allowed: count <= max, count, remaining: Math.max(0, max - count) };
}
