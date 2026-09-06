import 'dotenv/config';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, gte, inArray } from 'drizzle-orm';
import {
  appSettings,
  creditBuckets,
  creditTransactions,
  db,
  freeClusters,
  freeGrantEvents,
  freeRegistrationWindows,
  jobs,
  models,
  nid,
  pool,
  usersApp,
  usersPii,
  workflows,
} from '@seed/db';
import { CreditService, SIGNUP_BONUS_CREDITS } from '../src/service';
import {
  clusterKeyFor,
  CLUSTER_TOKEN_CAP,
  DAILY_EXPIRY_HOURS,
  DAILY_GRANT_AMOUNT,
  DAILY_WINDOW_DAYS,
  dailyLevelFor,
  FREE_GRANTS_ENABLED,
  PHONE_BINDING_ENABLED,
  REGISTRATIONS_PER_24H,
  GLOBAL_REGISTRATIONS_PER_MINUTE,
  registrationVelocityKey,
  SMARTCAPTCHA_ENABLED,
  grantKey,
  l0ExpireKey,
  phoneHashFor,
  WELCOME_GRANT_AMOUNTS,
  WelcomeGrantService,
  writeBoolFlag,
} from '../src/index';

const welcome = new WelcomeGrantService();
const credits = new CreditService();

const createdUsers: string[] = [];
const createdClusters: string[] = [];

describe('welcome amount SSOT', () => {
  it('keeps the legacy signup alias aligned with the active L0 amount', () => {
    expect(SIGNUP_BONUS_CREDITS).toBe(WELCOME_GRANT_AMOUNTS.L0);
  });
});

async function newUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'WelcomeTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `welcome+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

/** A fresh, unique cluster key (unless a caller wants two users to share one). */
function freshCluster(): string {
  const subnet = createdClusters.length + 1;
  const key = clusterKeyFor(`device-${nid()}`, `203.0.${subnet}.7`);
  createdClusters.push(key);
  return key;
}

// One shared model row is enough for the workflow/job fixtures.
let MODEL_ID = '';
async function ensureModel(): Promise<string> {
  if (MODEL_ID) return MODEL_ID;
  MODEL_ID = nid();
  await db.insert(models).values({
    id: MODEL_ID,
    provider: 'stub',
    family: 'test',
    variant: 'v1',
    kind: 'image',
    unitKind: 'image',
    expectedLatencyMsP50: 100,
    expectedLatencyMsP95: 200,
    providerModelId: 'stub/test',
    providerEndpoint: 'stub://test',
  });
  return MODEL_ID;
}

async function makeSucceededJob(userId: string): Promise<void> {
  const modelId = await ensureModel();
  const wfId = nid();
  await db.insert(workflows).values({ id: wfId, userId, modelId });
  await db.insert(jobs).values({
    id: nid(),
    userId,
    workflowId: wfId,
    modelId,
    status: 'succeeded',
    idempotencyKey: `job:${nid()}`,
  });
}

/** Backdate the user's L0 grant so it reads as registered `hoursAgo` in the past. */
async function backdateL0(userId: string, hoursAgo: number): Promise<void> {
  const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  await db
    .update(creditTransactions)
    .set({ createdAt: when })
    .where(eq(creditTransactions.idempotencyKey, grantKey(userId, 'L0')));
}

async function setL0GrantedAt(userId: string, when: Date): Promise<void> {
  await db
    .update(creditTransactions)
    .set({ createdAt: when })
    .where(eq(creditTransactions.idempotencyKey, grantKey(userId, 'L0')));
}

/** Consume `amount` credits (reserve → commit) as a real spend would. */
async function spend(userId: string, amount: number): Promise<void> {
  const jobId = `spend-${nid()}`;
  await credits.reserve({
    userId,
    jobId,
    amount,
    reason: 'test.spend',
    idempotencyKey: `res:${jobId}`,
  });
  await credits.commit({ userId, jobId, amount, idempotencyKey: `com:${jobId}` });
}

beforeAll(async () => {
  await ensureModel();
});

beforeEach(async () => {
  await writeBoolFlag(FREE_GRANTS_ENABLED, true, null);
  await writeBoolFlag(PHONE_BINDING_ENABLED, false, null);
});

