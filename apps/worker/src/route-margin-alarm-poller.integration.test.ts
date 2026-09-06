import { afterAll, afterEach, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import pino from 'pino';
import { eq, like } from 'drizzle-orm';
import { db, nid, pool, routeAttemptJournal } from '@seed/db';
import { startRouteMarginAlarm } from './route-margin-alarm-poller';

/**
 * The alarm's execution path, end to end: the worker's own timer fires, the
 * evaluator reads the real route attempt journal, and a Telegram message
 * reaches the transport. Only the outbound HTTP call is stubbed — the schedule,
 * the leader key, the Redis cooldown store, the journal query and the evaluator
 * are all the production ones.
 */
const LEG = 'seedream-4-5|1K|t2i|-|-|any|it-margin-alarm';
const JOB_PREFIX = 'it-marginalarm-';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

// Pinned in the past so this spec grades only its own rows: anything another
// integration file leaves behind carries a wall-clock timestamp, which is in
// the FUTURE relative to this clock and is excluded by the 24h window.
const ALARM_NOW = new Date('2026-08-08T12:00:00.000Z');
const log = pino({ level: 'silent' });
const redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

afterEach(async () => {
  await db.delete(routeAttemptJournal).where(like(routeAttemptJournal.jobId, `${JOB_PREFIX}%`));
  const keys = await redis.keys('seed:route-margin-alarm:*');
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

describe('route margin alarm running inside the worker', () => {
  it('fires on its own schedule and delivers both alarms for a losing leg', async () => {
    await seedInvoicedAttempts({ vendorCostRub: 160, configuredCostRub: 100, revenueRub: 100 });
    const delivered: string[] = [];
    const firstDelivery = deferred<void>();

    const alarm = startRouteMarginAlarm({
      log,
      redis,
      env: { ROUTE_MARGIN_ALARM_ENABLED: '1', TG_BOT_TOKEN: 'test', TG_CHAT_ID: '42' },
      clock: { now: () => ALARM_NOW },
      // No tick() call anywhere in this spec: the worker's own timer is what
      // must produce the message, exactly as it would in production.
      firstTickDelayMs: 25,
      intervalMs: 60_000,
      sendTelegramAlert: async (message) => {
        delivered.push(message);
        if (delivered.length === 2) firstDelivery.resolve();
      },
    });

    await withDeadline(firstDelivery.promise, 20_000, 'no Telegram message within 20s');
    alarm.stop();

    const ours = delivered.filter((message) => message.includes(LEG));
    expect(ours).toEqual([
      `⚠️ route drift leg=${LEG} rung=1K invoice_breaches=5/5 ratio=1.00`,
      `🛑 route margin-floor leg=${LEG} rung=1K invoice_breaches=5/5 ratio=1.00`,
    ]);

    // The cooldown the evaluator wrote is in Redis, not in this process — that
    // is what stops a second replica repeating the message next window.
    const cooldown = await redis.get(`seed:route-margin-alarm:state:margin-floor:${LEG}|1K`);
    expect(cooldown).toContain(ALARM_NOW.toISOString());
  });

  it('stays silent for a healthy leg whose invoices match the configured cost', async () => {
    await seedInvoicedAttempts({ vendorCostRub: 100, configuredCostRub: 100, revenueRub: 400 });
    const delivered: string[] = [];

    const alarm = startRouteMarginAlarm({
      log,
      redis,
      env: { ROUTE_MARGIN_ALARM_ENABLED: '1', TG_BOT_TOKEN: 'test', TG_CHAT_ID: '42' },
      clock: { now: () => ALARM_NOW },
      firstTickDelayMs: 25,
      intervalMs: 60_000,
      sendTelegramAlert: async (message) => {
        delivered.push(message);
      },
    });

    await sleep(2_000);
    alarm.stop();

    expect(delivered.filter((message) => message.includes(LEG))).toEqual([]);
  });
});

async function seedInvoicedAttempts(costs: {
  vendorCostRub: number;
  configuredCostRub: number;
  revenueRub: number;
}): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await db.insert(routeAttemptJournal).values({
      id: nid(),
      jobId: `${JOB_PREFIX}${nid()}`,
      attemptSeq: 1,
      modelId: 'seedream-4-5',
      rung: '1K',
      role: 'primary',
      legIdentity: LEG,
      gateway: 'kie',
      outcome: 'succeeded',
      units: '1.0000',
      configuredExpectedCostRub: costs.configuredCostRub.toFixed(4),
      vendorReportedCostRub: costs.vendorCostRub.toFixed(4),
      revenueRub: costs.revenueRub.toFixed(4),
      costSource: 'invoiced',
      submittedAt: new Date(ALARM_NOW.getTime() - (index + 1) * 60_000),
      resolvedAt: new Date(ALARM_NOW.getTime() - index * 60_000),
    });
  }
  const seeded = await db
    .select({ id: routeAttemptJournal.id })
    .from(routeAttemptJournal)
    .where(eq(routeAttemptJournal.legIdentity, LEG));
  expect(seeded).toHaveLength(5);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
