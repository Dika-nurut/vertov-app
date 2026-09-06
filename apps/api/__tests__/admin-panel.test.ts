import 'dotenv/config';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import {
  assistTierStates,
  auditLog,
  creditBuckets,
  creditTransactions,
  db,
  galleryItems,
  jobs,
  models,
  nid,
  GATEWAY_FX_RUB,
  marketingAttribution,
  orders,
  pool,
  resolveUserPlanTier,
  subscriptions,
  subscriptionsCatalog,
  usersApp,
  usersPii,
  workflows,
} from '@seed/db';
import { creditService } from '@seed/credits';
import { setupAdminPanelRoutes } from '../src/admin-panel';
import { invalidateAssistTierStates } from '../src/assist-tier-state';

// Env the balances endpoint would otherwise turn into LIVE provider calls —
// cleared per test so no network happens; ?fresh=1 bypasses the 2-min module
// cache so each variant recomputes the route.
const BALANCE_ENV = [
  'OPENROUTER_API_KEY',
  'KIE_API_KEY',
  'KIE_MODE',
  'KIE_CHAT_DISABLED',
  'LAOZHANG_ACCESS_TOKEN',
  'LAOZHANG_API_KEY',
  'ATLASCLOUD_API_KEY',
] as const;
function withBalanceEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of BALANCE_ENV) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k];
  return fn().finally(() => {
    for (const key of BALANCE_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

// A priced video model that exists in the seed (cpu=70 credits, $0.10/unit) — used for
// the margin math. creditRubFloor derives from the live catalog = the cheapest ₽/cr among
// every tier, including the deactivated legacy plan whose credits remain spendable.
const PRICED_MODEL = 'veo-3-1-fast';
const CREDIT_RUB_FLOOR = 1490 / 4500; // 0.331…

const createdUsers: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'PanelTest', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `panel+${id}@panel.test` });
  createdUsers.push(id);
  return id;
}

async function makeSucceededJob(
  userId: string,
  modelId: string,
  creditsSpent: number,
  opts: {
    startedAt?: Date;
    finishedAt?: Date;
    creditUnitCost?: number;
    gatewayUsed?: string;
    fallbackDepth?: number;
  } = {},
): Promise<string> {
  const wId = nid();
  const jId = nid();
  await db.insert(workflows).values({ id: wId, userId, modelId, params: {}, referenceAssets: [] });
  const finishedAt = opts.finishedAt ?? new Date();
  const startedAt = opts.startedAt ?? new Date(finishedAt.getTime() - 5_000);
  await db.insert(jobs).values({
    id: jId,
    userId,
    workflowId: wId,
    modelId,
    status: 'succeeded',
    creditsReserved: creditsSpent,
    creditsSpent,
    creditUnitCost: opts.creditUnitCost ?? null,
    gatewayUsed: opts.gatewayUsed ?? null,
    usedFallback: (opts.fallbackDepth ?? 0) > 0,
    fallbackDepth: opts.fallbackDepth ?? null,
    startedAt,
    finishedAt,
    idempotencyKey: `panel-${jId}`,
  });
  return jId;
}

/**
 * A throwaway priced image model, so the margin assertions below see EXACTLY the
 * jobs this spec created (the shared DB carries jobs on the real catalogue rows).
 * $0.05/unit on the primary leg, $0.08 on the first fallback, nothing recorded
 * for anything deeper — the real shape of a nanobanana-style chain.
 */
const LEG_MODEL = 'admin-panel-leg-cost';
const LEG_MODEL_UNIT_CREDITS = 33;
async function makeLegCostModel(): Promise<void> {
  await db
    .insert(models)
    .values({
      id: LEG_MODEL,
      provider: 'byteplus',
      family: 'legtest',
      variant: 'chain',
      kind: 'image',
      isActive: false,
      unitKind: 'image',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 2000,
      providerModelId: 'legtest-chain',
      providerEndpoint: '/v1/images',
      capabilities: { priceUsdPerUnit: 0.05, fallbackUsdPerUnit: 0.08 },
    })
    .onConflictDoNothing();
}

/** Build an app whose session is `userId`, with `admins` on the allowlist. */
function appFor(userId: string, admins: string[]): ReturnType<typeof Fastify> {
  process.env.ADMIN_USER_IDS = admins.join(',');
  const app = Fastify({ logger: false });
  setupAdminPanelRoutes(app, async () => ({ user: { id: userId } }));
  return app;
}

async function getJson(
  app: ReturnType<typeof Fastify>,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  payload?: unknown,
) {
  const res = await app.inject({ method, url, payload: payload as object });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.statusCode, body };
}

