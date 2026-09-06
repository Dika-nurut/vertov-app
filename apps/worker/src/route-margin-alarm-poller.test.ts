import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  MARGIN_ALARM_COOLDOWN_MS,
  evaluateRouteMarginAlarms,
  type AlarmClock,
  type MarginAlarmObservation,
} from './route-margin-alarm';
import { RedisAlarmStateStore, startRouteMarginAlarm } from './route-margin-alarm-poller';

const now = new Date('2026-08-08T12:00:00.000Z');
const LEG = 'seedream-4-5|1K|t2i|-|-|any|leg1';
const ENABLED_ENV = { ROUTE_MARGIN_ALARM_ENABLED: '1', TG_BOT_TOKEN: 'test', TG_CHAT_ID: '42' };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('route margin alarm schedule', () => {
  it('is off by default: an unflagged worker never evaluates the journal', async () => {
    const evaluate = vi.fn(async () => []);
    const log = fakeLog();

    const handle = startRouteMarginAlarm({
      log,
      redis: new FakeRedis() as unknown as Redis,
      env: {},
      evaluate,
      firstTickDelayMs: 1_000,
      intervalMs: 1_000,
      sendTelegramAlert: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(evaluate).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      'route-margin-alarm: not scheduled (ROUTE_MARGIN_ALARM_ENABLED is not 1)',
    );
    handle.stop();
  });

  it('refuses to schedule when the Telegram bot token or chat id is missing', async () => {
    const evaluate = vi.fn(async () => []);
    const log = fakeLog();

    const handle = startRouteMarginAlarm({
      log,
      redis: new FakeRedis() as unknown as Redis,
      env: { ROUTE_MARGIN_ALARM_ENABLED: '1', TG_BOT_TOKEN: 'test' },
      evaluate,
      firstTickDelayMs: 1_000,
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(evaluate).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'route-margin-alarm: not scheduled (TG_BOT_TOKEN / TG_CHAT_ID missing)',
    );
    handle.stop();
  });

  it('evaluates on its own timer once enabled, and keeps evaluating each interval', async () => {
    const evaluate = vi.fn(async () => []);

    const handle = startRouteMarginAlarm({
      log: fakeLog(),
      redis: new FakeRedis() as unknown as Redis,
      env: ENABLED_ENV,
      evaluate,
      firstTickDelayMs: 60_000,
      intervalMs: 60_000,
      sendTelegramAlert: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(59_000);
    expect(evaluate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(evaluate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(evaluate).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing Telegram transport so a job-carrying worker never sees it', async () => {
    const log = fakeLog();
    const handle = startRouteMarginAlarm({
      log,
      redis: new FakeRedis() as unknown as Redis,
      env: ENABLED_ENV,
      clock: fixedClock(now),
      evaluate: (input) => evaluateRouteMarginAlarms({ observations: breachingRows(), ...input }),
      sendTelegramAlert: async () => {
        throw new Error('telegram sendMessage failed: HTTP 502');
      },
      firstTickDelayMs: 1_000,
      intervalMs: 1_000,
    });

    await expect(handle.tick()).resolves.toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      { error: expect.objectContaining({ message: 'telegram sendMessage failed: HTTP 502' }) },
      'route-margin-alarm: tick failed',
    );

    handle.stop();
  });

  it('sends one message per window no matter how many replicas run the timer', async () => {
    const redis = new FakeRedis();
    const delivered: string[] = [];
    const replica = (id: string) =>
      startRouteMarginAlarm({
        log: fakeLog(),
        redis: redis as unknown as Redis,
        env: ENABLED_ENV,
        clock: fixedClock(now),
        evaluate: (input) => evaluateRouteMarginAlarms({ observations: breachingRows(), ...input }),
        sendTelegramAlert: async (message) => {
          delivered.push(`${id}:${message}`);
        },
        firstTickDelayMs: 10 * 60_000,
        intervalMs: 10 * 60_000,
      });
    const first = replica('a');
    const second = replica('b');

    // Same window: the loser of the leader key does not even read the journal.
    expect(await first.tick()).toHaveLength(2);
    expect(await second.tick()).toEqual([]);
    expect(delivered.map((entry) => entry.split(':')[0])).toEqual(['a', 'a']);

    // Next window, and this time the other replica wins the leader key: the
    // shared cooldown state — not the leader key — is what suppresses the repeat.
    redis.del('seed:route-margin-alarm:leader');
    expect(await second.tick()).toEqual([]);
    expect(delivered).toHaveLength(2);

    first.stop();
    second.stop();
  });
});

describe('a tick that never settles', () => {
  it('does not stop the replica polling — the deadline ends it as a caught error', async () => {
    const redis = new FakeRedis();
    const log = fakeLog();
    // Telegram accepts the connection and never answers. `tick()` not REJECTING is not
    // enough: the loop awaits it, so a promise that never settles takes this replica
    // out of service permanently, and the next leader inherits the same hang.
    const hang = vi.fn(() => new Promise<[]>(() => {}));

    const handle = startRouteMarginAlarm({
      log,
      redis: redis as unknown as Redis,
      env: ENABLED_ENV,
      evaluate: hang as never,
      firstTickDelayMs: 0,
      intervalMs: 60_000,
      tickDeadlineMs: 5_000,
      sendTelegramAlert: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(200_000);
    // Three windows in, it is still polling rather than wedged on the first one.
    expect(hang.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'route-margin-alarm: tick failed',
    );
    handle.stop();
  });
});

describe('the configured interval', () => {
  it('falls back to hourly when the deploy variable is not a millisecond count', async () => {
    const redis = new FakeRedis();
    const evaluate = vi.fn(async () => []);
    const log = fakeLog();

    // `Number('1h')` is NaN, and NaN reaches setTimeout (fires at once) and the
    // leader key's TTL (a rejected SET, caught, retried at once). Unguarded, one
    // typo in a deploy variable turns an hourly alarm into a Redis hot loop.
    const handle = startRouteMarginAlarm({
      log,
      redis: redis as unknown as Redis,
      env: { ...ENABLED_ENV, ROUTE_MARGIN_ALARM_INTERVAL_MS: '1h' },
      evaluate,
      firstTickDelayMs: 0,
      sendTelegramAlert: async () => undefined,
    });

    await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
    // Ninety minutes at the hourly fallback is two ticks, not thousands.
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(
      { raw: '1h', usingMs: 60 * 60 * 1000 },
      'route-margin-alarm: ROUTE_MARGIN_ALARM_INTERVAL_MS is not a millisecond count >= 1000',
    );
    handle.stop();
  });
});

describe('shared alarm cooldown state', () => {
  it('survives the replica that wrote it and expires with the cooldown', async () => {
    const redis = new FakeRedis();
    const writer = new RedisAlarmStateStore(redis as unknown as Redis);
    const reader = new RedisAlarmStateStore(redis as unknown as Redis);

    vi.setSystemTime(now);
    await writer.write('drift:leg|1K', { lastAlertAt: now.toISOString() });
    expect(await reader.read('drift:leg|1K')).toEqual({ lastAlertAt: now.toISOString() });

    vi.setSystemTime(new Date(now.getTime() + MARGIN_ALARM_COOLDOWN_MS + 1));
    expect(await reader.read('drift:leg|1K')).toBeNull();
  });
});

function fixedClock(value: Date): AlarmClock {
  return { now: () => value };
}

function fakeLog(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/** Five invoiced rows at 160₽ vendor cost against 100₽ configured and 100₽ revenue. */
function breachingRows(): MarginAlarmObservation[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `attempt-${index}`,
    legIdentity: LEG,
    rung: '1K',
    role: 'primary' as const,
    submittedAt: new Date(now.getTime() - index * 60_000),
    configuredExpectedCostRub: 100,
    vendorReportedCostRub: 160,
    revenueRub: 100,
    costSource: 'invoiced',
  }));
}

/** Just enough ioredis for `SET key value PX ttl [NX]` + `GET key`. */
class FakeRedis {
  private readonly values = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.values.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(
    key: string,
    value: string,
    _px: 'PX',
    ttlMs: number,
    mode?: 'NX',
  ): Promise<'OK' | null> {
    if (mode === 'NX' && (await this.get(key)) !== null) return null;
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
    return 'OK';
  }

  /** Simulates the leader key expiring so a different replica wins the next window. */
  del(key: string): void {
    this.values.delete(key);
  }
}