afterEach(async () => {
  // Safety net: a test that fails between stubEnv/stubGlobal and its cleanup
  // must not leak the stub (e.g. FREE_COGS_BREAKER_ENABLED) into later tests.
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await writeBoolFlag(FREE_GRANTS_ENABLED, true, null); // reset kill-switch
  await writeBoolFlag(PHONE_BINDING_ENABLED, false, null);
  await writeBoolFlag(SMARTCAPTCHA_ENABLED, false, null);
  for (const id of createdUsers) {
    await db.delete(usersApp).where(eq(usersApp.id, id)); // cascades pii/credit_tx/events/anchors
  }
  createdUsers.length = 0;
  if (createdClusters.length > 0) {
    await db.delete(freeClusters).where(inArray(freeClusters.clusterKey, createdClusters));
    createdClusters.length = 0;
  }
  await db.delete(freeRegistrationWindows);
});

afterAll(async () => {
  if (MODEL_ID) await db.delete(models).where(eq(models.id, MODEL_ID));
  await db.delete(appSettings).where(eq(appSettings.key, FREE_GRANTS_ENABLED));
  await pool.end();
});

describe('WelcomeGrantService — L0 registration grant', () => {
  it('fails closed when the free-grants flag row is absent', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await db.delete(appSettings).where(eq(appSettings.key, FREE_GRANTS_ENABLED));

    const res = await welcome.grantL0({ userId: u, clusterKey: cluster });

    expect(res).toMatchObject({ granted: false, reason: 'disabled' });
  });

  it('grants L0 once and is idempotent — a double call writes exactly one ledger row', async () => {
    const u = await newUser();
    const cluster = freshCluster();

    const first = await welcome.grantL0({ userId: u, clusterKey: cluster });
    expect(WELCOME_GRANT_AMOUNTS.L0).toBe(210);
    expect(first).toEqual({ granted: true, level: 'L0', amount: WELCOME_GRANT_AMOUNTS.L0 });

    const second = await welcome.grantL0({ userId: u, clusterKey: cluster });
    expect(second.granted).toBe(false);
    expect(second.reason).toBe('already_granted');

    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, grantKey(u, 'L0')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.account).toBe('bonus_grant');
    expect(await credits.balanceFor(u)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0,
      pending: 0,
    });
  });

  it('kill-switch OFF refuses the grant silently and writes no ledger row', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await writeBoolFlag(FREE_GRANTS_ENABLED, false, 'admin-x');

    const res = await welcome.grantL0({ userId: u, clusterKey: cluster });
    expect(res.granted).toBe(false);
    expect(res.reason).toBe('disabled');

    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, grantKey(u, 'L0')));
    expect(rows).toHaveLength(0);
    expect(await credits.balanceFor(u)).toEqual({ available: 0, pending: 0 });
  });

  it('SmartCaptcha rejects a bad token when enabled, while disabled remains unaffected', async () => {
    const blocked = await newUser();
    const allowed = await newUser();
    await writeBoolFlag(SMARTCAPTCHA_ENABLED, true, 'test');
    vi.stubEnv('YANDEX_SMARTCAPTCHA_SERVER_KEY', 'test-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'failed' }), { status: 200 })),
    );

    const refused = await welcome.grantL0({
      userId: blocked,
      clusterKey: freshCluster(),
      captchaToken: 'bad-token',
    });
    expect(refused).toMatchObject({ granted: false, reason: 'captcha_failed' });

    await writeBoolFlag(SMARTCAPTCHA_ENABLED, false, 'test');
    const granted = await welcome.grantL0({ userId: allowed, clusterKey: freshCluster() });
    expect(granted.granted).toBe(true);
    vi.unstubAllGlobals();
  });

  it('free-COGS circuit breaker refuses a new L0 with a distinct reason', async () => {
    vi.stubEnv('FREE_COGS_BREAKER_ENABLED', '1');
    // The breaker reads GLOBAL 30-day free-COGS/revenue sums, so pre-existing
    // free_grant_events (real dev data on a shared DB) would pre-trip it.
    // Backdate any in-window events out of the window, then restore them, so
    // the scenario deterministically starts from zero free COGS.
    const cogsWindowMs = 30 * 24 * 60 * 60 * 1000; // FREE_COGS_WINDOW_DAYS in welcome.ts
    const priorEvents = await db
      .select({ id: freeGrantEvents.id, createdAt: freeGrantEvents.createdAt })
      .from(freeGrantEvents)
      .where(gte(freeGrantEvents.createdAt, new Date(Date.now() - cogsWindowMs)));
    if (priorEvents.length > 0) {
      await db
        .update(freeGrantEvents)
        .set({ createdAt: new Date(Date.now() - cogsWindowMs - 24 * 60 * 60 * 1000) })
        .where(
          inArray(
            freeGrantEvents.id,
            priorEvents.map((row) => row.id),
          ),
        );
    }
    try {
      const first = await newUser();
      const second = await newUser();
      expect((await welcome.grantL0({ userId: first, clusterKey: freshCluster() })).granted).toBe(
        true,
      );

      const refused = await welcome.grantL0({ userId: second, clusterKey: freshCluster() });

      expect(refused).toMatchObject({ granted: false, reason: 'cogs_breaker' });
    } finally {
      for (const row of priorEvents) {
        await db
          .update(freeGrantEvents)
          .set({ createdAt: row.createdAt })
          .where(eq(freeGrantEvents.id, row.id));
      }
    }
  });

  it('kill-switch OFF disables every progression grant (L1, L2, and L3)', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await writeBoolFlag(FREE_GRANTS_ENABLED, false, 'admin-x');

    const [l1, l2, l3] = await Promise.all([
      welcome.grantL1({ userId: u, clusterKey: cluster }),
      welcome.grantL2({ userId: u, clusterKey: cluster, phoneHash: phoneHashFor('+79001112233') }),
      welcome.grantL3({ userId: u }),
    ]);

    expect(l1).toMatchObject({ granted: false, reason: 'disabled' });
    expect(l2).toMatchObject({ granted: false, reason: 'disabled' });
    expect(l3).toMatchObject({ granted: false, reason: 'disabled' });
    expect(await credits.balanceFor(u)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0,
      pending: 0,
    });
  });
});