afterEach(async () => {
  for (const id of createdUsers) {
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(orders).where(eq(orders.userId, id));
    await db.delete(marketingAttribution).where(eq(marketingAttribution.userId, id));
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(auditLog).where(eq(auditLog.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  createdUsers.length = 0;
  await db.delete(models).where(eq(models.id, LEG_MODEL));
  delete process.env.ADMIN_USER_IDS;
});
afterAll(async () => {
  await pool.end();
});

describe('admin panel: auth gate', () => {
  it('/v1/admin/me reports isAdmin=false for a non-admin (no 403)', async () => {
    const u = await makeUser();
    const app = appFor(u, ['someone-else']);
    await app.ready();
    const { status, body } = await getJson(app, '/v1/admin/me');
    expect(status).toBe(200);
    expect(body).toMatchObject({ userId: u, isAdmin: false });
    await app.close();
  });

  it('/v1/admin/me reports isAdmin=true for an allowlisted admin', async () => {
    const u = await makeUser();
    const app = appFor(u, [u]);
    await app.ready();
    const { body } = await getJson(app, '/v1/admin/me');
    expect(body).toMatchObject({ isAdmin: true });
    await app.close();
  });

  it('data routes 403 a non-admin', async () => {
    const u = await makeUser();
    const app = appFor(u, ['someone-else']);
    await app.ready();
    for (const url of [
      '/v1/admin/cockpit',
      '/v1/admin/generation',
      '/v1/admin/audit',
      '/v1/admin/provider-balances',
    ]) {
      const { status } = await getJson(app, url);
      expect(status, url).toBe(403);
    }
    await app.close();
  });
});

describe('admin panel: cockpit + margin', () => {
  it('reflects paid revenue, MRR by tier, and internally-consistent per-model margin', async () => {
    const admin = await makeUser();
    const customer = await makeUser();

    // A paid order + an active subscription + a succeeded priced job.
    await db.insert(orders).values({
      id: nid(),
      userId: customer,
      kind: 'subscription',
      tierOrPackId: 'creator',
      amountRub: 1490,
      psp: 'yookassa',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await db.insert(orders).values({
      id: nid(),
      userId: customer,
      kind: 'pack',
      tierOrPackId: 'pack-refund',
      amountRub: 120,
      psp: 'yookassa',
      ourStatus: 'refunded',
      refundedAt: new Date(),
    });
    await db.insert(subscriptions).values({
      id: nid(),
      userId: customer,
      tier: 'creator',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      priceRub: 1490,
      creditsPerCycle: 4500,
    });
    await makeSucceededJob(customer, PRICED_MODEL, 70); // 1 unit

    const app = appFor(admin, [admin]);
    await app.ready();
    const { status, body } = await getJson(app, '/v1/admin/cockpit');
    expect(status).toBe(200);
    const c = body as any;

    // Revenue is global (shared DB) — assert it INCLUDES my order, not an exact total.
    expect(c.revenue.psp).toBe('yookassa');
    expect(c.revenue.grossRub).toBeGreaterThanOrEqual(1490);
    expect(c.revenue.sbpSplit).toBeNull();

    // MRR: the creator tier row includes my ₽1490 active sub.
    const creatorTier = c.subscriptions.byTier.find((t: any) => t.tier === 'creator');
    expect(creatorTier).toBeTruthy();
    expect(creatorTier.mrrRub).toBeGreaterThanOrEqual(1490);
    expect(c.subscriptions.arrRub).toBe(c.subscriptions.mrrRub * 12);

    // This legacy video job has no persisted reserve-time unit cost. It must not
    // recover units from the current mutable catalogue rate, so its COGS and
    // margin are intentionally unavailable rather than reported as 100%.
    // Asserted against the ladder export, never against a literal. This line USED
    // to carry the pair as digits, and so it pinned the panel to a retired FX basis
    // and turned a stale copy into a passing test.
    expect(c.margin.usdToRub).toEqual({
      direct: GATEWAY_FX_RUB.direct,
      openrouter: GATEWAY_FX_RUB.openrouter,
    });
    expect(c.margin.creditRubValue).toBeCloseTo(CREDIT_RUB_FLOOR, 3);
    const row = c.margin.perModel.find((m: any) => m.modelId === PRICED_MODEL);
    const [catalogueModel] = await db
      .select({
        family: models.family,
        variant: models.variant,
        displayName: models.displayName,
      })
      .from(models)
      .where(eq(models.id, PRICED_MODEL))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.model).toEqual(catalogueModel);
    expect(row.priced).toBe(false);
    expect(row.approximate).toBe(true);
    expect(c.margin.blended.approximate).toBe(false);
    expect(row.revenueRub).toBe(Math.round(row.creditsSpent * CREDIT_RUB_FLOOR));
    expect(row.costRub).toBeNull();
    expect(row.marginPct).toBeNull();
    await app.close();
  });

  it('marks historical jobs UNKNOWN when the exact workbook configuration is absent', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    await makeLegCostModel();

    // Three identical jobs, served by three different legs of a model that is
    // intentionally absent from the signed workbook. The report must not infer
    // COGS from the legacy capability scalars or from the gateway name alone.
    await makeSucceededJob(customer, LEG_MODEL, LEG_MODEL_UNIT_CREDITS, {
      creditUnitCost: LEG_MODEL_UNIT_CREDITS,
      gatewayUsed: 'laozhang',
      fallbackDepth: 0,
    });
    await makeSucceededJob(customer, LEG_MODEL, LEG_MODEL_UNIT_CREDITS, {
      creditUnitCost: LEG_MODEL_UNIT_CREDITS,
      gatewayUsed: 'kie',
      fallbackDepth: 1,
    });
    // The leg the report used to price at the primary's $0.05 while it actually
    // bills ~2.7x that. No figure exists for it anywhere → UNKNOWN, out of the total.
    await makeSucceededJob(customer, LEG_MODEL, LEG_MODEL_UNIT_CREDITS, {
      creditUnitCost: LEG_MODEL_UNIT_CREDITS,
      gatewayUsed: 'openrouter-official',
      fallbackDepth: 2,
    });

    const app = appFor(admin, [admin]);
    await app.ready();
    const { body } = await getJson(app, '/v1/admin/cockpit');
    const c = body as any;
    const row = c.margin.perModel.find((m: any) => m.modelId === LEG_MODEL);

    const creditRub = c.margin.creditRubValue;
    expect(row.jobs).toBe(3);
    expect(row.priced).toBe(false);
    expect(row.costRub).toBeNull();
    expect(row.marginPct).toBeNull();
    // No exact workbook rung/mode/reference is persisted on these historical
    // jobs, so every leg remains explicitly UNKNOWN rather than being valued at
    // the model's old $0.05/$0.08 capability fields.
    expect(row.costUnknown).toEqual({
      jobs: 3,
      revenueRub: Math.round(3 * LEG_MODEL_UNIT_CREDITS * creditRub),
      legs: ['kie@1', 'laozhang@0', 'openrouter-official@2'],
    });
    expect(c.margin.blended.costUnknownJobs).toBeGreaterThanOrEqual(3);
    await app.close();
  });

  it('a trialing sub counts toward subscribers + trialingCount but NOT toward MRR', async () => {
    const admin = await makeUser();
    const trialUser = await makeUser();
    // Snapshot MRR, add a trialing sub, re-read: MRR must not move (trials pay nothing),
    // but the trialing counter must reflect it. Two reads back-to-back so an interleaved
    // trialing insert from another file can't perturb the delta (trials add 0 to MRR by
    // definition — the property under test).
    const app = appFor(admin, [admin]);
    await app.ready();
    const before = (await getJson(app, '/v1/admin/cockpit')).body as any;

    await db.insert(subscriptions).values({
      id: nid(),
      userId: trialUser,
      tier: 'start',
      status: 'trialing',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
      priceRub: 490,
      creditsPerCycle: 1200,
    });

    const after = (await getJson(app, '/v1/admin/cockpit')).body as any;
    expect(after.subscriptions.trialingCount).toBeGreaterThanOrEqual(
      before.subscriptions.trialingCount + 1,
    );
    expect(after.subscriptions.activeCount).toBeGreaterThanOrEqual(
      before.subscriptions.activeCount + 1,
    );
    // Had trials been (wrongly) counted, my 490₽ trial alone would push MRR to
    // ≥ before+490 deterministically; excluded, it adds 0. (< before+490 tolerates
    // unrelated concurrent activity while still catching the regression.)
    expect(after.subscriptions.mrrRub).toBeLessThan(before.subscriptions.mrrRub + 490);
    await app.close();
  });
});

describe('admin panel: generation analytics', () => {
  it('returns success-rate and latency rows, flags preset as unavailable, and tallies fallback usage', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    await makeSucceededJob(customer, PRICED_MODEL, 70, {
      startedAt: new Date(Date.now() - 10_000),
      finishedAt: new Date(),
    });

    const app = appFor(admin, [admin]);
    await app.ready();
    const { status, body } = await getJson(app, '/v1/admin/generation');
    expect(status).toBe(200);
    const g = body as any;

    expect(Array.isArray(g.daily)).toBe(true);
    expect(Array.isArray(g.successRate)).toBe(true);
    const lat = g.latency.find((l: any) => l.modelId === PRICED_MODEL);
    const [catalogueModel] = await db
      .select({
        family: models.family,
        variant: models.variant,
        displayName: models.displayName,
      })
      .from(models)
      .where(eq(models.id, PRICED_MODEL))
      .limit(1);
    expect(lat).toBeTruthy();
    expect(lat.model).toEqual(catalogueModel);
    expect(lat.p50Ms).toBeGreaterThan(0);
    expect(lat.expectedP50Ms).toBeGreaterThan(0);

    expect(g.presetLeaderboard.available).toBe(false);
    expect(g.fallback.available).toBe(true);
    expect(g.fallback.total).toBeGreaterThanOrEqual(1);
    expect(g.fallback.fellBack).toBe(0);
    await app.close();
  });
});

describe('admin panel: growth funnel', () => {
  it('counts signup → activated → paid monotonically and reflects my seeded user', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    await makeSucceededJob(customer, PRICED_MODEL, 70);
    await db.insert(orders).values({
      id: nid(),
      userId: customer,
      kind: 'pack',
      tierOrPackId: 'pack-x',
      amountRub: 500,
      psp: 'yookassa',
      ourStatus: 'paid',
      paidAt: new Date(),
    });
    await db.insert(orders).values({
      id: nid(),
      userId: customer,
      kind: 'pack',
      tierOrPackId: 'pack-refund',
      amountRub: 120,
      psp: 'yookassa',
      ourStatus: 'refunded',
      refundedAt: new Date(),
    });

    const app = appFor(admin, [admin]);
    await app.ready();
    const { status, body } = await getJson(app, '/v1/admin/funnel');
    expect(status).toBe(200);
    const f = body as any;
    const counts = new Map(f.steps.map((s: any) => [s.key, s.count]));
    const signup = counts.get('signup');
    const attempted = counts.get('attempted');
    const activated = counts.get('activated');
    const paid = counts.get('paid');
    expect(signup).toBeGreaterThanOrEqual(2); // admin + customer created just now
    expect(attempted).toBeGreaterThanOrEqual(1);
    expect(activated).toBeLessThanOrEqual(signup);
    expect(paid).toBeLessThanOrEqual(activated);
    expect(paid).toBeGreaterThanOrEqual(1); // my customer paid + generated
    expect(f.landingVisit.available).toBe(false);
    expect(f.cohorts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'organic',
          signups: expect.any(Number),
          attempted: expect.any(Number),
          activated: expect.any(Number),
          wowVideo: expect.any(Number),
          paid: expect.any(Number),
          revenueRub: expect.any(Number),
          refundedRub: expect.any(Number),
          retention: { d1: expect.any(Number), d7: expect.any(Number), d30: expect.any(Number) },
        }),
      ]),
    );
    const cohort = f.cohorts.find((row: any) => row.channel === 'organic');
    expect(cohort.signups).toBeGreaterThanOrEqual(2);
    expect(cohort.activated).toBeGreaterThanOrEqual(1);
    expect(cohort.wowVideo).toBeGreaterThanOrEqual(1);
    expect(cohort.paid).toBeGreaterThanOrEqual(1);
    expect(cohort.revenueRub).toBeGreaterThanOrEqual(500);
    expect(cohort.refundedRub).toBeGreaterThanOrEqual(120);
    await app.close();
  });
});

