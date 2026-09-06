import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// This suite needs free-grants ON for every case, and the shared
// free_grants_enabled app-settings row races the parallel packages/credits
// welcome suite (which flips it OFF and even deletes the row for its own
// fail-closed case). Mock the settings module at its PHYSICAL path — what
// packages/credits/src/welcome.ts imports directly — for this process only.
vi.mock('../../../packages/credits/src/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../packages/credits/src/settings')>();
  return {
    ...actual,
    readBoolFlag: async (key: string, fallback = false) =>
      key === 'free_grants_enabled' ? true : fallback,
  };
});
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { WelcomeGrantService, clusterKeyFor, dailyLevelFor, grantKey } from '@seed/credits';
import {
  creditTransactions,
  db,
  freeClusters,
  freeGrantEvents,
  nid,
  pool,
  usersApp,
  usersPii,
} from '@seed/db';
import { runWelcomeProgression } from '../src/welcome-progression';
import { welcomeMetricLevel } from '../src/welcome-metrics';

const createdUsers: string[] = [];
const createdClusters: string[] = [];

async function makeUser(): Promise<{ id: string; email: string }> {
  const id = nid();
  const email = `welcome-progression+${id}@seed.local`;
  await db.insert(usersApp).values({ id, displayName: 'Welcome progression test', locale: 'ru' });
  await db.insert(usersPii).values({ id, email });
  createdUsers.push(id);
  return { id, email };
}

function freshCluster(): string {
  const cluster = clusterKeyFor(`device-${nid()}`, `203.0.113.${createdClusters.length + 1}`);
  createdClusters.push(cluster);
  return cluster;
}

async function setL0GrantedAt(userId: string, createdAt: Date): Promise<void> {
  await db
    .update(creditTransactions)
    .set({ createdAt })
    .where(eq(creditTransactions.idempotencyKey, grantKey(userId, 'L0')));
}

async function buildMeApp(input: {
  welcome: WelcomeGrantService;
  userId: string;
  email: string;
  clusterKey: string;
}) {
  const app = Fastify({ logger: false });
  app.get('/v1/me', async () => {
    await runWelcomeProgression({
      welcome: input.welcome,
      userId: input.userId,
      clusterKey: input.clusterKey,
      sourceIp: '203.0.113.7',
      email: input.email,
      captchaToken: undefined,
      phoneHash: null,
      record: () => {},
      onError: () => {},
    });
    return { ok: true };
  });
  await app.ready();
  return app;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const userId of createdUsers) await db.delete(usersApp).where(eq(usersApp.id, userId));
  createdUsers.length = 0;
  if (createdClusters.length > 0) {
    await db.delete(freeClusters).where(inArray(freeClusters.clusterKey, createdClusters));
    createdClusters.length = 0;
  }
});

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/me welcome progression', () => {
  it('collapses dynamic daily levels before they reach Prometheus labels', () => {
    expect(welcomeMetricLevel('DAILY:2020-07-18')).toBe('DAILY');
    expect(welcomeMetricLevel('L0')).toBe('L0');
  });

  it('issues exactly one daily grant across two concurrent /v1/me requests', async () => {
    const user = await makeUser();
    const clusterKey = freshCluster();
    const welcome = new WelcomeGrantService();
    await welcome.grantL0({ userId: user.id, clusterKey });
    await setL0GrantedAt(user.id, new Date('2020-07-17T09:00:00.000Z'));
    const now = new Date('2020-07-18T09:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const app = await buildMeApp({ welcome, userId: user.id, email: user.email, clusterKey });
    try {
      const responses = await Promise.all([
        app.inject({ method: 'GET', url: '/v1/me' }),
        app.inject({ method: 'GET', url: '/v1/me' }),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
      const rows = await db
        .select()
        .from(freeGrantEvents)
        .where(eq(freeGrantEvents.level, dailyLevelFor(now)));
      expect(rows.filter((row) => row.userId === user.id)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('still issues the daily grant when L1 throws during /v1/me progression', async () => {
    const user = await makeUser();
    const clusterKey = freshCluster();
    const welcome = new WelcomeGrantService();
    await welcome.grantL0({ userId: user.id, clusterKey });
    await setL0GrantedAt(user.id, new Date('2020-07-17T09:00:00.000Z'));
    const now = new Date('2020-07-18T09:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(welcome, 'grantL1').mockRejectedValue(new Error('L1 unavailable'));
    const app = await buildMeApp({ welcome, userId: user.id, email: user.email, clusterKey });
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
      const rows = await db
        .select()
        .from(freeGrantEvents)
        .where(eq(freeGrantEvents.level, dailyLevelFor(now)));
      expect(rows.filter((row) => row.userId === user.id)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
