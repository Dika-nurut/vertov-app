import { createHash } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import {
  creditTransactions,
  creditBuckets,
  db as defaultDb,
  freeClusters,
  freeGrantEvents,
  freePhoneAnchors,
  freeRegistrationWindows,
  jobs,
  nid,
  orders,
  usersApp,
} from '@seed/db';
import { CreditService, creditService as defaultCreditService } from './service';
import {
  FREE_COHORT_FREEZE,
  FREE_GRANTS_ENABLED,
  PHONE_BINDING_ENABLED,
  SMARTCAPTCHA_ENABLED,
  readBoolFlag,
} from './settings';
import { isDisposableEmail } from './disposable-email';

/**
 * Free-token welcome program — progressive-trust L0–L3 grant engine (Phase 1).
 *
 * Levels & unlocks (amounts are CONFIG — env-overridable, defaults below):
 *   L0 = 210  on registration, ANY method (email / OAuth / phone / anon-convert)
 *   L1 = +70  on the first qualified return: account age ≥18h AND ≥1 completed
 *             generation AND a new calendar day (UTC) after registration
 *   L2 = +100 on phone verification (one phone hash → one account's bonuses)
 *   L3 = +100 on the first successful paid order
 *
 * Idempotency: each level is a single `bonus_grant` ledger leg keyed
 * `welcome:{userId}:{level}` — the ledger's UNIQUE idempotency_key makes a
 * double-grant of any level structurally impossible. The (user_id, level) unique
 * index on free_grant_events is a second, independent guard against a concurrent
 * double-issue of the cluster event + counter.
 *
 * L0 EXPIRY: L0 tokens expire 72h after the grant if unspent. The reaper
 * (apps/worker) calls {@link expireL0ForUser}, which writes ONE negative
 * `available` leg keyed `welcome-expire:{userId}:L0`. It claws back only the
 * UNSPENT remainder of L0 — see the semantics comment on that method.
 *
 * Anti-farm: L0, L1, and daily grants count toward a rolling
 * {@link CLUSTER_TOKEN_CAP}-token-per-cluster-per-{@link CLUSTER_WINDOW_DAYS}-day
 * ceiling. The cookie is only a convenience signal: every L0 is also subject
 * to a server-observed /24 velocity bucket and a global registration bucket.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export type WelcomeLevel = 'L0' | 'L1' | 'L2' | 'L3';
export type DailyLevel = `DAILY:${string}`;

export const WELCOME_GRANT_AMOUNTS: Record<WelcomeLevel, number> = {
  L0: envInt('WELCOME_L0_TOKENS', 210),
  L1: envInt('WELCOME_L1_TOKENS', 70),
  L2: envInt('WELCOME_L2_TOKENS', 100),
  L3: envInt('WELCOME_L3_TOKENS', 100),
};

/** Hours after the L0 grant at which the unspent L0 remainder expires. */
export const L0_EXPIRY_HOURS = envInt('WELCOME_L0_EXPIRY_HOURS', 72);
/** Daily return grant amount. Kept separate from the closed welcome-level ladder. */
export const DAILY_GRANT_AMOUNT = envInt('WELCOME_DAILY_TOKENS', 70);
/** Moscow calendar days after enrollment: 3-day Base scenario, 7-day Scale (§6). */
export const DAILY_WINDOW_DAYS = envInt('WELCOME_DAILY_WINDOW_DAYS', 3);
/** Hours after a daily grant at which its unspent bucket expires. */
export const DAILY_EXPIRY_HOURS = envInt('WELCOME_DAILY_EXPIRY_HOURS', 72);
/** Minimum account age before L1 can unlock. */
export const L1_MIN_ACCOUNT_AGE_HOURS = envInt('WELCOME_L1_MIN_AGE_HOURS', 18);
/** One fully-earned account's capped L0, L1, and daily grants. */
export const CLUSTER_TOKEN_CAP_FLOOR =
  WELCOME_GRANT_AMOUNTS.L0 + WELCOME_GRANT_AMOUNTS.L1 + DAILY_WINDOW_DAYS * DAILY_GRANT_AMOUNT;