describe('admin panel: model catalog', () => {
  it('lists models with computed margin at the credit floor', async () => {
    const admin = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const { status, body } = await getJson(app, '/v1/admin/models');
    expect(status).toBe(200);
    const b = body as any;
    expect(b.usdToRub).toEqual({
      direct: GATEWAY_FX_RUB.direct,
      openrouter: GATEWAY_FX_RUB.openrouter,
    });
    const row = b.rows.find((r: any) => r.id === PRICED_MODEL);
    expect(row).toBeTruthy();
    expect(row.priceUsdPerUnit).toBeGreaterThan(0);
    expect(row.marginPct).toBeGreaterThan(0); // priced row has a real margin
    const unpriced = b.rows.find((r: any) => r.priceUsdPerUnit == null);
    expect(unpriced?.marginPct ?? null).toBeNull(); // unpriced → no margin
    expect(Array.isArray(b.gateways)).toBe(true);
    expect(b.gateways).toContain('openrouter');
    expect(typeof row.effectiveGateway).toBe('string');
    // veo-3-1-fast is pinned to kie (gatewayOverride, 2026-07-19) — the routing flip
    // that makes its parametric price clear break-even on the cheap kie leg.
    expect(row.gatewayOverride).toBe('kie');
    expect(row.effectiveGateway).toBe('kie');
    await app.close();
  });
});