describe('WelcomeGrantService — cluster cap (anti-farm)', () => {
  it('a global rejection does not consume the local /24 quota', async () => {
    const u = await newUser();
    const ip = '198.51.100.20';
    await db.insert(freeRegistrationWindows).values([
      {
        scope: `global:1m`,
        windowStartedAt: new Date(),
        registrations: GLOBAL_REGISTRATIONS_PER_MINUTE,
      },
    ]);

    const result = await welcome.grantL0({
      userId: u,
      clusterKey: freshCluster(),
      sourceIp: ip,
    });

    expect(result).toMatchObject({ granted: false, reason: 'velocity_cap' });
    const local = await db
      .select()
      .from(freeRegistrationWindows)
      .where(eq(freeRegistrationWindows.scope, `24h:${registrationVelocityKey(ip)}`));
    expect(local[0]?.registrations ?? 0).toBe(0);
  });

  it('cleared cookies cannot evade the server-observed /24 velocity cap', async () => {
    const results = [];
    for (let i = 0; i <= REGISTRATIONS_PER_24H; i++) {
      const u = await newUser();
      const ip = `198.51.100.${i + 1}`;
      results.push(
        await welcome.grantL0({
          userId: u,
          clusterKey: clusterKeyFor(`cleared-cookie-${i}`, ip),
          sourceIp: ip,
        }),
      );
    }

    expect(results.slice(0, REGISTRATIONS_PER_24H).every((result) => result.granted)).toBe(true);
    expect(results.at(-1)).toMatchObject({ granted: false, reason: 'velocity_cap' });
  });

  it('a third account on a capped cluster gets zero tokens', async () => {
    const cluster = freshCluster();
    const a = await newUser();
    const b = await newUser();
    const c = await newUser();

    // L0 + L1 leaves exactly one L0-sized space in the computed W5 cap.
    await welcome.grantL0({ userId: a, clusterKey: cluster });
    await backdateL0(a, 40);
    await makeSucceededJob(a);
    const fill = await welcome.grantL1({ userId: a, clusterKey: cluster });
    expect(fill.granted).toBe(true);

    const second = await welcome.grantL0({ userId: b, clusterKey: cluster });
    expect(second.granted).toBe(true);
    expect(await credits.balanceFor(b)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0,
      pending: 0,
    });

    const third = await welcome.grantL0({ userId: c, clusterKey: cluster });
    expect(third.granted).toBe(false);
    expect(third.reason).toBe('cluster_cap');
    expect(await credits.balanceFor(c)).toEqual({ available: 0, pending: 0 });
  });

  it('counts dated daily levels across the rolling window rather than a finite IN list', async () => {
    const cluster = freshCluster();
    const enrolled = await newUser();
    const blocked = await newUser();
    await welcome.grantL0({ userId: enrolled, clusterKey: cluster });
    const today = new Date();
    await db.insert(freeGrantEvents).values([
      {
        id: nid(),
        userId: enrolled,
        clusterKey: cluster,
        level: 'L1',
        amount: WELCOME_GRANT_AMOUNTS.L1,
        createdAt: new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000),
      },
      ...[29, 14, 1].map((daysAgo) => ({
        id: nid(),
        userId: enrolled,
        clusterKey: cluster,
        level: dailyLevelFor(new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000)),
        amount: DAILY_GRANT_AMOUNT,
        createdAt: new Date(today.getTime() - daysAgo * 24 * 60 * 60 * 1000),
      })),
    ]);

    const result = await welcome.grantL0({ userId: blocked, clusterKey: cluster });

    expect(CLUSTER_TOKEN_CAP).toBe(
      WELCOME_GRANT_AMOUNTS.L0 + WELCOME_GRANT_AMOUNTS.L1 + DAILY_WINDOW_DAYS * DAILY_GRANT_AMOUNT,
    );
    expect(result).toMatchObject({ granted: false, reason: 'cluster_cap' });
  });

  it('the same second account on a DIFFERENT cluster still gets its grant', async () => {
    const clusterA = freshCluster();
    const clusterB = freshCluster();
    const a = await newUser();
    const b = await newUser();

    await welcome.grantL0({ userId: a, clusterKey: clusterA });
    const second = await welcome.grantL0({ userId: b, clusterKey: clusterB });
    expect(second.granted).toBe(true);
    expect(await credits.balanceFor(b)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0,
      pending: 0,
    });
  });
});