/** Max capped free tokens grantable per cluster within the rolling window. */
export const CLUSTER_TOKEN_CAP = envInt('WELCOME_CLUSTER_TOKEN_CAP', CLUSTER_TOKEN_CAP_FLOOR);
/** Rolling window (days) for the per-cluster token cap. */
export const CLUSTER_WINDOW_DAYS = envInt('WELCOME_CLUSTER_WINDOW_DAYS', 30);
export const REGISTRATIONS_PER_24H = envInt('WELCOME_REGISTRATIONS_PER_24H', 10);
// This is an emergency backstop, not the primary anti-farm control. Keep the
// default well above a normal launch spike; /24 velocity, cluster caps,
// disposable-email checks, the COGS breaker, and captcha (when its client path
// exists) do the actual abuse control.
export const GLOBAL_REGISTRATIONS_PER_MINUTE = envInt(
  'WELCOME_GLOBAL_REGISTRATIONS_PER_MINUTE',
  10_000,
);
const WELCOME_COGS_PER_TOKEN_RUB = envFloat('WELCOME_COGS_PER_TOKEN_RUB', 0.01);
const FREE_COGS_LIMIT = 0.03;
const FREE_COGS_WINDOW_DAYS = 30;

if (
  process.env.WELCOME_CLUSTER_TOKEN_CAP !== undefined &&
  CLUSTER_TOKEN_CAP < CLUSTER_TOKEN_CAP_FLOOR
) {
  console.warn(
    `WELCOME_CLUSTER_TOKEN_CAP (${CLUSTER_TOKEN_CAP}) is below the computed free-grant floor (${CLUSTER_TOKEN_CAP_FLOOR}).`,
  );
}

export type GrantRefusalReason =
  | 'disabled' // kill-switch (free_grants_enabled = false)
  | 'cluster_cap' // rolling per-cluster token ceiling hit
  | 'phone_taken' // phone hash already anchors another account
  | 'not_enrolled' // no L0 grant → user is not in the program
  | 'ineligible' // L1 conditions not yet met
  | 'order_too_small'
  | 'velocity_cap'
  | 'disposable_email'
  | 'cogs_breaker'
  | 'cohort_frozen'
  | 'captcha_failed'
  | 'already_granted'; // this level was already issued (idempotent no-op / race)

export interface WelcomeGrantResult {
  granted: boolean;
  level: WelcomeLevel | DailyLevel;
  amount: number;
  reason?: GrantRefusalReason;
}

type DbLike = typeof defaultDb;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];

export function grantKey(userId: string, level: WelcomeLevel | DailyLevel): string {
  return `welcome:${userId}:${level}`;
}
export function l0ExpireKey(userId: string): string {
  return `welcome-expire:${userId}:L0`;
}

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const MOSCOW_DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: MOSCOW_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function moscowCalendarDay(date: Date): { key: string; ordinal: number } {
  const parts = MOSCOW_DAY_FORMAT.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => [part.type, part.value]),
  );
  const { year, month, day } = values;
  if (!/^\d{4}$/.test(year ?? '') || !/^\d{2}$/.test(month ?? '') || !/^\d{2}$/.test(day ?? '')) {
    throw new Error('could not derive a Moscow calendar day');
  }
  return {
    key: `${year}-${month}-${day}`,
    ordinal: Date.UTC(Number(year), Number(month) - 1, Number(day)),
  };
}

/** The sole validated constructor for the daily grant's dynamic event/ledger level. */
export function dailyLevelFor(date: Date): DailyLevel {
  const level = `DAILY:${moscowCalendarDay(date).key}`;
  if (!/^DAILY:\d{4}-\d{2}-\d{2}$/.test(level)) {
    throw new Error('invalid daily grant level');
  }
  return level as DailyLevel;
}

const HASH_SALT = process.env.FREE_CLUSTER_SALT ?? '';
function sha256(input: string): string {
  return createHash('sha256').update(`${HASH_SALT}|${input}`).digest('hex');
}