describe('admin panel: model gateway/fallback switches (audited)', () => {
  it('refuses a loss-making gateway change with per-rung leg diagnostics', async () => {
    const admin = await makeUser();
    const [before] = await db
      .select()
      .from(models)
      .where(eq(models.id, 'grok-imagine-video'))
      .limit(1);
    const app = appFor(admin, [admin]);
    await app.ready();
    try {
      const { status, body } = await getJson(app, '/v1/admin/models/grok-imagine-video', 'PATCH', {
        gatewayOverride: 'openrouter',
      });
      expect(status).toBe(409);
      expect(body).toEqual({
        error: 'gateway_margin_guard',
        message:
          'Gateway change refused: an executable leg is below its margin floor or has no recorded cost. ' +
          'Use force:true with forceReason to accept an explicit exception.',
        modelId: 'grok-imagine-video',
        floorRub: expect.any(Number),
        // The old number came from the legacy ladder's OpenRouter Grok rate. The signed
        // export has no such leg, so refusing it as uncosted is the intended R-2 behavior.
        violations: expect.arrayContaining([
          expect.objectContaining({
            rung: expect.objectContaining({ resolution: '720p' }),
            leg: 'primary',
            gateway: 'openrouter',
            reason: 'uncosted',
            marginPct: null,
            floorPct: 25,
            shortfallPct: null,
          }),
        ]),
        override: { field: 'force', reasonField: 'forceReason' },
      });
    } finally {
      await db
        .update(models)
        .set({ gatewayOverride: before!.gatewayOverride, fallbackGateway: before!.fallbackGateway })
        .where(eq(models.id, 'grok-imagine-video'));
      await app.close();
    }
  });

  it('requires a reason and audit-logs the accepted margin when force overrides the guard', async () => {
    const admin = await makeUser();
    const [before] = await db
      .select()
      .from(models)
      .where(eq(models.id, 'grok-imagine-video'))
      .limit(1);
    const app = appFor(admin, [admin]);
    await app.ready();
    try {
      const missingReason = await getJson(app, '/v1/admin/models/grok-imagine-video', 'PATCH', {
        gatewayOverride: 'openrouter',
        force: true,
      });
      expect(missingReason.status).toBe(400);

      const forced = await getJson(app, '/v1/admin/models/grok-imagine-video', 'PATCH', {
        gatewayOverride: 'openrouter',
        force: true,
        forceReason: 'Documented loss-leader experiment',
      });
      expect(forced.status).toBe(200);
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.model_update')))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect((audit[0]!.payload as any).gatewayMarginOverride).toMatchObject({
        reason: 'Documented loss-leader experiment',
        // The old number came from the legacy ladder's OpenRouter Grok rate. The signed
        // export has no such leg, so the forced audit records an uncosted R-2 exception.
        accepted: expect.arrayContaining([
          expect.objectContaining({
            rung: expect.objectContaining({ resolution: '720p' }),
            leg: 'primary',
            gateway: 'openrouter',
            reason: 'uncosted',
            marginPct: null,
            shortfallPct: null,
          }),
        ]),
      });
    } finally {
      await db
        .update(models)
        .set({ gatewayOverride: before!.gatewayOverride, fallbackGateway: before!.fallbackGateway })
        .where(eq(models.id, 'grok-imagine-video'));
      await app.close();
    }
  });

  it('patches gatewayOverride + fallbackGateway, writes an audit row, and rejects an unknown gateway', async () => {
    const admin = await makeUser();
    const [before] = await db.select().from(models).where(eq(models.id, PRICED_MODEL)).limit(1);

    const app = appFor(admin, [admin]);
    await app.ready();
    try {
      const { status, body } = await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {
        gatewayOverride: 'atlascloud',
        fallbackGateway: 'openrouter',
        force: true,
        forceReason: 'Existing switch-path audit fixture',
      });
      expect(status).toBe(200);
      const b = body as any;
      expect(b.model.gatewayOverride).toBe('atlascloud');
      expect(b.model.fallbackGateway).toBe('openrouter');

      const { status: listStatus, body: listBody } = await getJson(app, '/v1/admin/models');
      expect(listStatus).toBe(200);
      const row = (listBody as any).rows.find((r: any) => r.id === PRICED_MODEL);
      expect(row.effectiveGateway).toBe('atlascloud'); // override wins

      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.model_update')))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect((audit[0]!.payload as any).after.gatewayOverride).toBe('atlascloud');
      expect((audit[0]!.payload as any).after.fallbackGateway).toBe('openrouter');
      expect((audit[0]!.payload as any).gatewayMarginOverride).toMatchObject({
        reason: 'Existing switch-path audit fixture',
        floorRub: expect.any(Number),
        accepted: expect.arrayContaining([
          expect.objectContaining({
            reason: expect.any(String),
          }),
        ]),
      });

      const bad = await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {
        gatewayOverride: 'not-a-real-gateway',
      });
      expect(bad.status).toBe(400);

      // Clearing back to null (auto/no fallback) is a valid, distinct patch.
      const cleared = await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {
        gatewayOverride: null,
        fallbackGateway: null,
        force: true,
        forceReason: 'Restore the seeded route',
      });
      expect(cleared.status).toBe(200);
      expect((cleared.body as any).model.gatewayOverride).toBeNull();
    } finally {
      await db
        .update(models)
        .set({ gatewayOverride: before!.gatewayOverride, fallbackGateway: before!.fallbackGateway })
        .where(eq(models.id, PRICED_MODEL));
      await app.close();
    }
  });
});

