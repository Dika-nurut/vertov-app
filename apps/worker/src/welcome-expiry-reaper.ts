import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { db } from '@seed/db';
import { WelcomeGrantService } from '@seed/credits';
import { welcomeL0ExpiredTotal } from './metrics';

/**
 * Free-token welcome program — L0 72h expiry reaper.
 *
 * L0 tokens expire 72h after grant if unspent. This periodic sweep finds L0
 * grants past the window that have not yet been clawed back and writes ONE
 * idempotent negative `available` leg per user (`welcome-expire:{userId}:L0`),
 * reclaiming only the UNSPENT remainder — see WelcomeGrantService.expireL0ForUser
 * for the exact clawback semantics.
 *
 * Follows the same shape as subscription-cycle / reaper: a plain interval loop
 * with Redis leader election (SET NX PX) so N worker instances don't double-sweep.
 */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly — 72h window has slack
const LEADER_KEY = 'seed:welcome-expiry:leader';

const welcome = new WelcomeGrantService();

export interface WelcomeExpiryOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  /** First tick after this many ms (so tests can fire immediately). */
  firstTickDelayMs?: number;
  batchSize?: number;
}

export interface WelcomeExpiryHandle {
  stop(): void;
  tick(): Promise<{ processed: number; clawedBack: number }>;
}

export function startWelcomeExpiryReaper(opts: WelcomeExpiryOptions): WelcomeExpiryHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.WELCOME_EXPIRY_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const batchSize = opts.batchSize ?? Number(process.env.WELCOME_EXPIRY_BATCH_SIZE ?? 200);
  const firstDelay = opts.firstTickDelayMs ?? 5_000;
  const instanceId = randomUUID();
  let stopped = false;

  async function tick(): Promise<{ processed: number; clawedBack: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') {
      opts.log.debug({ instanceId }, 'welcome-expiry: skipping tick (not leader)');
      return { processed: 0, clawedBack: 0 };
    }

    const due = await welcome.findExpirableL0(batchSize, db);
    let processed = 0;
    let clawedBack = 0;
    for (const row of due) {
      const res = await db.transaction((tx) => welcome.expireL0ForUser(row.userId, tx));
      if (res && !res.alreadyDone) {
        processed++;
        clawedBack += res.clawedBack;
      }
    }

    if (processed > 0) {
      welcomeL0ExpiredTotal.labels('users').inc(processed);
      welcomeL0ExpiredTotal.labels('tokens').inc(clawedBack);
      opts.log.info({ processed, clawedBack, instanceId }, 'welcome-expiry: tick complete');
    }
    return { processed, clawedBack };
  }

  async function loop(): Promise<void> {
    await new Promise((r) => setTimeout(r, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'welcome-expiry: tick failed');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, instanceId }, 'welcome-expiry reaper started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