/** The /24 (IPv4) or /48 (IPv6) network prefix used as the cluster's network component. */
export function networkPrefix(ip: string | null | undefined): string {
  if (!ip) return 'unknown';
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  // IPv6: collapse to the first 3 hextets (~/48). Best-effort; farms are IPv4.
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::/48`;
  return ip.trim();
}

/** Cluster key = hash(device cookie + /24). Neither raw value is stored. */
export function clusterKeyFor(deviceId: string, ip: string | null | undefined): string {
  // Cluster on the device cookie AND the /24 so distinct real devices behind one
  // NAT get distinct clusters — critical under carrier-grade NAT (ubiquitous in RU),
  // where a /24-only key would collectively cap thousands of legitimate users.
  // Cookie-reset farming is caught separately and un-evadably by the server-observed
  // /24 velocity cap ({@link registrationVelocityKey}), not by dropping the cookie here.
  return sha256(`${deviceId}|${networkPrefix(ip)}`);
}

/** phone hash = sha256(digits-only E.164). Never stores the raw number. */
export function phoneHashFor(phone: string): string {
  const normalized = normalizePhoneE164(phone);
  if (!normalized) throw new Error('invalid phone number: expected E.164');
  return sha256(`phone|${normalized}`);
}

export function normalizePhoneE164(phone: string): string | null {
  const compact = phone.trim().replace(/[\s().-]/g, '');
  const digits = compact.replace(/^\+/, '');
  if (/^8\d{10}$/.test(digits) && !compact.startsWith('+')) return `+7${digits.slice(1)}`;
  if (/^7\d{10}$/.test(digits) && !compact.startsWith('+')) return `+${digits}`;
  if (/^\+[1-9]\d{1,14}$/.test(compact)) return compact;
  return null;
}

export function registrationVelocityKey(ip: string | null | undefined): string {
  return sha256(`registration-velocity|${networkPrefix(ip)}`);
}

/** Enrollment is based on authenticated identity, not whether rows were just hydrated. */
export function shouldAttemptWelcomeEnrollment(isAnonymous: boolean): boolean {
  return !isAnonymous;
}

export function cogsBreakerTrips(input: { freeCogsRub: number; revenueRub: number }): boolean {
  if (input.freeCogsRub <= 0) return false;
  if (input.revenueRub <= 0) return true;
  return input.freeCogsRub / input.revenueRub > FREE_COGS_LIMIT;
}

export async function verifySmartCaptchaToken(token: string): Promise<boolean> {
  const secret = process.env.YANDEX_SMARTCAPTCHA_SERVER_KEY;
  if (!token || !secret) return false;
  try {
    const response = await fetch('https://smartcaptcha.yandexcloud.net/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, secret }).toString(),
    });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: string } | null;
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

export interface WelcomeServiceOptions {
  db?: DbLike;
  credits?: CreditService;
}

export class WelcomeGrantService {
  private readonly db: DbLike;
  private readonly credits: CreditService;

  constructor(opts: WelcomeServiceOptions = {}) {
    this.db = opts.db ?? defaultDb;
    this.credits = opts.credits ?? defaultCreditService;
  }

  private runIn<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (tx) return fn(tx);
    return this.db.transaction(fn);
  }

  /** Which welcome levels the user has already been granted (from the ledger). */
  private async grantedLevels(runner: DbLike | Tx, userId: string): Promise<Set<WelcomeLevel>> {
    const keys = (['L0', 'L1', 'L2', 'L3'] as WelcomeLevel[]).map((l) => grantKey(userId, l));
    const rows = await runner
      .select({ key: creditTransactions.idempotencyKey })
      .from(creditTransactions)
      .where(inArray(creditTransactions.idempotencyKey, keys));
    const out = new Set<WelcomeLevel>();
    for (const r of rows) {
      const level = r.key.split(':').pop() as WelcomeLevel;
      out.add(level);
    }
    return out;
  }

  /** The cluster the user enrolled through — carried on their L0 event row. */
  private async enrollmentCluster(runner: DbLike | Tx, userId: string): Promise<string | null> {
    const rows = await runner
      .select({ clusterKey: freeGrantEvents.clusterKey })
      .from(freeGrantEvents)
      .where(and(eq(freeGrantEvents.userId, userId), eq(freeGrantEvents.level, 'L0')))
      .limit(1);
    return rows[0]?.clusterKey ?? null;
  }

  /** Rolling sum of capped free grants against a cluster within the window. */
  private async rollingCapSum(runner: DbLike | Tx, clusterKey: string): Promise<number> {
    const since = new Date(Date.now() - CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await runner
      .select({ sum: sql<string>`COALESCE(SUM(${freeGrantEvents.amount}), 0)` })
      .from(freeGrantEvents)
      .where(
        and(
          eq(freeGrantEvents.clusterKey, clusterKey),
          sql`(${freeGrantEvents.level} IN ('L0', 'L1') OR ${freeGrantEvents.level} LIKE 'DAILY:%')`,
          gte(freeGrantEvents.createdAt, since),
        ),
      );
    return Number(rows[0]?.sum ?? 0);
  }

  private async registrationVelocityAllows(tx: Tx, ip: string): Promise<boolean> {
    const now = new Date();
    const buckets = [
      {
        scope: `24h:${registrationVelocityKey(ip)}`,
        windowMs: 24 * 60 * 60 * 1000,
        limit: REGISTRATIONS_PER_24H,
      },
      {
        scope: 'global:1m',
        windowMs: 60 * 1000,
        limit: GLOBAL_REGISTRATIONS_PER_MINUTE,
      },
    ];
    const states: Array<{
      scope: string;
      expired: boolean;
      registrations: number;
    }> = [];
    for (const bucket of buckets) {
      await tx
        .insert(freeRegistrationWindows)
        .values({ scope: bucket.scope, windowStartedAt: now, registrations: 0 })
        .onConflictDoNothing({ target: freeRegistrationWindows.scope });
      const rows = await tx
        .select()
        .from(freeRegistrationWindows)
        .where(eq(freeRegistrationWindows.scope, bucket.scope))
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) return false;
      const expired = now.getTime() - row.windowStartedAt.getTime() >= bucket.windowMs;
      if (!expired && row.registrations >= bucket.limit) return false;
      states.push({ scope: bucket.scope, expired, registrations: row.registrations });
    }

    // Check every bucket before mutating any counter. In particular, a global
    // launch-spike rejection must not burn the caller's /24 quota.
    for (const state of states) {
      await tx
        .update(freeRegistrationWindows)
        .set(
          state.expired
            ? { windowStartedAt: now, registrations: 1, updatedAt: now }
            : {
                registrations: sql`${freeRegistrationWindows.registrations} + 1`,
                updatedAt: now,
              },
        )
        .where(eq(freeRegistrationWindows.scope, state.scope));
    }
    return true;
  }

  private async cogsBreakerIsTripped(runner: DbLike | Tx): Promise<boolean> {
    if (process.env.NODE_ENV !== 'production' && process.env.FREE_COGS_BREAKER_ENABLED !== '1') {
      return false;
    }
    const since = new Date(Date.now() - FREE_COGS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [freeRows, revenueRows] = await Promise.all([
      runner
        .select({ sum: sql<string>`COALESCE(SUM(${freeGrantEvents.amount}), 0)` })
        .from(freeGrantEvents)
        .where(gte(freeGrantEvents.createdAt, since)),
      runner
        .select({ sum: sql<string>`COALESCE(SUM(${orders.amountRub}), 0)` })
        .from(orders)
        .where(and(eq(orders.ourStatus, 'paid'), gte(orders.paidAt, since))),
    ]);
    return cogsBreakerTrips({
      freeCogsRub: Number(freeRows[0]?.sum ?? 0) * WELCOME_COGS_PER_TOKEN_RUB,
      revenueRub: Number(revenueRows[0]?.sum ?? 0),
    });
  }

  /**
   * Core issue path (shared by all levels). Assumes the level has NOT yet been
   * granted (callers pre-check). Idempotency is still race-safe: the
   * (user_id, level) unique index on free_grant_events is the gate — if another
   * concurrent call already inserted the event, we insert 0 rows and bail without
   * double-counting. When `countTowardCap`, the cluster row is locked FOR UPDATE
   * so the cap check + increment are atomic against other users in the cluster.
   */
  private async issue(
    tx: Tx,
    level: WelcomeLevel | DailyLevel,
    userId: string,
    clusterKey: string,
    countTowardCap: boolean,
    amount: number,
    expiresAt: Date | null,
    sourceOrderId?: string,
  ): Promise<WelcomeGrantResult> {
    // Serialize every welcome grant against L0 expiry and the credit-service
    // reserve/settle path for this user. The event unique key handles retries;
    // this row lock also makes the balance/expiry boundary deterministic.
    await tx
      .select({ id: usersApp.id })
      .from(usersApp)
      .where(eq(usersApp.id, userId))
      .for('update');

    await tx.insert(freeClusters).values({ clusterKey }).onConflictDoNothing();

    if (countTowardCap) {
      // Serialize concurrent capped grants for this cluster.
      await tx
        .select({ k: freeClusters.clusterKey })
        .from(freeClusters)
        .where(eq(freeClusters.clusterKey, clusterKey))
        .for('update');
      const used = await this.rollingCapSum(tx, clusterKey);
      if (used + amount > CLUSTER_TOKEN_CAP) {
        return { granted: false, level, amount, reason: 'cluster_cap' };
      }
    }

    // Event insert is the idempotency gate: a racing call inserts 0 rows.
    const inserted = await tx
      .insert(freeGrantEvents)
      .values({ id: nid(), clusterKey, userId, level, amount })
      .onConflictDoNothing({
        target: [freeGrantEvents.userId, freeGrantEvents.level],
      })
      .returning({ id: freeGrantEvents.id });
    if (inserted.length === 0) {
      return { granted: false, level, amount, reason: 'already_granted' };
    }

    await this.credits.grant({
      userId,
      amount,
      account: 'bonus_grant',
      origin: 'welcome',
      expiresAt,
      reason: `welcome.${level}`,
      ...(sourceOrderId ? { sourceOrderId } : {}),
      idempotencyKey: grantKey(userId, level),
      tx,
    });
    await tx
      .update(freeClusters)
      .set({ tokensGranted: sql`${freeClusters.tokensGranted} + ${amount}`, updatedAt: new Date() })
      .where(eq(freeClusters.clusterKey, clusterKey));

    return { granted: true, level, amount };
  }

  /**
   * L0 — the registration grant. Enrolls the user in the program. Fires once per
   * user (idempotent). Refused (silently-safe) when the kill-switch is off or the
   * cluster's rolling token cap is hit.
   */
  async grantL0(input: {
    userId: string;
    clusterKey: string;
    sourceIp?: string;
    email?: string | null;
    captchaToken?: string | undefined;
    tx?: Tx;
  }): Promise<WelcomeGrantResult> {
    return this.runIn(input.tx, async (tx) => {
      const granted = await this.grantedLevels(tx, input.userId);
      if (granted.has('L0'))
        return { granted: false, level: 'L0', amount: 0, reason: 'already_granted' };
      if (!(await readBoolFlag(FREE_GRANTS_ENABLED, true, tx))) {
        return {
          granted: false,
          level: 'L0',
          amount: WELCOME_GRANT_AMOUNTS.L0,
          reason: 'disabled',
        };
      }
      if (isDisposableEmail(input.email)) {
        return {
          granted: false,
          level: 'L0',
          amount: WELCOME_GRANT_AMOUNTS.L0,
          reason: 'disposable_email',
        };
      }
      if (await readBoolFlag(FREE_COHORT_FREEZE, false, tx)) {
        return {
          granted: false,
          level: 'L0',
          amount: WELCOME_GRANT_AMOUNTS.L0,
          reason: 'cohort_frozen',
        };
      }
      if (await this.cogsBreakerIsTripped(tx)) {
        return {
          granted: false,
          level: 'L0',
          amount: WELCOME_GRANT_AMOUNTS.L0,
          reason: 'cogs_breaker',
        };
      }
      if (input.sourceIp && !(await this.registrationVelocityAllows(tx, input.sourceIp))) {
        return {
          granted: false,
          level: 'L0',
          amount: WELCOME_GRANT_AMOUNTS.L0,
          reason: 'velocity_cap',
        };
      }
      if (await readBoolFlag(SMARTCAPTCHA_ENABLED, false, tx)) {
        if (!(await verifySmartCaptchaToken(input.captchaToken ?? ''))) {
          return {
            granted: false,
            level: 'L0',
            amount: WELCOME_GRANT_AMOUNTS.L0,
            reason: 'captcha_failed',
          };
        }
      }
      return this.issue(
        tx,
        'L0',
        input.userId,
        input.clusterKey,
        true,
        WELCOME_GRANT_AMOUNTS.L0,
        null,
      );
    });
  }

  /**
   * L1 — first qualified return. Only enrolled users (have L0) progress. Checks
   * account age, ≥1 completed generation, and a new UTC day since registration.
   */
  async grantL1(input: {
    userId: string;
    clusterKey: string;
    tx?: Tx;
  }): Promise<WelcomeGrantResult> {
    return this.runIn(input.tx, async (tx) => {
      const granted = await this.grantedLevels(tx, input.userId);
      if (!granted.has('L0'))
        return { granted: false, level: 'L1', amount: 0, reason: 'not_enrolled' };
      if (granted.has('L1'))
        return { granted: false, level: 'L1', amount: 0, reason: 'already_granted' };
      if (!(await readBoolFlag(FREE_GRANTS_ENABLED, true, tx))) {
        return {
          granted: false,
          level: 'L1',
          amount: WELCOME_GRANT_AMOUNTS.L1,
          reason: 'disabled',
        };
      }
      if (!(await this.isL1Eligible(tx, input.userId))) {
        return {
          granted: false,
          level: 'L1',
          amount: WELCOME_GRANT_AMOUNTS.L1,
          reason: 'ineligible',
        };
      }
      return this.issue(
        tx,
        'L1',
        input.userId,
        input.clusterKey,
        true,
        WELCOME_GRANT_AMOUNTS.L1,
        null,
      );
    });
  }

  /** L1 gate: account age ≥18h AND ≥1 succeeded generation AND a new UTC day. */
  async isL1Eligible(runner: DbLike | Tx, userId: string): Promise<boolean> {
    // Registration time = the L0 grant's created_at (the enrollment instant).
    const l0 = await runner
      .select({ createdAt: creditTransactions.createdAt })
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, grantKey(userId, 'L0')))
      .limit(1);
    const registeredAt = l0[0]?.createdAt;
    if (!registeredAt) return false;

    const now = new Date();
    const ageHours = (now.getTime() - registeredAt.getTime()) / (60 * 60 * 1000);
    if (ageHours < L1_MIN_ACCOUNT_AGE_HOURS) return false;

    // New calendar day (UTC) — a genuine return visit, not the same-session grind.
    const sameUtcDay =
      now.getUTCFullYear() === registeredAt.getUTCFullYear() &&
      now.getUTCMonth() === registeredAt.getUTCMonth() &&
      now.getUTCDate() === registeredAt.getUTCDate();
    if (sameUtcDay) return false;

    const done = await runner
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.status, 'succeeded')))
      .limit(1);
    return done.length > 0;
  }

  /**
   * Daily return grant — once per Moscow calendar day, on days 1–3 after L0
   * enrollment. Its cluster is fixed at L0 enrollment, not the request cluster.
   */
  async grantDaily(input: { userId: string; tx?: Tx }): Promise<WelcomeGrantResult> {
    return this.runIn(input.tx, async (tx) => {
      const granted = await this.grantedLevels(tx, input.userId);
      if (!granted.has('L0')) {
        return {
          granted: false,
          level: dailyLevelFor(new Date()),
          amount: 0,
          reason: 'not_enrolled',
        };
      }
      if (!(await readBoolFlag(FREE_GRANTS_ENABLED, true, tx))) {
        return {
          granted: false,
          level: dailyLevelFor(new Date()),
          amount: DAILY_GRANT_AMOUNT,
          reason: 'disabled',
        };
      }
      if (await this.cogsBreakerIsTripped(tx)) {
        return {
          granted: false,
          level: dailyLevelFor(new Date()),
          amount: DAILY_GRANT_AMOUNT,
          reason: 'cogs_breaker',
        };
      }

      const l0 = await tx
        .select({ createdAt: creditTransactions.createdAt })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, grantKey(input.userId, 'L0')))
        .limit(1);
      const enrolledAt = l0[0]?.createdAt;
      if (!enrolledAt) {
        return {
          granted: false,
          level: dailyLevelFor(new Date()),
          amount: 0,
          reason: 'not_enrolled',
        };
      }

      const now = new Date();
      const daysSinceEnrollment =
        (moscowCalendarDay(now).ordinal - moscowCalendarDay(enrolledAt).ordinal) /
        (24 * 60 * 60 * 1000);
      const level = dailyLevelFor(now);
      if (daysSinceEnrollment < 1 || daysSinceEnrollment > DAILY_WINDOW_DAYS) {
        return { granted: false, level, amount: DAILY_GRANT_AMOUNT, reason: 'ineligible' };
      }

      const clusterKey = await this.enrollmentCluster(tx, input.userId);
      if (!clusterKey) return { granted: false, level, amount: 0, reason: 'not_enrolled' };
      return this.issue(
        tx,
        level,
        input.userId,
        clusterKey,
        true,
        DAILY_GRANT_AMOUNT,
        new Date(now.getTime() + DAILY_EXPIRY_HOURS * 60 * 60 * 1000),
      );
    });
  }

  /**
   * L2 — phone verification. One phone hash anchors one account's bonuses: the
   * anchor is claimed structurally (PK on phone_hash). If it already belongs to a
   * DIFFERENT user, the grant is refused ('phone_taken') and no tokens move.
   */
  async grantL2(input: {
    userId: string;
    phoneHash: string;
    clusterKey?: string;
    tx?: Tx;
  }): Promise<WelcomeGrantResult> {
    return this.runIn(input.tx, async (tx) => {
      const granted = await this.grantedLevels(tx, input.userId);
      if (!granted.has('L0'))
        return { granted: false, level: 'L2', amount: 0, reason: 'not_enrolled' };
      if (granted.has('L2'))
        return { granted: false, level: 'L2', amount: 0, reason: 'already_granted' };
      if (!(await readBoolFlag(PHONE_BINDING_ENABLED, false, tx))) {
        return {
          granted: false,
          level: 'L2',
          amount: WELCOME_GRANT_AMOUNTS.L2,
          reason: 'disabled',
        };
      }
      if (!(await readBoolFlag(FREE_GRANTS_ENABLED, true, tx))) {
        return {
          granted: false,
          level: 'L2',
          amount: WELCOME_GRANT_AMOUNTS.L2,
          reason: 'disabled',
        };
      }

      const clusterKey = input.clusterKey ?? (await this.enrollmentCluster(tx, input.userId));
      if (!clusterKey) return { granted: false, level: 'L2', amount: 0, reason: 'not_enrolled' };
      await tx.insert(freeClusters).values({ clusterKey }).onConflictDoNothing();

      // Claim the phone anchor (PK = phone_hash). Idempotent for the same user.
      const claimed = await tx
        .insert(freePhoneAnchors)
        .values({ phoneHash: input.phoneHash, clusterKey, userId: input.userId })
        .onConflictDoNothing({ target: freePhoneAnchors.phoneHash })
        .returning({ userId: freePhoneAnchors.userId });
      if (claimed.length === 0) {
        const [owner] = await tx
          .select({ userId: freePhoneAnchors.userId })
          .from(freePhoneAnchors)
          .where(eq(freePhoneAnchors.phoneHash, input.phoneHash))
          .limit(1);
        if (owner && owner.userId !== input.userId) {
          return {
            granted: false,
            level: 'L2',
            amount: WELCOME_GRANT_AMOUNTS.L2,
            reason: 'phone_taken',
          };
        }
      }

      return this.issue(tx, 'L2', input.userId, clusterKey, false, WELCOME_GRANT_AMOUNTS.L2, null);
    });
  }

  /**
   * L3 — first successful paid order. Per-user only (idempotency key), because the
   * billing webhook exposes no stable payment-instrument id to dedup on (gap
   * flagged in the PR). Only enrolled users (have L0) qualify.
   */
  async grantL3(input: {
    userId: string;
    orderId?: string;
    orderAmountRub?: number;
    tx?: Tx;
  }): Promise<WelcomeGrantResult> {
    return this.runIn(input.tx, async (tx) => {
      const granted = await this.grantedLevels(tx, input.userId);
      if (!granted.has('L0'))
        return { granted: false, level: 'L3', amount: 0, reason: 'not_enrolled' };
      if (granted.has('L3'))
        return { granted: false, level: 'L3', amount: 0, reason: 'already_granted' };
      if (!(await readBoolFlag(FREE_GRANTS_ENABLED, true, tx))) {
        return {
          granted: false,
          level: 'L3',
          amount: WELCOME_GRANT_AMOUNTS.L3,
          reason: 'disabled',
        };
      }
      if (input.orderAmountRub == null || input.orderAmountRub < 49) {
        return {
          granted: false,
          level: 'L3',
          amount: WELCOME_GRANT_AMOUNTS.L3,
          reason: 'order_too_small',
        };
      }
      const clusterKey = await this.enrollmentCluster(tx, input.userId);
      if (!clusterKey) return { granted: false, level: 'L3', amount: 0, reason: 'not_enrolled' };
      return this.issue(
        tx,
        'L3',
        input.userId,
        clusterKey,
        false,
        WELCOME_GRANT_AMOUNTS.L3,
        null,
        input.orderId,
      );
    });
  }

  // ── L0 expiry (worker reaper calls these) ───────────────────────────────

  /** L0 grants older than the expiry window that have not yet been clawed back. */
  async findExpirableL0(
    limit = 200,
    runner: DbLike | Tx = this.db,
  ): Promise<Array<{ userId: string }>> {
    const cutoff = new Date(Date.now() - L0_EXPIRY_HOURS * 60 * 60 * 1000);
    // L0 grant rows whose user has no expire leg yet. The idempotency_key encodes
    // the userId, so we derive it and anti-join on the expire key.
    const rows = await runner
      .select({ userId: creditTransactions.userId })
      .from(creditTransactions)
      .where(
        and(
          eq(creditTransactions.reason, 'welcome.L0'),
          sql`${creditTransactions.createdAt} < ${cutoff}`,
          sql`NOT EXISTS (
            SELECT 1 FROM ${creditTransactions} AS e
            WHERE e.idempotency_key = 'welcome-expire:' || ${creditTransactions.userId} || ':L0'
          )`,
        ),
      )
      .limit(limit);
    return rows;
  }

  /**
   * Claw back the UNSPENT remainder of a user's L0 grant. Writes ONE idempotent
   * negative `available` leg keyed `welcome-expire:{userId}:L0` (which doubles as
   * the "already expired" marker, so a 0-clawback still records completion).
   *
   * Semantics — the L0 bucket is the authority. Its remaining capacity is the
   * exact unspent L0 remainder, including when an expiring daily welcome bucket
   * was consumed before the non-expiring L0 bucket.
   */
  async expireL0ForUser(
    userId: string,
    tx: Tx,
  ): Promise<{ clawedBack: number; alreadyDone: boolean } | null> {
    // Serialize against CreditService.reserve(), which locks this same row.
    // Otherwise a reservation could move tokens between our balance reads and
    // the expiry insert, then later refund expired tokens back into availability.
    await tx
      .select({ id: usersApp.id })
      .from(usersApp)
      .where(eq(usersApp.id, userId))
      .for('update');

    const key = l0ExpireKey(userId);
    const existing = await tx
      .select({ id: creditTransactions.id })
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, key))
      .limit(1);
    if (existing.length > 0) return { clawedBack: 0, alreadyDone: true };

    const l0 = await tx
      .select({
        id: creditTransactions.id,
        amount: creditTransactions.amount,
        bucketId: creditTransactions.bucketId,
      })
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, grantKey(userId, 'L0')))
      .limit(1);
    if (l0.length === 0) return null; // never enrolled — nothing to expire

    // Grandfathered L0 was absorbed into an immortal legacy bucket. It must
    // never be retroactively expired: there is no separate L0 bucket left to
    // debit without confiscating pooled pre-cutoff credit.
    if (l0[0]!.bucketId) {
      const [owner] = await tx
        .select({ origin: creditBuckets.origin })
        .from(creditBuckets)
        .where(eq(creditBuckets.id, l0[0]!.bucketId))
        .limit(1);
      if (owner?.origin === 'legacy') return null;
    }

    const [l0Bucket] = await tx
      .select({
        id: creditBuckets.id,
        granted: creditBuckets.granted,
        reserved: creditBuckets.reserved,
        consumed: creditBuckets.consumed,
      })
      .from(creditBuckets)
      .where(eq(creditBuckets.grantKey, grantKey(userId, 'L0')))
      .limit(1);
    if (!l0Bucket) return null;

    // A live reservation is still unspent, but may later commit or refund. Defer
    // the expiry until it settles so the final unspent amount is unambiguous.
    const pendingRows = await tx
      .select({ sum: sql<string>`COALESCE(SUM(${creditTransactions.amount}), 0)` })
      .from(creditTransactions)
      .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.account, 'pending')));
    if (Number(pendingRows[0]?.sum ?? 0) > 0) return null;

    const clawback = Math.max(0, l0Bucket.granted - l0Bucket.reserved - l0Bucket.consumed);

    // Keep the bucket authority and ledger leg equal. Reducing granted (rather
    // than increasing consumed) preserves the bucket capacity constraint and
    // the existing L0 expiry meaning.
    await tx
      .update(creditBuckets)
      .set({ granted: sql`${creditBuckets.granted} - ${clawback}` })
      .where(eq(creditBuckets.id, l0Bucket.id));

    // Direct insert (not clawback()) so a 0-amount marker can also be written —
    // it records "L0 expired" so findExpirableL0 stops returning this user.
    await tx
      .insert(creditTransactions)
      .values({
        id: nid(),
        userId,
        amount: -clawback,
        account: 'available',
        reason: 'welcome.expire.L0',
        idempotencyKey: key,
      })
      .onConflictDoNothing({ target: creditTransactions.idempotencyKey });

    return { clawedBack: clawback, alreadyDone: false };
  }
}