describe('admin panel: model switches (audited)', () => {
  it('patches isActive and audits before/after without the legacy cost ceiling', async () => {
    const admin = await makeUser();
    const [before] = await db.select().from(models).where(eq(models.id, PRICED_MODEL)).limit(1);
    const originalActive = before!.isActive;

    const app = appFor(admin, [admin]);
    await app.ready();
    try {
      // The legacy creditCostPerUnit column is GONE: a patch carrying it must be
      // refused by the schema (workbook price points are the only money gate),
      // while a plain isActive flip still audits before/after.
      const rejected = await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {
        creditCostPerUnit: 1,
      });
      expect(rejected.status).toBe(400);

      const { status, body } = await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {
        isActive: false,
      });
      expect(status).toBe(200);
      const b = body as any;
      expect(b.ok).toBe(true);
      expect(b.model.isActive).toBe(false);
      expect(b.marginWarning).toBeNull();

      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.model_update')));
      expect(audit).toHaveLength(1);
      expect((audit[0]!.payload as any).before.isActive).toBe(originalActive);
      expect((audit[0]!.payload as any).after.isActive).toBe(false);
    } finally {
      // Restore shared seed data no matter what.
      await db.update(models).set({ isActive: originalActive }).where(eq(models.id, PRICED_MODEL));
      await app.close();
    }
  });

  it('rejects an empty patch (400) and a missing model (404)', async () => {
    const admin = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    expect((await getJson(app, `/v1/admin/models/${PRICED_MODEL}`, 'PATCH', {})).status).toBe(400);
    expect(
      (await getJson(app, '/v1/admin/models/does-not-exist', 'PATCH', { isActive: true })).status,
    ).toBe(404);
    await app.close();
  });
});

