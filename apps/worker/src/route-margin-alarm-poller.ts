import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  MARGIN_ALARM_COOLDOWN_MS,
  TelegramMarginAlarmNotifier,
  evaluatePersistedRouteMarginAlarms,
  systemClock,
  type AlarmClock,
  type AlarmStateStore,
  type MarginAlarmEvent,
} from './route-margin-alarm';

/**
 * Scheduled caller for the route margin alarms. Without this the evaluator is
 * library code nothing runs.
 *
 * Same shape as the reapers (`project-trash-reaper`, `gallery-reaper`): a first
 * delayed tick, then a fixed interval, with the tick body guarded by a Redis
 * `SET NX PX` leader key.
 *
 * The leader key thins concurrent evaluation; it does not serialise it. Its TTL is
 * 0.8 of the interval and replicas are not phase-aligned, so a replica starting 49
 * minutes after another will find the key expired and evaluate too. The dedup that
 * actually holds is the shared cooldown state, and the alarm is deliberately built to
 * fail toward a DUPLICATE message rather than a missed one: the state is written
 * AFTER delivery, so a crash between the two repeats an alert instead of silencing a
 * real margin breach for six hours. For a money alarm that is the right direction.
 *
 * Hourly is deliberate: the evaluator's own window is 24h and its per-alarm
 * cooldown 6h, so a faster poll cannot produce a faster (or louder) alert — it
 * would only re-scan the journal for nothing.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_FIRST_TICK_DELAY_MS = 120_000;
const DEFAULT_TICK_DEADLINE_MS = 5 * 60 * 1000;
const LEADER_KEY = 'seed:route-margin-alarm:leader';
const STATE_KEY_PREFIX = 'seed:route-margin-alarm:state:';

export type TelegramTransport = (message: string) => Promise<void>;

/**
 * Cooldown/dedup state shared by every replica.
 *
 * The leader key alone is not enough: it expires each window, so the next
 * window's leader can be a different replica, and a per-process (or per-
 * container-filesystem) store would have no memory of the alert the previous
 * leader already sent. Keeping the state in Redis makes the 6h cooldown a
 * property of the deployment rather than of one container. The TTL matches the
 * cooldown — an expired key and a key older than the cooldown mean the same
 * thing to the evaluator.
 */
export class RedisAlarmStateStore implements AlarmStateStore {
  constructor(private readonly redis: Redis) {}

  async read(key: string): Promise<{ lastAlertAt: string } | null> {
    const raw = await this.redis.get(`${STATE_KEY_PREFIX}${key}`);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const lastAlertAt = (parsed as { lastAlertAt?: unknown } | null)?.lastAlertAt;
      return typeof lastAlertAt === 'string' ? { lastAlertAt } : null;
    } catch {
      return null;
    }
  }

  async write(key: string, value: { lastAlertAt: string }): Promise<void> {
    await this.redis.set(
      `${STATE_KEY_PREFIX}${key}`,
      JSON.stringify(value),
      'PX',
      MARGIN_ALARM_COOLDOWN_MS,
    );
  }
}

export interface RouteMarginAlarmOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  firstTickDelayMs?: number;
  /** Hard ceiling on one evaluation, so a stalled await cannot silence the alarm. */
  tickDeadlineMs?: number;
  clock?: AlarmClock;
  state?: AlarmStateStore;
  /** Delivery seam. Stubbed by tests so no test can reach the real Bot API. */
  sendTelegramAlert?: TelegramTransport;
  /** Evaluator seam, so the schedule can be proven without a database. */
  evaluate?: typeof evaluatePersistedRouteMarginAlarms;
  /** Defaults to `process.env`; tests pass an explicit environment. */
  env?: NodeJS.ProcessEnv;
}

export interface RouteMarginAlarmHandle {
  stop(): void;
  /**
   * Never rejects. The alarm shares a process with generation and render jobs;
   * a broken journal query or a Telegram outage must not surface as a failed
   * job, so every failure ends as a log line and an empty result.
   */
  tick(): Promise<MarginAlarmEvent[]>;
}

const NOT_SCHEDULED: RouteMarginAlarmHandle = {
  stop() {},
  tick: () => Promise.resolve([]),
};