describe('WelcomeGrantService — L1 conditions matrix', () => {
  it('refuses L1 for a user who is not enrolled (no L0)', async () => {
    const u = await newUser();
    const res = await welcome.grantL1({ userId: u, clusterKey: freshCluster() });
    expect(res).toMatchObject({ granted: false, reason: 'not_enrolled' });
  });

  it('refuses L1 when the account is younger than 18h', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await makeSucceededJob(u);

    // Isolate the age gate: generation and new UTC day both pass, but only
    // 90 minutes have elapsed since signup.
    await db
      .update(creditTransactions)
      .set({ createdAt: new Date('2026-07-17T23:30:00.000Z') })
      .where(eq(creditTransactions.idempotencyKey, grantKey(u, 'L0')));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T01:00:00.000Z'));
    try {
      const res = await welcome.grantL1({ userId: u, clusterKey: cluster });
      expect(res).toMatchObject({ granted: false, reason: 'ineligible' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses L1 when the user has no completed generation', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await backdateL0(u, 40); // old enough + a prior day, but no succeeded job
    const res = await welcome.grantL1({ userId: u, clusterKey: cluster });
    expect(res).toMatchObject({ granted: false, reason: 'ineligible' });
  });

  it('refuses L1 when age and generation pass but it is still the signup UTC day', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await makeSucceededJob(u);

    const signup = new Date('2026-07-17T00:30:00.000Z');
    await db
      .update(creditTransactions)
      .set({ createdAt: signup })
      .where(eq(creditTransactions.idempotencyKey, grantKey(u, 'L0')));

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T20:30:00.000Z'));
    try {
      const res = await welcome.grantL1({ userId: u, clusterKey: cluster });
      expect(res).toMatchObject({ granted: false, reason: 'ineligible' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('grants L1 when age ≥18h, a new day, AND ≥1 completed generation all hold', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await backdateL0(u, 40);
    await makeSucceededJob(u);

    const res = await welcome.grantL1({ userId: u, clusterKey: cluster });
    expect(res).toEqual({ granted: true, level: 'L1', amount: WELCOME_GRANT_AMOUNTS.L1 });
    expect(await credits.balanceFor(u)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0 + WELCOME_GRANT_AMOUNTS.L1,
      pending: 0,
    });

    // Idempotent: a second qualified call does not double-grant.
    const again = await welcome.grantL1({ userId: u, clusterKey: cluster });
    expect(again).toMatchObject({ granted: false, reason: 'already_granted' });
  });
});

describe('WelcomeGrantService — daily Moscow return grant', () => {
  it('grants once on a new Moscow day and records matching event and ledger keys', async () => {
    const u = await newUser();
    const cluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: cluster });
    await setL0GrantedAt(u, new Date('2026-07-17T20:30:00.000Z')); // 23:30 MSK
    const now = new Date('2026-07-17T22:00:00.000Z'); // 01:00 MSK, the next day
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const first = await welcome.grantDaily({ userId: u });
      const second = await welcome.grantDaily({ userId: u });
      const level = dailyLevelFor(now);

      expect(DAILY_GRANT_AMOUNT).toBe(70);
      expect(first).toEqual({ granted: true, level, amount: DAILY_GRANT_AMOUNT });
      expect(second).toMatchObject({ granted: false, level, reason: 'already_granted' });
      const events = await db
        .select()
        .from(freeGrantEvents)
        .where(and(eq(freeGrantEvents.userId, u), eq(freeGrantEvents.level, level)));
      const ledger = await db
        .select()
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, grantKey(u, level)));
      expect(events).toHaveLength(1);
      expect(events[0]?.clusterKey).toBe(cluster);
      expect(ledger).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the Moscow boundary: 23:30 MSK cannot pre-claim, while 01:00 MSK can', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await setL0GrantedAt(u, new Date('2026-07-17T20:30:00.000Z')); // 23:30 MSK
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-17T20:50:00.000Z')); // still 17 July in Moscow
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({
        granted: false,
        reason: 'ineligible',
      });

      vi.setSystemTime(new Date('2026-07-17T22:00:00.000Z')); // 18 July, 01:00 MSK
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({ granted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not grant on enrollment day and stops permanently after the third later day', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await setL0GrantedAt(u, new Date('2026-07-17T09:00:00.000Z'));
    vi.useFakeTimers();
    try {
      expect(DAILY_WINDOW_DAYS).toBe(3);
      vi.setSystemTime(new Date('2026-07-17T18:00:00.000Z'));
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({
        granted: false,
        reason: 'ineligible',
      });

      for (const day of [18, 19, 20]) {
        vi.setSystemTime(new Date(`2026-07-${day}T18:00:00.000Z`));
        expect(await welcome.grantDaily({ userId: u })).toMatchObject({ granted: true });
      }

      vi.setSystemTime(new Date('2026-07-21T18:00:00.000Z'));
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({
        granted: false,
        reason: 'ineligible',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('anchors the window on L0 enrollment rather than the older users_app row', async () => {
    const u = await newUser();
    await db
      .update(usersApp)
      .set({ createdAt: new Date('2026-06-01T00:00:00.000Z') })
      .where(eq(usersApp.id, u));
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await setL0GrantedAt(u, new Date('2026-07-17T09:00:00.000Z'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T09:00:00.000Z'));
    try {
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({ granted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed and respects the COGS breaker', async () => {
    const disabled = await newUser();
    await welcome.grantL0({ userId: disabled, clusterKey: freshCluster() });
    await setL0GrantedAt(disabled, new Date('2026-07-17T09:00:00.000Z'));
    await writeBoolFlag(FREE_GRANTS_ENABLED, false, 'admin-x');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T09:00:00.000Z'));
    try {
      expect(await welcome.grantDaily({ userId: disabled })).toMatchObject({
        granted: false,
        reason: 'disabled',
      });
    } finally {
      vi.useRealTimers();
    }

    await writeBoolFlag(FREE_GRANTS_ENABLED, true, 'admin-x');
    const capped = await newUser();
    await welcome.grantL0({ userId: capped, clusterKey: freshCluster() });
    await setL0GrantedAt(capped, new Date('2026-07-17T09:00:00.000Z'));
    vi.stubEnv('FREE_COGS_BREAKER_ENABLED', '1');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T09:00:00.000Z'));
    try {
      expect(await welcome.grantDaily({ userId: capped })).toMatchObject({
        granted: false,
        reason: 'cogs_breaker',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('is race-safe and keeps all daily grants on the enrollment cluster', async () => {
    const u = await newUser();
    const enrollmentCluster = freshCluster();
    await welcome.grantL0({ userId: u, clusterKey: enrollmentCluster });
    await setL0GrantedAt(u, new Date('2026-07-17T09:00:00.000Z'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T09:00:00.000Z'));
    try {
      const results = await Promise.all([
        welcome.grantDaily({ userId: u }),
        welcome.grantDaily({ userId: u }),
      ]);
      expect(results.filter((result) => result.granted)).toHaveLength(1);
      const level = dailyLevelFor(new Date());
      const rows = await db
        .select({ clusterKey: freeGrantEvents.clusterKey })
        .from(freeGrantEvents)
        .where(and(eq(freeGrantEvents.userId, u), eq(freeGrantEvents.level, level)));
      expect(rows).toEqual([{ clusterKey: enrollmentCluster }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a 72-hour expiring welcome bucket', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await setL0GrantedAt(u, new Date('2030-07-17T09:00:00.000Z'));
    const now = new Date('2030-07-18T09:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const result = await welcome.grantDaily({ userId: u });
      const [bucket] = await db
        .select()
        .from(creditBuckets)
        .where(eq(creditBuckets.grantKey, grantKey(u, result.level)));
      expect(bucket?.expiresAt).toEqual(
        new Date(now.getTime() + DAILY_EXPIRY_HOURS * 60 * 60 * 1000),
      );
      expect(DAILY_EXPIRY_HOURS).toBe(72);
      // Expiry is evaluated against the DATABASE clock (W2: one clock, and it is
      // postgres's), so a timestamp derived from the faked JS clock — here year
      // 2030 — is still in the future for the DB and the bucket stays live.
      // Push it into the real past instead.
      await db
        .update(creditBuckets)
        .set({ expiresAt: new Date('2000-01-01T00:00:00.000Z') })
        .where(eq(creditBuckets.id, bucket!.id));
      expect(await credits.balanceFor(u)).toEqual({
        available: WELCOME_GRANT_AMOUNTS.L0,
        pending: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WelcomeGrantService — L2 phone-hash uniqueness', () => {
  it('one phone hash anchors exactly one account; a second account is refused', async () => {
    await writeBoolFlag(PHONE_BINDING_ENABLED, true, 'test');
    const phone = '+7 (900) 123-45-67';
    const hash = phoneHashFor(phone);

    const a = await newUser();
    await welcome.grantL0({ userId: a, clusterKey: freshCluster() });
    const b = await newUser();
    await welcome.grantL0({ userId: b, clusterKey: freshCluster() });

    const aRes = await welcome.grantL2({ userId: a, phoneHash: hash });
    expect(aRes).toEqual({ granted: true, level: 'L2', amount: WELCOME_GRANT_AMOUNTS.L2 });

    const bRes = await welcome.grantL2({ userId: b, phoneHash: hash });
    expect(bRes).toMatchObject({ granted: false, reason: 'phone_taken' });
    // b keeps only its L0; no L2 tokens leaked.
    expect(await credits.balanceFor(b)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0,
      pending: 0,
    });

    // Re-verifying the SAME number on the SAME account is a no-op, not a refusal-with-grant.
    const aAgain = await welcome.grantL2({ userId: a, phoneHash: hash });
    expect(aAgain).toMatchObject({ granted: false, reason: 'already_granted' });
    expect(await credits.balanceFor(a)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0 + WELCOME_GRANT_AMOUNTS.L2,
      pending: 0,
    });
  });

  it('refuses L2 for a non-enrolled user (no L0)', async () => {
    await writeBoolFlag(PHONE_BINDING_ENABLED, true, 'test');
    const u = await newUser();
    const res = await welcome.grantL2({ userId: u, phoneHash: phoneHashFor('+79001112233') });
    expect(res).toMatchObject({ granted: false, reason: 'not_enrolled' });
  });

  it('canonicalizes RU trunk and country forms to one hash', () => {
    expect(phoneHashFor('89001234567')).toBe(phoneHashFor('+79001234567'));
    expect(phoneHashFor('+7 (900) 123-45-67')).toBe(phoneHashFor('89001234567'));
  });

  it('refuses L2 when phone binding is disabled, including direct service calls', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });

    const res = await welcome.grantL2({ userId: u, phoneHash: phoneHashFor('+79001112233') });

    expect(res).toMatchObject({ granted: false, reason: 'disabled' });
  });
});

describe('WelcomeGrantService — L3 first paid order grant', () => {
  it('grants L3 exactly once for an enrolled user', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });

    const first = await welcome.grantL3({ userId: u, orderAmountRub: 49, orderId: `order:${u}` });
    expect(first).toEqual({ granted: true, level: 'L3', amount: WELCOME_GRANT_AMOUNTS.L3 });

    const retry = await welcome.grantL3({
      userId: u,
      orderAmountRub: 49,
      orderId: `order:${u}`,
    });
    expect(retry).toMatchObject({ granted: false, reason: 'already_granted' });
    expect(await credits.balanceFor(u)).toEqual({
      available: WELCOME_GRANT_AMOUNTS.L0 + WELCOME_GRANT_AMOUNTS.L3,
      pending: 0,
    });
  });

  it('does not grant L3 for an order below 49 RUB', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });

    const res = await welcome.grantL3({ userId: u, orderAmountRub: 48, orderId: `order:${u}` });

    expect(res).toMatchObject({ granted: false, reason: 'order_too_small' });
  });
});

describe('WelcomeGrantService — L0 72h expiry clawback', () => {
  it('L0 210 + daily 70, spend 70: expiry claws back the full 210 L0', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await setL0GrantedAt(u, new Date('2030-07-17T09:00:00.000Z'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-07-18T09:00:00.000Z'));
    try {
      expect(await welcome.grantDaily({ userId: u })).toMatchObject({ granted: true });
      await spend(u, DAILY_GRANT_AMOUNT);

      const result = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));

      expect(result).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 });
      const [expiryLeg] = await db
        .select({ amount: creditTransactions.amount })
        .from(creditTransactions)
        .where(eq(creditTransactions.idempotencyKey, l0ExpireKey(u)));
      const [l0Bucket] = await db
        .select({
          granted: creditBuckets.granted,
          reserved: creditBuckets.reserved,
          consumed: creditBuckets.consumed,
        })
        .from(creditBuckets)
        .where(eq(creditBuckets.grantKey, grantKey(u, 'L0')));
      expect(expiryLeg).toEqual({ amount: -WELCOME_GRANT_AMOUNTS.L0 });
      expect(l0Bucket).toEqual({ granted: 0, reserved: 0, consumed: 0 });
      expect(await credits.balanceFor(u)).toEqual({ available: 0, pending: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects only L0 grants older than 72h for the reaper', async () => {
    const expired = await newUser();
    await welcome.grantL0({ userId: expired, clusterKey: freshCluster() });
    await backdateL0(expired, 73);

    const fresh = await newUser();
    await welcome.grantL0({ userId: fresh, clusterKey: freshCluster() });

    const due = await welcome.findExpirableL0();
    expect(due.map((row) => row.userId)).toContain(expired);
    expect(due.map((row) => row.userId)).not.toContain(fresh);
  });

  it('claws back the entire UNSPENT L0 remainder, leaving zero', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await spend(u, 30); // 30 of L0 consumed

    const res = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    expect(res).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 - 30, alreadyDone: false });
    expect((await credits.balanceFor(u)).available).toBe(0);
  });

  it('never claws back the SPENT portion — a fully-spent L0 claws back nothing', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await spend(u, WELCOME_GRANT_AMOUNTS.L0); // all of L0 consumed

    const res = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    expect(res).toMatchObject({ clawedBack: 0 });
    expect((await credits.balanceFor(u)).available).toBe(0);
  });

  it('protects OTHER grants — only the unspent L0 is reclaimed', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    // Simulate a purchase (a protected non-L0 grant).
    await credits.grant({
      userId: u,
      amount: 100,
      account: 'pack_grant',
      reason: 'pack.purchase',
      idempotencyKey: `pack:${nid()}`,
    });
    await spend(u, 50); // balance now L0 + 100 - 50

    const res = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    // The bucket records the authoritative remaining L0 capacity.
    expect(res).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 - 50 });
    expect((await credits.balanceFor(u)).available).toBe(100); // the purchase survives
  });

  it('defers while credits are reserved, then reclaims a refunded unspent L0 remainder', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    const jobId = `pending-${nid()}`;
    await credits.reserve({
      userId: u,
      jobId,
      amount: 30,
      reason: 'test.pending',
      idempotencyKey: `reserve:${jobId}`,
    });

    const deferred = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    expect(deferred).toBeNull();

    await credits.refund({
      userId: u,
      jobId,
      amount: 30,
      reason: 'test.refund',
      idempotencyKey: `refund:${jobId}`,
    });
    const expired = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    expect(expired).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 });
    expect((await credits.balanceFor(u)).available).toBe(0);
  });

  it('is idempotent — a second expiry pass claws back nothing more', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });

    await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    const balAfterFirst = (await credits.balanceFor(u)).available;

    const second = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));
    expect(second).toMatchObject({ alreadyDone: true });
    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, l0ExpireKey(u)));
    expect(rows).toHaveLength(1);
    expect((await credits.balanceFor(u)).available).toBe(balAfterFirst);
  });

  it('skips an L0 whose ledger leg points at a grandfathered legacy bucket', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    const [l0Bucket] = await db
      .select({ id: creditBuckets.id, granted: creditBuckets.granted })
      .from(creditBuckets)
      .where(eq(creditBuckets.grantKey, grantKey(u, 'L0')));
    await db
      .update(creditBuckets)
      .set({ origin: 'legacy' })
      .where(eq(creditBuckets.id, l0Bucket!.id));

    const result = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));

    expect(result).toBeNull();
    const expiryLegs = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.idempotencyKey, l0ExpireKey(u)));
    const [unchangedBucket] = await db
      .select({ granted: creditBuckets.granted })
      .from(creditBuckets)
      .where(eq(creditBuckets.id, l0Bucket!.id));
    expect(expiryLegs).toHaveLength(0);
    expect(unchangedBucket).toEqual({ granted: l0Bucket!.granted });
  });

  it('refunds a purchased pack before expiry, then still expires the full L0', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await credits.grant({
      userId: u,
      amount: 200,
      account: 'pack_grant',
      reason: 'pack.purchase',
      sourceOrderId: `order:${u}`,
      idempotencyKey: `pack:${nid()}`,
    });
    await credits.clawback({
      userId: u,
      amount: 200,
      reason: 'payment.refund.clawback',
      sourceOrderId: `order:${u}`,
      idempotencyKey: `refund:${nid()}`,
    });

    const res = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));

    expect(res).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 });
    expect((await credits.balanceFor(u)).available).toBe(0);
  });

  it('does not over-claw L0 when a support refund-account grant is present', async () => {
    const u = await newUser();
    await welcome.grantL0({ userId: u, clusterKey: freshCluster() });
    await credits.grant({
      userId: u,
      amount: 100,
      account: 'refund',
      reason: 'support.refund',
      idempotencyKey: `support-refund:${nid()}`,
    });

    const res = await db.transaction((tx) => welcome.expireL0ForUser(u, tx));

    expect(res).toMatchObject({ clawedBack: WELCOME_GRANT_AMOUNTS.L0 });
    expect((await credits.balanceFor(u)).available).toBe(100);
  });
});