describe('admin panel: support ops', () => {
  it('looks up a user by email substring and returns detail with derived balance', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    await makeSucceededJob(customer, PRICED_MODEL, 70);

    const app = appFor(admin, [admin]);
    await app.ready();

    // Lookup by exact id.
    const lookup = await getJson(app, `/v1/admin/users?q=${customer}`);
    expect(lookup.status).toBe(200);
    expect((lookup.body as any).rows.some((r: any) => r.id === customer)).toBe(true);

    // Detail.
    const detail = await getJson(app, `/v1/admin/users/${customer}`);
    expect(detail.status).toBe(200);
    const d = detail.body as any;
    expect(d.user.id).toBe(customer);
    expect(d.contact.email).toContain('@panel.test');
    expect(d.balance).toHaveProperty('available');
    expect(Array.isArray(d.recentJobs)).toBe(true);
    expect(d.recentJobs.length).toBeGreaterThanOrEqual(1);
    const recentJob = d.recentJobs.find((job: any) => job.modelId === PRICED_MODEL);
    const [catalogueModel] = await db
      .select({
        family: models.family,
        variant: models.variant,
        displayName: models.displayName,
      })
      .from(models)
      .where(eq(models.id, PRICED_MODEL))
      .limit(1);
    expect(recentJob.model).toEqual(catalogueModel);
    expect(Array.isArray(d.linkedAccounts)).toBe(true);

    expect((await getJson(app, '/v1/admin/users/nope')).status).toBe(404);
    await app.close();
  });

  it('grants credits, updates the derived balance, and writes an audit row', async () => {
    const admin = await makeUser();
    const customer = await makeUser();

    const app = appFor(admin, [admin]);
    await app.ready();
    const { status, body } = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', {
      amount: 250,
      reason: 'goodwill for a failed render',
      account: 'refund',
    });
    expect(status).toBe(200);
    expect((body as any).balance.available).toBe(250);

    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.credit_grant')));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.payload as any).targetUserId).toBe(customer);
    expect((audit[0]!.payload as any).amount).toBe(250);

    // Audit viewer surfaces it.
    const view = await getJson(app, '/v1/admin/audit?action=admin.credit_grant');
    expect((view.body as any).rows.some((r: any) => r.userId === admin)).toBe(true);
    await app.close();
  });

  it('a repeated grant with the same idempotencyKey does NOT double-credit', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const key = `retry-${nid()}`;
    const payload = {
      amount: 300,
      reason: 'lost-response retry',
      account: 'refund',
      idempotencyKey: key,
    };
    const first = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', payload);
    const second = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as any).outcome).toBe('granted');
    expect((second.body as any).outcome).toBe('replayed');
    // Balance reflects a SINGLE grant, not two.
    expect((second.body as any).balance.available).toBe(300);
    // And only one credit_transactions row landed for this user.
    const txns = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, customer));
    expect(txns).toHaveLength(1);
    const scopedKey = `admin:grant:${customer}:${key}`;
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.credit_grant')));
    const replayAudits = audits.filter(
      (audit) => (audit.payload as any).idempotencyKey === scopedKey,
    );
    expect(replayAudits.map((audit) => (audit.payload as any).outcome).sort()).toEqual([
      'granted',
      'replayed',
    ]);
    await app.close();
  });

  it('scopes a supplied grant key to its target user so both grants land', async () => {
    const admin = await makeUser();
    const firstCustomer = await makeUser();
    const secondCustomer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const suppliedKey = `same-key-${nid()}`;
    const payload = {
      amount: 300,
      reason: 'two independent support grants',
      account: 'refund',
      idempotencyKey: suppliedKey,
    };

    const first = await getJson(app, `/v1/admin/users/${firstCustomer}/credits`, 'POST', payload);
    const second = await getJson(app, `/v1/admin/users/${secondCustomer}/credits`, 'POST', payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as any).outcome).toBe('granted');
    expect((second.body as any).outcome).toBe('granted');
    expect((await creditService.balanceFor(firstCustomer)).available).toBe(300);
    expect((await creditService.balanceFor(secondCustomer)).available).toBe(300);
    await app.close();
  });

  it('reports a changed same-user grant as an idempotency conflict', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const idempotencyKey = `conflict-${nid()}`;
    const first = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', {
      amount: 300,
      reason: 'first support grant',
      account: 'refund',
      idempotencyKey,
    });
    const conflict = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', {
      amount: 301,
      reason: 'changed support grant',
      account: 'refund',
      idempotencyKey,
    });
    expect(first.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'idempotency_key_conflict' });
    expect((await creditService.balanceFor(customer)).available).toBe(300);
    await app.close();
  });

  it('a legacy grant without a key derives a stable key and does NOT double-credit on retry', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const payload = {
      amount: 175,
      reason: 'legacy lost-response retry',
      account: 'refund' as const,
    };
    const first = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', payload);
    const second = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as any).balance.available).toBe(175);
    const txns = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.userId, customer));
    expect(txns).toHaveLength(1);
    expect(txns[0]!.idempotencyKey).toMatch(/^legacy:admin:grant:[a-f0-9]{64}$/);
    await app.close();
  });

  it('rejects a bad grant (negative amount) with 400', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    const { status } = await getJson(app, `/v1/admin/users/${customer}/credits`, 'POST', {
      amount: -5,
      reason: 'nope',
    });
    expect(status).toBe(400);
    await app.close();
  });

  it('creates a comped subscription without an order or users_app.tier write', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const [catalog] = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, 'plus'))
      .limit(1);
    expect(catalog).toBeTruthy();
    const assetId = nid();
    await db.insert(galleryItems).values({
      id: assetId,
      userId: customer,
      assetUrl: `https://assets.seed.test/${assetId}.png`,
      kind: 'image',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const app = appFor(admin, [admin]);
    await app.ready();

    const created = await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'plus',
    });
    expect(created.status).toBe(201);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, customer));
    expect(sub).toMatchObject({
      tier: 'plus',
      status: 'active',
      cancelAtPeriodEnd: true,
      cycleNumber: 1,
      priceRub: catalog!.priceRub,
      creditsPerCycle: catalog!.creditsPerCycle,
    });
    expect(sub!.currentPeriodEnd.getTime()).toBeGreaterThan(sub!.currentPeriodStart.getTime());
    expect(
      (
        await db
          .select({ expiresAt: galleryItems.expiresAt })
          .from(galleryItems)
          .where(eq(galleryItems.id, assetId))
      )[0]!.expiresAt,
    ).toBeNull();
    // Money invariants: comping is not revenue and the dead plan column is never touched.
    expect(await db.select().from(orders).where(eq(orders.userId, customer))).toHaveLength(0);
    const [user] = await db
      .select({ tier: usersApp.tier })
      .from(usersApp)
      .where(eq(usersApp.id, customer));
    expect(user!.tier).toBe('free');
    expect(
      await db.select().from(creditTransactions).where(eq(creditTransactions.userId, customer)),
    ).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.subscription_create')));
    expect((audit!.payload as any).targetUserId).toBe(customer);
    expect((audit!.payload as any).after.tier).toBe('plus');
    await app.close();
  });

  it('optionally grants a comped cycle into a bucket expiring with its period', async () => {
    const admin = await makeUser();
    const withGrant = await makeUser();
    const withoutGrant = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();

    expect(
      (
        await getJson(app, `/v1/admin/users/${withGrant}/subscription`, 'POST', {
          tier: 'start',
          grantCycleCredits: true,
        })
      ).status,
    ).toBe(201);
    const [grantedSub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, withGrant));
    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, withGrant));
    expect(bucket).toMatchObject({
      origin: 'subscription',
      relatedSubscriptionId: grantedSub!.id,
      cycleNumber: 1,
      granted: grantedSub!.creditsPerCycle,
    });
    expect(bucket!.expiresAt!.getTime()).toBe(grantedSub!.currentPeriodEnd.getTime());

    expect(
      (
        await getJson(app, `/v1/admin/users/${withoutGrant}/subscription`, 'POST', {
          tier: 'start',
        })
      ).status,
    ).toBe(201);
    expect(
      await db.select().from(creditBuckets).where(eq(creditBuckets.userId, withoutGrant)),
    ).toHaveLength(0);
    await app.close();
  });

  it('refuses creating a second lifecycle subscription', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    expect(
      (await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', { tier: 'start' }))
        .status,
    ).toBe(201);
    const second = await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'pro',
    });
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'already_subscribed' });
    await app.close();
  });

  it('changes only the subscription tier snapshots and grants no credits', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const [catalog] = await db
      .select()
      .from(subscriptionsCatalog)
      .where(eq(subscriptionsCatalog.tier, 'studio'))
      .limit(1);
    const app = appFor(admin, [admin]);
    await app.ready();
    await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', { tier: 'start' });
    const changed = await getJson(app, `/v1/admin/users/${customer}/subscription`, 'PATCH', {
      tier: 'studio',
    });
    expect(changed.status).toBe(200);
    const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.userId, customer));
    expect(sub).toMatchObject({
      tier: 'studio',
      priceRub: catalog!.priceRub,
      creditsPerCycle: catalog!.creditsPerCycle,
    });
    expect(
      await db.select().from(creditTransactions).where(eq(creditTransactions.userId, customer)),
    ).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.subscription_tier_change')),
      );
    expect((audits[0]!.payload as any).targetUserId).toBe(customer);
    await app.close();
  });

  it('extends both the subscription period and its current-cycle bucket expiry', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'start',
      grantCycleCredits: true,
    });
    const [beforeSub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, customer));
    const [beforeBucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.relatedSubscriptionId, beforeSub!.id));

    expect(
      (await getJson(app, `/v1/admin/users/${customer}/subscription/extend`, 'POST', { days: 17 }))
        .status,
    ).toBe(200);
    const [afterSub] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, beforeSub!.id));
    const [afterBucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.id, beforeBucket!.id));
    expect(afterSub!.currentPeriodEnd.getTime() - beforeSub!.currentPeriodEnd.getTime()).toBe(
      17 * 86_400_000,
    );
    expect(afterBucket!.expiresAt!.getTime() - beforeBucket!.expiresAt!.getTime()).toBe(
      17 * 86_400_000,
    );
    expect(afterBucket!.expiresAt!.getTime()).toBe(afterSub!.currentPeriodEnd.getTime());
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.subscription_extend')));
    expect((audits[0]!.payload as any).targetUserId).toBe(customer);
    await app.close();
  });

  it('deliberately restores an expired current-cycle bucket when extending its period', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'start',
      grantCycleCredits: true,
    });
    const [bucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, customer));
    await db
      .update(creditBuckets)
      .set({ expiresAt: new Date(Date.now() - 86_400_000) })
      .where(eq(creditBuckets.id, bucket!.id));
    expect((await creditService.balanceFor(customer)).available).toBe(0);

    expect(
      (await getJson(app, `/v1/admin/users/${customer}/subscription/extend`, 'POST', { days: 2 }))
        .status,
    ).toBe(200);
    expect((await creditService.balanceFor(customer)).available).toBe(bucket!.granted);
    await app.close();
  });

  it('refuses every W6 mutation while a live billing intent blocks the user', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const subscribedCustomer = await makeUser();
    const orderId = nid();
    await db.insert(orders).values({
      id: orderId,
      userId: customer,
      kind: 'subscription',
      tierOrPackId: 'start',
      amountRub: 490,
      psp: 'yookassa-stub',
      ourStatus: 'pending',
      intentKey: 'subscribe',
    });
    const app = appFor(admin, [admin]);
    await app.ready();
    await db.insert(subscriptions).values({
      id: nid(),
      userId: subscribedCustomer,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      priceRub: 490,
      creditsPerCycle: 1200,
    });
    const subscribedOrderId = nid();
    await db.insert(orders).values({
      id: subscribedOrderId,
      userId: subscribedCustomer,
      kind: 'subscription',
      tierOrPackId: 'pro',
      amountRub: 3799,
      psp: 'yookassa-stub',
      ourStatus: 'pending',
      intentKey: 'upgrade:in-flight',
    });

    const create = await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'start',
    });
    const status = await getJson(app, `/v1/admin/users/${customer}/status`, 'POST', {
      status: 'banned',
      reason: 'support hold',
    });
    for (const result of [create, status]) {
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: 'billing_intent_in_flight', orderId });
    }
    for (const request of [
      getJson(app, `/v1/admin/users/${subscribedCustomer}/subscription`, 'PATCH', { tier: 'pro' }),
      getJson(app, `/v1/admin/users/${subscribedCustomer}/subscription/extend`, 'POST', {
        days: 1,
      }),
      getJson(app, `/v1/admin/users/${subscribedCustomer}/subscription/close`, 'POST', {
        mode: 'now',
      }),
    ]) {
      const result = await request;
      expect(result.status).toBe(409);
      expect(result.body).toEqual({
        error: 'billing_intent_in_flight',
        orderId: subscribedOrderId,
      });
    }
    expect(
      await db.select().from(subscriptions).where(eq(subscriptions.userId, customer)),
    ).toHaveLength(0);
    await db
      .update(orders)
      .set({ ourStatus: 'failed', intentKey: null })
      .where(eq(orders.id, orderId));
    await db
      .update(orders)
      .set({ ourStatus: 'failed', intentKey: null })
      .where(eq(orders.id, subscribedOrderId));

    const createdAfterResolution = await getJson(
      app,
      `/v1/admin/users/${customer}/subscription`,
      'POST',
      { tier: 'start' },
    );
    expect(createdAfterResolution.status).toBe(201);
    const tierAfterResolution = await getJson(
      app,
      `/v1/admin/users/${subscribedCustomer}/subscription`,
      'PATCH',
      { tier: 'pro' },
    );
    expect(tierAfterResolution.status).toBe(200);
    await app.close();
  });

  it('closes now under the live predicate without confiscating existing buckets', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', {
      tier: 'pro',
      grantCycleCredits: true,
    });
    const [beforeBucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, customer));
    const retainedAssetId = nid();
    await db.insert(galleryItems).values({
      id: retainedAssetId,
      userId: customer,
      assetUrl: `https://assets.seed.test/${retainedAssetId}.png`,
      kind: 'image',
      expiresAt: null,
    });
    const duplicateId = nid();
    await db.insert(subscriptions).values({
      id: duplicateId,
      userId: customer,
      tier: 'studio',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
      priceRub: 6999,
      creditsPerCycle: 20500,
    });
    expect(await resolveUserPlanTier(db, customer)).toBe('studio');

    expect(
      (
        await getJson(app, `/v1/admin/users/${customer}/subscription/close`, 'POST', {
          mode: 'now',
        })
      ).status,
    ).toBe(200);
    const rows = await db.select().from(subscriptions).where(eq(subscriptions.userId, customer));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'canceled')).toBe(true);
    expect(await resolveUserPlanTier(db, customer)).toBe('free');
    const [afterBucket] = await db
      .select()
      .from(creditBuckets)
      .where(eq(creditBuckets.id, beforeBucket!.id));
    expect(afterBucket).toMatchObject({
      id: beforeBucket!.id,
      granted: beforeBucket!.granted,
      expiresAt: beforeBucket!.expiresAt,
    });
    expect(
      (
        await db
          .select({ expiresAt: galleryItems.expiresAt })
          .from(galleryItems)
          .where(eq(galleryItems.id, retainedAssetId))
      )[0]!.expiresAt,
    ).toBeInstanceOf(Date);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.subscription_close')));
    expect((audits[0]!.payload as any).targetUserId).toBe(customer);
    await app.close();
  });

  it('bans and reactivates a user with actor-attributed audit records', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    expect(
      (
        await getJson(app, `/v1/admin/users/${customer}/status`, 'POST', {
          status: 'banned',
          reason: 'confirmed abuse',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await db.select({ status: usersApp.status }).from(usersApp).where(eq(usersApp.id, customer))
      )[0]!.status,
    ).toBe('banned');
    expect(
      (
        await getJson(app, `/v1/admin/users/${customer}/status`, 'POST', {
          status: 'active',
          reason: 'appeal accepted',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await db.select({ status: usersApp.status }).from(usersApp).where(eq(usersApp.id, customer))
      )[0]!.status,
    ).toBe('active');
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.user_status_change')));
    expect(audits).toHaveLength(2);
    expect(audits.every((audit) => (audit.payload as any).targetUserId === customer)).toBe(true);
    await app.close();
  });

  it('does not reactivate an erased account', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    await db
      .update(usersApp)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(eq(usersApp.id, customer));
    const app = appFor(admin, [admin]);
    await app.ready();
    const result = await getJson(app, `/v1/admin/users/${customer}/status`, 'POST', {
      status: 'active',
      reason: 'should not resurrect',
    });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'deleted_account_immutable' });
    expect(
      (
        await db.select({ status: usersApp.status }).from(usersApp).where(eq(usersApp.id, customer))
      )[0]!.status,
    ).toBe('deleted');
    await app.close();
  });

  it('only allows close-at-period-end for active subscriptions', async () => {
    const admin = await makeUser();
    const customer = await makeUser();
    const app = appFor(admin, [admin]);
    await app.ready();
    await getJson(app, `/v1/admin/users/${customer}/subscription`, 'POST', { tier: 'start' });
    await db
      .update(subscriptions)
      .set({ status: 'past_due' })
      .where(eq(subscriptions.userId, customer));
    const result = await getJson(app, `/v1/admin/users/${customer}/subscription/close`, 'POST', {
      mode: 'at_period_end',
    });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: 'close_at_period_end_requires_active' });
    await app.close();
  });
});