/**
 * One-line delivery to @dika_alerts_bot, the same chat `infra/monitor/alert.js`
 * posts to. The monitor's poll/confirmation/dedup machinery is deliberately not
 * duplicated here — the evaluator already owns the window, the breach ratio and
 * the cooldown, so all this seam owes it is a message on the wire.
 *
 * The timeout is not optional. `tick()` never REJECTS, but the loop awaits it, so a
 * request that never SETTLES stops that replica polling forever — and once the leader
 * key expires the next replica takes the same hang, until no replica evaluates at all.
 * An unanswered socket must end as a caught error, not as silence.
 */
const TELEGRAM_TIMEOUT_MS = 15_000;

function telegramTransport(env: NodeJS.ProcessEnv): TelegramTransport | null {
  const token = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return null;
  const base = env.TG_API_BASE_URL ?? 'https://api.telegram.org';
  return async (message: string) => {
    const response = await fetch(`${base}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`telegram sendMessage failed: HTTP ${response.status}`);
  };
}

/**
 * A mistyped interval must not become a hot loop. `Number('1h')` is NaN, and NaN
 * flows straight through `setTimeout` (fires immediately) and through the leader
 * key's TTL (a rejected `SET`, caught, retried at once) — so the alarm would spin
 * on Redis forever on nothing worse than a typo in a deploy variable.
 */
function intervalFromEnv(env: NodeJS.ProcessEnv, log: Logger): number {
  const raw = env.ROUTE_MARGIN_ALARM_INTERVAL_MS;
  if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    log.warn(
      { raw, usingMs: DEFAULT_INTERVAL_MS },
      'route-margin-alarm: ROUTE_MARGIN_ALARM_INTERVAL_MS is not a millisecond count >= 1000',
    );
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`route margin alarm tick exceeded ${ms}ms`)), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export function startRouteMarginAlarm(opts: RouteMarginAlarmOptions): RouteMarginAlarmHandle {
  const env = opts.env ?? process.env;

  if (env.ROUTE_MARGIN_ALARM_ENABLED !== '1') {
    opts.log.info('route-margin-alarm: not scheduled (ROUTE_MARGIN_ALARM_ENABLED is not 1)');
    return NOT_SCHEDULED;
  }

  const send = opts.sendTelegramAlert ?? telegramTransport(env);
  if (!send) {
    opts.log.warn('route-margin-alarm: not scheduled (TG_BOT_TOKEN / TG_CHAT_ID missing)');
    return NOT_SCHEDULED;
  }

  const notifier = new TelegramMarginAlarmNotifier(send);
  const state = opts.state ?? new RedisAlarmStateStore(opts.redis);
  const clock = opts.clock ?? systemClock;
  const evaluate = opts.evaluate ?? evaluatePersistedRouteMarginAlarms;
  const intervalMs = opts.intervalMs ?? intervalFromEnv(env, opts.log);
  const firstDelay = opts.firstTickDelayMs ?? DEFAULT_FIRST_TICK_DELAY_MS;
  const instanceId = randomUUID();
  const tickDeadlineMs = opts.tickDeadlineMs ?? DEFAULT_TICK_DEADLINE_MS;
  let stopped = false;

  async function tick(): Promise<MarginAlarmEvent[]> {
    try {
      const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
      const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
      if (acquired !== 'OK') return [];
      // A tick that never settles is worse than one that fails: the loop awaits it, so
      // the replica stops polling entirely and the next one inherits the same hang.
      // The transport has its own timeout; this is the backstop for every other await
      // in the path (journal query, Redis, an injected transport in a test).
      const events = await withDeadline(
        evaluate({ state, notifier, clock }),
        Math.min(tickDeadlineMs, lockTtl),
      );
      if (events.length > 0) {
        opts.log.warn(
          { alarms: events.map((event) => event.key) },
          'route-margin-alarm: alerts delivered',
        );
      }
      return events;
    } catch (error) {
      opts.log.error({ error }, 'route-margin-alarm: tick failed');
      return [];
    }
  }

  async function loop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, firstDelay));
    while (!stopped) {
      await tick();
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, instanceId }, 'route-margin-alarm started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