describe('admin panel: provider-balances textModels (assist text routing visibility)', () => {
  it('lists the three assist tiers; standard tier shows OR-primary route + kie price when unarmed', async () => {
    await withBalanceEnv({}, async () => {
      const admin = await makeUser();
      const app = appFor(admin, [admin]);
      await app.ready();
      const { status, body } = await getJson(app, '/v1/admin/provider-balances?fresh=1');
      expect(status).toBe(200);
      const textModels = (body as any).textModels as Array<Record<string, any>>;
      expect(textModels.map((t) => t.id)).toEqual(['economy', 'standard', 'max']);
      const standard = textModels.find((t) => t.id === 'standard')!;
      expect(standard.model).toBe('google/gemini-3-flash-preview');
      expect(standard.creditsPerCall.project).toBeGreaterThan(0);
      expect(standard.priceUsdPerMTok).toEqual({ input: 0.5, output: 3.0 });
      expect(standard.route).toEqual({
        primary: 'openrouter', // no KIE_API_KEY armed
        fallback: 'openrouter',
        kiePriceUsdPerMTok: { input: 0.15, output: 0.9 },
      });
      // The max tier is kie-routed too (Claude leg) — OR-primary when unarmed.
      expect(textModels.find((t) => t.id === 'max')!.route).toEqual({
        primary: 'openrouter', // no KIE_API_KEY armed
        fallback: 'openrouter',
        kiePriceUsdPerMTok: { input: 0.85, output: 4.275 },
      });
      // The economy tier stays OpenRouter-only (no fallback block).
      expect(textModels.find((t) => t.id === 'economy')!.route).toEqual({
        primary: 'openrouter',
      });
      await app.close();
    });
  });

  it('shows kie as the standard+max tier primary when KIE_API_KEY is armed (KIE_MODE=stub → no live fetch)', async () => {
    await withBalanceEnv({ KIE_API_KEY: 'test-kie-key', KIE_MODE: 'stub' }, async () => {
      const admin = await makeUser();
      const app = appFor(admin, [admin]);
      await app.ready();
      const { status, body } = await getJson(app, '/v1/admin/provider-balances?fresh=1');
      expect(status).toBe(200);
      const textModels = (body as any).textModels as Array<Record<string, any>>;
      for (const id of ['standard', 'max']) {
        const tier = textModels.find((t) => t.id === id)!;
        expect(tier.route.primary).toBe('kie');
        expect(tier.route.fallback).toBe('openrouter');
      }
      expect(textModels.find((t) => t.id === 'max')!.route.kiePriceUsdPerMTok).toEqual({
        input: 0.85,
        output: 4.275,
      });
      await app.close();
    });
  });
});

describe('admin panel: text-tier ON/OFF switches (audited)', () => {
  it('flips a tier OFF/ON, audits it, reflects in textModels; 404 unknown tier, 400 bad body', async () => {
    await withBalanceEnv({}, async () => {
      const admin = await makeUser();
      const app = appFor(admin, [admin]);
      await app.ready();
      // Snapshot the shared row so we can restore it (seed ships all ACTIVE;
      // a missing row also reads as ACTIVE).
      const [beforeRow] = await db
        .select()
        .from(assistTierStates)
        .where(eq(assistTierStates.tierId, 'max'))
        .limit(1);
      try {
        const off = await getJson(app, '/v1/admin/text-tiers/max', 'PATCH', { isActive: false });
        expect(off.status).toBe(200);
        expect((off.body as any).tier).toMatchObject({
          id: 'max',
          isActive: false,
          updatedBy: admin,
        });

        const audit = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.userId, admin), eq(auditLog.action, 'admin.text_tier_update')))
          .orderBy(desc(auditLog.createdAt))
          .limit(1);
        expect(audit).toHaveLength(1);
        expect((audit[0]!.payload as any).tierId).toBe('max');
        expect((audit[0]!.payload as any).before.isActive).toBe(true);
        expect((audit[0]!.payload as any).after.isActive).toBe(false);

        // The cockpit's textModels block reflects the switch (fresh read; the
        // PATCH also busts the 2-min balances cache).
        const balances = await getJson(app, '/v1/admin/provider-balances?fresh=1');
        const max = (balances.body as any).textModels.find((t: any) => t.id === 'max');
        expect(max.isActive).toBe(false);
        expect(max.updatedBy).toBe(admin);
        expect(typeof max.updatedAt).toBe('string');
        // Untouched tiers stay ACTIVE.
        expect(
          (balances.body as any).textModels.find((t: any) => t.id === 'economy').isActive,
        ).toBe(true);

        const on = await getJson(app, '/v1/admin/text-tiers/max', 'PATCH', { isActive: true });
        expect(on.status).toBe(200);
        expect((on.body as any).tier.isActive).toBe(true);

        expect(
          (await getJson(app, '/v1/admin/text-tiers/nope', 'PATCH', { isActive: false })).status,
        ).toBe(404);
        expect((await getJson(app, '/v1/admin/text-tiers/max', 'PATCH', {})).status).toBe(400);
      } finally {
        if (beforeRow) {
          await db
            .update(assistTierStates)
            .set({
              isActive: beforeRow.isActive,
              updatedAt: beforeRow.updatedAt,
              updatedBy: beforeRow.updatedBy,
            })
            .where(eq(assistTierStates.tierId, 'max'));
        } else {
          await db.delete(assistTierStates).where(eq(assistTierStates.tierId, 'max'));
        }
        invalidateAssistTierStates();
        await app.close();
      }
    });
  });

  it('403s a non-admin', async () => {
    const u = await makeUser();
    const app = appFor(u, ['someone-else']);
    await app.ready();
    const { status } = await getJson(app, '/v1/admin/text-tiers/max', 'PATCH', { isActive: false });
    expect(status).toBe(403);
    await app.close();
  });
});
