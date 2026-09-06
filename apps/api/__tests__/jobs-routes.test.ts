import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, inArray } from 'drizzle-orm';
import {
  creditTransactions,
  db,
  jobs,
  modelPricePoints,
  models,
  nid,
  outboxJobs,
  pool,
  projects,
  subscriptions,
  usersApp,
  usersPii,
  workflows,
} from '@seed/db';
import { CreditService } from '@seed/credits';
import {
  EXECUTION_SNAPSHOT_VERSION,
  executionSnapshotSchema,
} from '@seed/shared/execution-snapshot';
import { setupJobsRoutes, type JobsRoutesDeps } from '../src/jobs-routes';
import type { ReferenceProbeResult } from '../src/reference-dimensions';

/**
 * SF-5 (critical-path POST /v1/jobs tests) + BL-1 (daily spend cap + kill-switch).
 *
 * The reserve/idempotency/tier-gate/cost-cap/402 paths + the platform spend
 * controls all run through `setupJobsRoutes`. These exercise it directly with a
 * stubbed session + Redis (no provider — the API only reserves + enqueues).
 */
const credits = new CreditService();

function makeRedisStub(): IORedis & { _seed(key: string, n: number): void } {
  const store = new Map<string, number>();
  return {
    async eval(script: string, _n: number, key: string, ...args: Array<string | number>) {
      // M1 daily-budget reserve (spend-guard.ts): conditional INCRBY against a cap.
      if (typeof script === 'string' && script.includes('cap')) {
        const cost = Number(args[0]);
        const cap = Number(args[1]);
        const cur = store.get(key) ?? 0;
        if (cur + cost > cap) return -1;
        const total = cur + cost;
        store.set(key, total);
        return total;
      }
      // Fixed-window rate-limit (rate-limit.ts): one INCR.
      const v = (store.get(key) ?? 0) + 1;
      store.set(key, v);
      return v;
    },
    async decrby(key: string, by: number | string) {
      const v = (store.get(key) ?? 0) - Number(by);
      store.set(key, v);
      return v;
    },
    async get(key: string) {
      const v = store.get(key);
      return v == null ? null : String(v);
    },
    async incrby(key: string, by: number | string) {
      const v = (store.get(key) ?? 0) + Number(by);
      store.set(key, v);
      return v;
    },
    async expire() {
      return 1;
    },
    _seed(key: string, n: number) {
      store.set(key, n);
    },
  } as unknown as IORedis & { _seed(key: string, n: number): void };
}

const createdUsers: string[] = [];
const createdJobIds: string[] = [];

/** `handTieredAs` writes `users_app.tier` — the column god-mode raw SQL sets and
 *  no payment path ever writes. The plan-access tests use it to prove the job
 *  gate reads the subscription row and NOT this column. */
async function makeUser(
  grantCredits: number,
  handTieredAs?: 'start' | 'plus' | 'pro' | 'studio' | 'max',
): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({
    id,
    displayName: 'JobsRoutes',
    locale: 'ru',
    ...(handTieredAs ? { tier: handTieredAs } : {}),
  });
  await db.insert(usersPii).values({ id, email: `jobsroutes+${id}@seed.local` });
  createdUsers.push(id);
  if (grantCredits > 0) {
    await credits.grant({
      userId: id,
      amount: grantCredits,
      account: 'pack_grant',
      reason: 'test.grant',
      idempotencyKey: `grant:${id}`,
    });
  }
  return id;
}

let app: FastifyInstance;
let redis: ReturnType<typeof makeRedisStub>;
let currentUser: string;
let referenceProbeResult: ReferenceProbeResult | null = null;
let referenceProbe: NonNullable<JobsRoutesDeps['referenceProbe']>;
let freeImageModel: { id: string; cost: number };
let gatedModel: { id: string; tierMin: string } | null;
let boardImageModel: { id: string; cost: number };
let parkedVoiceModelId: string;
/** A plain image model gated at `start` — the plan-access tests need a model
 *  whose `tierMin` a seeded `start` subscription exactly covers, and that is
 *  otherwise as ordinary as the free model the 201 tests use. */
let planGatedModel: { id: string; cost: number; tierMin: 'start' };

/** Seed a subscription row directly. Nothing in the product writes `past_due`
 *  yet (W3 will), so direct seeding is the only way to pin these states. */
async function seedSubscription(
  userId: string,
  opts: {
    tier: 'start' | 'plus' | 'pro' | 'studio' | 'max';
    status?: 'active' | 'trialing' | 'past_due' | 'canceled' | 'expired';
    currentPeriodEnd: Date;
  },
): Promise<string> {
  const id = nid();
  await db.insert(subscriptions).values({
    id,
    userId,
    tier: opts.tier,
    status: opts.status ?? 'active',
    currentPeriodStart: new Date(opts.currentPeriodEnd.getTime() - 30 * 86_400_000),
    currentPeriodEnd: opts.currentPeriodEnd,
    cancelAtPeriodEnd: false,
    cycleNumber: 1,
    priceRub: 599,
    creditsPerCycle: 1175,
  });
  return id;
}

beforeAll(async () => {
  const rows = await db
    .select({
      id: models.id,
      kind: models.kind,
      tierMin: models.tierMin,
      active: models.isActive,
      capabilities: models.capabilities,
    })
    .from(models);
  const active = rows.filter((r) => r.active);
  // Prefer a free-tier image model with an EMPTY declared `resolutions` list: its
  // price selector always resolves to the single 'default' config regardless of
  // request params, so `validBody()`'s param-less body stays valid even now that
  // parametric price points are seeded ACTIVE (pricing-correct-catalogue-build.md
  // phase 1.2b — previously every point seeded inactive, so every image job
  // priced flat and this choice didn't matter). A model with a non-empty
  // declared list (e.g. seedream-4-5) requires an explicit resolution/quality
  // param or the resolver refuses (`config_not_available`) — a real, separate
  // question about default-selector behavior for images that this test file
  // does not decide (goal phases 1.4/1.5 own money-path-on-missing-data calls).
  const freeImageCandidates = active.filter((r) => r.kind === 'image' && r.tierMin === 'free');
  const img =
    freeImageCandidates.find((r) =>
      Array.isArray((r.capabilities as { resolutions?: unknown } | null)?.resolutions)
        ? (r.capabilities as { resolutions: unknown[] }).resolutions.length === 0
        : true,
    ) ?? freeImageCandidates[0];
  if (!img) throw new Error('seed must provide a free-tier image model');
  // The model may carry an ACTIVE parametric price point for its 'default'
  // resolution (phase 1.2b) — read the REAL resolved cost from it so this
  // fixture tracks whatever the resolver actually charges.
  const activeDefaultPoint = await db
    .select({ baseCredits: modelPricePoints.baseCredits })
    .from(modelPricePoints)
    .where(
      and(
        eq(modelPricePoints.modelId, img.id),
        eq(modelPricePoints.resolution, 'default'),
        eq(modelPricePoints.isActive, true),
      ),
    )
    .limit(1);
  if (activeDefaultPoint[0] === undefined) {
    throw new Error(`free image fixture '${img.id}' has no active 'default' price point`);
  }
  freeImageModel = { id: img.id, cost: activeDefaultPoint[0].baseCredits };
  const gated = active.find((r) => r.tierMin !== 'free');
  gatedModel = gated ? { id: gated.id, tierMin: gated.tierMin } : null;

  boardImageModel = { id: `brd3-image-${nid()}`, cost: 37 };
  await db.insert(models).values({
    id: boardImageModel.id,
    provider: 'stub',
    family: 'brd3test',
    variant: 'image',
    kind: 'image-edit',
    isActive: true,
    tierMin: 'free',
    unitKind: 'image',
    providerModelId: 'brd3-image-test',
    providerEndpoint: '/stub',
    expectedLatencyMsP50: 1000,
    expectedLatencyMsP95: 3000,
    capabilities: {
      reference: true,
      maxRefs: 2,
      resolutions: ['2K'],
      aspect_ratios: ['1:1'],
    },
  });
  // A model with NO active price point cannot be quoted at all (phase 1.4: a
  // missing price is a data failure, not a licence to charge a flat rate).
  // Every fixture model therefore has to carry the row that prices what it sells.
  await db.insert(modelPricePoints).values([
    {
      id: nid(),
      modelId: boardImageModel.id,
      resolution: '2K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: boardImageModel.cost,
      baseUnits: 1,
      isActive: true,
      sourceRef: 'test fixture',
    },
    // A reference BAND, so this fixture exercises the model shape where the count is
    // a price dimension — the only shape where an over-cap request is refused rather
    // than clamped. `maxRefs: 2` above is the band's ceiling.
    {
      id: nid(),
      modelId: boardImageModel.id,
      resolution: '2K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: boardImageModel.cost + 4,
      baseUnits: 1,
      refsMin: 2,
      refsMax: 2,
      isActive: true,
      sourceRef: 'test fixture',
    },
  ]);

  planGatedModel = { id: `plan-gate-image-${nid()}`, cost: 12, tierMin: 'start' };
  await db.insert(models).values({
    id: planGatedModel.id,
    provider: 'stub',
    family: 'plangate',
    variant: 'image',
    kind: 'image',
    isActive: true,
    tierMin: planGatedModel.tierMin,
    unitKind: 'image',
    providerModelId: 'plan-gate-image-test',
    providerEndpoint: '/stub',
    expectedLatencyMsP50: 1000,
    expectedLatencyMsP95: 3000,
  });
  // The W0 cases exercise subscription-derived access, not fallback pricing.
  // Give their otherwise-paramless image requests the same active `default`
  // price configuration used by the OpenRouter gateway-forcing fixtures.
  await db.insert(modelPricePoints).values({
    id: nid(),
    modelId: planGatedModel.id,
    resolution: 'default',
    videoInput: false,
    audio: false,
    unitKind: 'image',
    baseCredits: planGatedModel.cost,
    baseUnits: 1,
    isActive: true,
    sourceRef: 'test fixture',
  });

  parkedVoiceModelId = `parked-voice-${nid()}`;
  await db.insert(models).values({
    id: parkedVoiceModelId,
    provider: 'stub',
    family: 'parked-voice',
    variant: 'test',
    kind: 'voice',
    isActive: true,
    tierMin: 'free',
    unitKind: '1k_chars',
    providerModelId: 'parked-voice-test',
    providerEndpoint: '/stub/voice',
    expectedLatencyMsP50: 1000,
    expectedLatencyMsP95: 3000,
    capabilities: { languages: ['ru', 'en'] },
  });
  await db.insert(modelPricePoints).values({
    id: nid(),
    modelId: parkedVoiceModelId,
    resolution: 'default',
    videoInput: false,
    audio: false,
    unitKind: '1k_chars',
    baseCredits: 8,
    baseUnits: 1,
    isActive: true,
    sourceRef: 'test fixture',
  });

  redis = makeRedisStub();
  app = Fastify({ logger: false });
  referenceProbe = async () => referenceProbeResult ?? { status: 'skipped' };
  setupJobsRoutes(app, async () => ({ user: { id: currentUser } }), {
    redis,
    credits,
    referenceProbe,
  });
  await app.ready();
});

afterEach(() => {
  delete process.env.GENERATION_KILL_SWITCH;
  delete process.env.DAILY_SPEND_CAP_CREDITS;
  delete process.env.MAX_JOB_CREDITS;
  referenceProbeResult = null;
});

afterAll(async () => {
  await app.close();
  if (createdJobIds.length) {
    await db.delete(outboxJobs).where(
      inArray(
        outboxJobs.jobId,
        createdJobIds.map((j) => `run-${j}`),
      ),
    );
  }
  for (const id of createdUsers) {
    await db.delete(creditTransactions).where(eq(creditTransactions.userId, id));
    await db.delete(jobs).where(eq(jobs.userId, id));
    await db.delete(workflows).where(eq(workflows.userId, id));
    await db.delete(projects).where(eq(projects.userId, id));
    // `subscriptions` has an FK to users_app; the plan-access tests seed rows,
    // so they must go before the user row or teardown fails on the constraint.
    await db.delete(subscriptions).where(eq(subscriptions.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, boardImageModel.id));
  await db.delete(models).where(eq(models.id, boardImageModel.id));
  await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, planGatedModel.id));
  await db.delete(models).where(eq(models.id, planGatedModel.id));
  await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, parkedVoiceModelId));
  await db.delete(models).where(eq(models.id, parkedVoiceModelId));
  await pool.end();
});

function postJob(body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/jobs', payload: body });
}

const validBody = (over: Record<string, unknown> = {}) => ({
  modelId: freeImageModel.id,
  prompt: 'тест',
  idempotencyKey: `idem-${nid()}`,
  ...over,
});

async function activeJobCount(userId: string): Promise<number> {
  const rows = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.userId, userId));
  return rows.length;
}

async function workflowParamsForJob(jobId: string): Promise<Record<string, unknown>> {
  const jobRow = await db
    .select({ workflowId: jobs.workflowId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  const wf = await db
    .select({ params: workflows.params })
    .from(workflows)
    .where(eq(workflows.id, jobRow[0]!.workflowId))
    .limit(1);
  return wf[0]!.params;
}

describe('SF-5: POST /v1/jobs reserve + idempotency + gates', () => {
  it('reserves credits and creates a queued job (201)', async () => {
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody());
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { jobId: string; creditsReserved: number };
    createdJobIds.push(out.jobId);
    expect(out.creditsReserved).toBe(freeImageModel.cost);
    const persisted = await db
      .select({
        creditUnitCost: jobs.creditUnitCost,
        projectId: jobs.projectId,
        executionSnapshot: jobs.executionSnapshot,
      })
      .from(jobs)
      .where(eq(jobs.id, out.jobId))
      .limit(1);
    expect(persisted[0]?.creditUnitCost).toBe(freeImageModel.cost);
    expect(persisted[0]?.projectId).toBeNull();
    const snapshot = executionSnapshotSchema.parse(persisted[0]?.executionSnapshot);
    expect(snapshot.snapshotVersion).toBe(EXECUTION_SNAPSHOT_VERSION);
    expect(snapshot.model.kind).toBe('image');
    expect(snapshot.quotedCredits).toBe(freeImageModel.cost);
    expect(snapshot.validatedRequest.prompt).toBe('тест');
    expect(snapshot.unitsBreakdown.units).toBe(1);
    const bal = await credits.balanceFor(currentUser);
    expect(bal.available).toBe(100_000 - freeImageModel.cost);
    expect(bal.pending).toBe(freeImageModel.cost);
  });

  it('persists optional preset provenance without changing plain jobs', async () => {
    currentUser = await makeUser(100_000);
    const withPreset = await postJob(validBody({ presetSlug: 'vitrina-noir' }));
    const withoutPreset = await postJob(validBody());
    expect(withPreset.statusCode, withPreset.body).toBe(201);
    expect(withoutPreset.statusCode, withoutPreset.body).toBe(201);
    const withPresetJobId = (withPreset.json() as { jobId: string }).jobId;
    const withoutPresetJobId = (withoutPreset.json() as { jobId: string }).jobId;
    createdJobIds.push(withPresetJobId, withoutPresetJobId);

    const persisted = await db
      .select({ id: jobs.id, presetSlug: jobs.presetSlug })
      .from(jobs)
      .where(inArray(jobs.id, [withPresetJobId, withoutPresetJobId]));
    expect(persisted).toEqual(
      expect.arrayContaining([
        { id: withPresetJobId, presetSlug: 'vitrina-noir' },
        { id: withoutPresetJobId, presetSlug: null },
      ]),
    );
  });

  it('persists a per-image rate that makes reserve == settle for a batch', async () => {
    // The worker never re-prices (job-runner.ts:42-60): it settles images at
    // `min(assets × jobs.credit_unit_cost, credits_reserved)`. So reserve ==
    // settle on full delivery holds iff `credits_reserved == credit_unit_cost × n`.
    // Phase 1.4 changed WHERE that rate comes from — the parametric row instead
    // of `models.credit_cost_per_unit` — so the identity is re-pinned here.
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody({ params: { n: 3 } }));
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { jobId: string; creditsReserved: number };
    createdJobIds.push(out.jobId);
    const persisted = await db
      .select({ unit: jobs.creditUnitCost, reserved: jobs.creditsReserved })
      .from(jobs)
      .where(eq(jobs.id, out.jobId))
      .limit(1);
    const { unit, reserved } = persisted[0]!;
    expect(unit).toBe(freeImageModel.cost);
    expect(reserved).toBe(unit! * 3);
    expect(out.creditsReserved).toBe(reserved);
    // The worker's settle expression, evaluated on a full delivery.
    expect(Math.min(3 * unit!, reserved!)).toBe(reserved);
  });

  it('stores only an owned live optional project context', async () => {
    currentUser = await makeUser(100_000);
    const foreignUser = await makeUser(100_000);
    const ownedId = nid();
    const foreignId = nid();
    const deletedId = nid();
    await db.insert(projects).values([
      { id: ownedId, userId: currentUser, title: 'Owned' },
      { id: foreignId, userId: foreignUser, title: 'Foreign' },
      { id: deletedId, userId: currentUser, title: 'Deleted', deletedAt: new Date() },
    ]);

    const owned = await postJob(validBody({ projectId: ownedId }));
    expect(owned.statusCode, owned.body).toBe(201);
    const ownedJobId = (owned.json() as { jobId: string }).jobId;
    createdJobIds.push(ownedJobId);
    const [stored] = await db
      .select({ projectId: jobs.projectId })
      .from(jobs)
      .where(eq(jobs.id, ownedJobId));
    expect(stored?.projectId).toBe(ownedId);

    for (const projectId of [foreignId, deletedId]) {
      const before = await activeJobCount(currentUser);
      const balanceBefore = await credits.balanceFor(currentUser);
      const rejected = await postJob(validBody({ projectId }));
      expect(rejected.statusCode).toBe(404);
      expect(await activeJobCount(currentUser)).toBe(before);
      expect(await credits.balanceFor(currentUser)).toEqual(balanceBefore);
    }
  });

  it('serializes concurrent equal-key requests into one job, workflow, outbox effect, and reservation', async () => {
    currentUser = await makeUser(100_000);
    const body = validBody();
    const responses = await Promise.all([postJob(body), postJob(body)]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    const jobIds = responses.map((response) => (response.json() as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(1);
    const jobId = jobIds[0]!;
    createdJobIds.push(jobId);

    const persistedJobs = await db
      .select({ id: jobs.id, workflowId: jobs.workflowId })
      .from(jobs)
      .where(eq(jobs.userId, currentUser));
    expect(persistedJobs).toHaveLength(1);
    expect(persistedJobs[0]?.id).toBe(jobId);
    expect(
      await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(eq(workflows.userId, currentUser)),
    ).toEqual([{ id: persistedJobs[0]!.workflowId }]);
    expect(
      await db
        .select({ jobId: outboxJobs.jobId })
        .from(outboxJobs)
        .where(eq(outboxJobs.jobId, `run-${jobId}`)),
    ).toEqual([{ jobId: `run-${jobId}` }]);

    const reservation = await db
      .select({
        account: creditTransactions.account,
        amount: creditTransactions.amount,
        idempotencyKey: creditTransactions.idempotencyKey,
      })
      .from(creditTransactions)
      .where(
        and(eq(creditTransactions.userId, currentUser), eq(creditTransactions.relatedJobId, jobId)),
      );
    expect(reservation).toHaveLength(2);
    expect(reservation.map((row) => row.account).sort()).toEqual(['available', 'pending']);
    expect(reservation.map((row) => row.idempotencyKey).sort()).toEqual(
      [`job:${jobId}:reserve:available`, `job:${jobId}:reserve:pending`].sort(),
    );
    expect(reservation.reduce((sum, row) => sum + row.amount, 0)).toBe(0);

    expect((await credits.balanceFor(currentUser)).available).toBe(100_000 - freeImageModel.cost);
    expect(await activeJobCount(currentUser)).toBe(1);
  });

  it('never replays an equal key across users or an incompatible request', async () => {
    const owner = await makeUser(100_000);
    currentUser = owner;
    const idempotencyKey = `idem-${nid()}`;
    const first = await postJob(validBody({ idempotencyKey, prompt: 'исходный запрос' }));
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { jobId: string }).jobId;
    createdJobIds.push(firstId);
    const ownerBalance = await credits.balanceFor(owner);

    const otherUser = await makeUser(100_000);
    currentUser = otherUser;
    const foreignReplay = await postJob(validBody({ idempotencyKey, prompt: 'исходный запрос' }));
    expect(foreignReplay.statusCode).toBe(409);
    expect(foreignReplay.json()).toEqual({ error: 'idempotency_key_in_use' });
    expect(await activeJobCount(otherUser)).toBe(0);

    currentUser = owner;
    for (const incompatible of [
      { prompt: 'другой запрос' },
      { prompt: 'исходный запрос', params: { n: 2 } },
      { prompt: 'исходный запрос', referenceAssets: ['https://example.com/other.png'] },
      { prompt: 'исходный запрос', presetSlug: 'vitrina-noir' },
    ]) {
      const mismatch = await postJob(validBody({ idempotencyKey, ...incompatible }));
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toEqual({ error: 'idempotency_request_mismatch' });
    }
    expect(await credits.balanceFor(owner)).toEqual(ownerBalance);
    expect(await activeJobCount(owner)).toBe(1);
  });

  it('replays a generation only in its original project context', async () => {
    currentUser = await makeUser(100_000);
    const firstProjectId = nid();
    const secondProjectId = nid();
    await db.insert(projects).values([
      { id: firstProjectId, userId: currentUser, title: 'Первый' },
      { id: secondProjectId, userId: currentUser, title: 'Второй' },
    ]);
    const idempotencyKey = `idem-${nid()}`;
    const first = await postJob(validBody({ idempotencyKey, projectId: firstProjectId }));
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as { jobId: string }).jobId;
    createdJobIds.push(firstId);
    const balanceAfterFirst = await credits.balanceFor(currentUser);

    const replay = await postJob(validBody({ idempotencyKey, projectId: firstProjectId }));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ jobId: firstId });

    for (const projectId of [secondProjectId, undefined]) {
      const mismatch = await postJob(
        validBody({
          idempotencyKey,
          ...(projectId ? { projectId } : {}),
        }),
      );
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json()).toEqual({ error: 'idempotency_project_mismatch' });
    }
    expect(await credits.balanceFor(currentUser)).toEqual(balanceAfterFirst);
    expect(await activeJobCount(currentUser)).toBe(1);
  });

  it('returns 402 when the user cannot afford the job', async () => {
    currentUser = await makeUser(0); // no credits
    const res = await postJob(validBody());
    expect(res.statusCode).toBe(402);
    expect((res.json() as { error: string }).error).toBe('insufficient_credits');
    expect(await activeJobCount(currentUser)).toBe(0); // nothing persisted
  });

  it('returns 400 cost_cap_exceeded when the single-job cap is exceeded', async () => {
    process.env.MAX_JOB_CREDITS = '1'; // below any real model cost
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody());
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('cost_cap_exceeded');
    expect(await activeJobCount(currentUser)).toBe(0);
    // Credits untouched.
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
  });

  it('M-1: rejects a severe (CSAE) prompt with 400 prompt_blocked, nothing reserved', async () => {
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody({ prompt: 'a naked child on a beach' }));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('prompt_blocked');
    // Refused before any reservation or persistence.
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
  });

  it('returns 400 for an unknown model', async () => {
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody({ modelId: 'no-such-model-xyz' }));
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('model_not_available');
  });

  it('refuses an active parked kind before pricing, reservation, or queueing', async () => {
    currentUser = await makeUser(100_000);
    const before = await credits.balanceFor(currentUser);

    const submit = await postJob(validBody({ modelId: parkedVoiceModelId }));
    expect(submit.statusCode).toBe(400);
    expect((submit.json() as { error: string }).error).toBe('model_not_available');

    const estimate = await app.inject({
      method: 'POST',
      url: '/v1/jobs/estimate',
      payload: { modelId: parkedVoiceModelId, prompt: 'тест' },
    });
    expect(estimate.statusCode).toBe(400);
    expect((estimate.json() as { error: string }).error).toBe('model_not_available');
    expect(await activeJobCount(currentUser)).toBe(0);
    expect(await credits.balanceFor(currentUser)).toEqual(before);
  });

  it('returns 400 for durationAuto=-1 before reserving credits or creating a job', async () => {
    currentUser = await makeUser(100_000);
    const id = `duration-guard-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'duration-guard',
      variant: 'test',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      maxDurationSeconds: 10,
      providerModelId: 'duration-guard-test',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
    });

    try {
      const res = await postJob(validBody({ modelId: id, params: { duration_seconds: -1 } }));
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('duration_seconds_required');
      expect(await activeJobCount(currentUser)).toBe(0);
      expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
    } finally {
      await db.delete(models).where(eq(models.id, id));
    }
  });

  it('refuses an r2v model with no priced row rather than guessing', async () => {
    currentUser = await makeUser(100_000);
    const id = `guard-${nid()}-reference-to-video`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'reference-video-guard',
      variant: 'test',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      maxDurationSeconds: 15,
      maxResolution: '720p',
      providerModelId: 'guard-reference-to-video',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
      capabilities: { durations: [4, 5, 6], resolutions: ['720p'] },
    });

    try {
      // This used to assert a 201 and a flat 50 × 4s charge. That assertion
      // encoded the removed flat-price path: an unpriced r2v configuration must
      // now refuse instead of inventing a catalogue-independent charge.
      const imageReference = await postJob(
        validBody({
          modelId: id,
          params: {
            duration_seconds: 1,
            resolution: '720p',
            imageUrls: ['https://assets.seed.local/reference.png'],
          },
        }),
      );
      expect(imageReference.statusCode, imageReference.body).toBe(400);
      expect((imageReference.json() as { error: string }).error).toBe('price_unavailable');
    } finally {
      await db.delete(jobs).where(eq(jobs.userId, currentUser));
      await db.delete(workflows).where(eq(workflows.userId, currentUser));
      await db.delete(models).where(eq(models.id, id));
    }
  });

  it('enforces the server-side tier gate (403)', async () => {
    if (!gatedModel) return; // no higher-tier model in the seed — nothing to gate
    currentUser = await makeUser(100_000); // default tier = free
    const res = await postJob(validBody({ modelId: gatedModel.id }));
    expect(res.statusCode).toBe(403);
    expect((res.json() as { error: string }).error).toBe('tier_required');
  });
});

/**
 * W0 — the job gate answers Q1 ("which models may I run") from the SUBSCRIPTION
 * ROW, not from `users_app.tier`. That column is written by nothing except
 * god-mode raw SQL, so before W0 the first genuine paying subscriber was
 * refused 31 of 35 catalogue models. These pin both directions of the swap.
 */
describe('W0: the tier gate reads the live subscription, not users_app.tier', () => {
  const IN_30_DAYS = () => new Date(Date.now() + 30 * 86_400_000);
  const A_DAY_AGO = () => new Date(Date.now() - 86_400_000);

  it('a live subscription unlocks its models while users_app.tier still says free', async () => {
    currentUser = await makeUser(100_000); // users_app.tier = 'free', as every real payer's is
    await seedSubscription(currentUser, { tier: 'start', currentPeriodEnd: IN_30_DAYS() });

    const res = await postJob(validBody({ modelId: planGatedModel.id }));

    expect(res.statusCode, res.body).toBe(201);
    createdJobIds.push((res.json() as { jobId: string }).jobId);
  });

  it('a subscription whose period has elapsed grants nothing', async () => {
    currentUser = await makeUser(100_000, 'max');
    await seedSubscription(currentUser, { tier: 'max', currentPeriodEnd: A_DAY_AGO() });

    const res = await postJob(validBody({ modelId: planGatedModel.id }));

    expect(res.statusCode, res.body).toBe(403);
    const body = res.json() as { error: string; currentTier: string };
    expect(body.error).toBe('tier_required');
    expect(body.currentTier).toBe('free');
  });

  it('a hand-tiered users_app row alone grants nothing — the column is not OR-ed in', async () => {
    // Canon §8, "account deletion does not reset the tier cache": OR-ing
    // `users_app.tier` in would preserve the split brain
    // and never reset on cancel. The only two production accounts with a
    // hand-set tier must be judged by their subscription row like everyone else.
    currentUser = await makeUser(100_000, 'max');
    await seedSubscription(currentUser, { tier: 'max', currentPeriodEnd: A_DAY_AGO() });

    const res = await postJob(validBody({ modelId: planGatedModel.id }));

    expect(res.statusCode, res.body).toBe(403);
    const body = res.json() as { error: string; currentTier: string };
    expect(body.error).toBe('tier_required');
    expect(body.currentTier).toBe('free');
  });

  it('a canceled subscription grants nothing even inside its paid period', async () => {
    currentUser = await makeUser(100_000, 'max');
    await seedSubscription(currentUser, {
      tier: 'max',
      status: 'canceled',
      currentPeriodEnd: IN_30_DAYS(),
    });

    const res = await postJob(validBody({ modelId: planGatedModel.id }));

    expect(res.statusCode, res.body).toBe(403);
    const body = res.json() as { error: string; currentTier: string };
    expect(body.error).toBe('tier_required');
    expect(body.currentTier).toBe('free');
  });

  it('the price estimate judges the tier from the same source as the gate', async () => {
    // jobs-routes.ts:516 feeds the "cheaper models your tier allows" suggestion.
    // Reading a different column there would let the estimate promise a model
    // the gate then refuses.
    currentUser = await makeUser(100_000, 'max'); // hand-tiered, no live subscription
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/estimate',
      payload: { modelId: planGatedModel.id, prompt: 'тест' },
    });

    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { tierAllowed: boolean }).tierAllowed).toBe(false);
  });
});

describe('BL-1: platform spend ceiling + kill-switch', () => {
  it('kill-switch refuses generation (503) before any reservation', async () => {
    process.env.GENERATION_KILL_SWITCH = '1';
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody());
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: string }).error).toBe('generation_disabled');
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000); // untouched
  });

  it('daily spend cap refuses new jobs (503) with no reservation, then resumes when raised', async () => {
    process.env.DAILY_SPEND_CAP_CREDITS = '1'; // below one job's cost
    currentUser = await makeUser(100_000);
    const blocked = await postJob(validBody());
    expect(blocked.statusCode).toBe(503);
    expect((blocked.json() as { error: string }).error).toBe('daily_spend_cap_exceeded');
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);

    // Raise the cap well above the cost — the same user can now generate.
    process.env.DAILY_SPEND_CAP_CREDITS = String(freeImageModel.cost * 100);
    const ok = await postJob(validBody());
    expect(ok.statusCode).toBe(201);
    createdJobIds.push((ok.json() as { jobId: string }).jobId);
  });
});

describe('cost-aware tiering: POST /v1/jobs/estimate (read-only price preview)', () => {
  function estimate(body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: '/v1/jobs/estimate',
      payload: { prompt: 'тест', ...body },
    });
  }

  it('returns cost + affordability without reserving or enqueuing anything', async () => {
    currentUser = await makeUser(100_000);
    const before = await activeJobCount(currentUser);
    const res = await estimate({ modelId: freeImageModel.id, params: { n: 3 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cost: number;
      units: number;
      affordable: boolean;
      tierAllowed: boolean;
      dailyCapWouldBlock: boolean;
    };
    expect(body.units).toBe(3);
    expect(body.cost).toBe(freeImageModel.cost * 3);
    expect(body.affordable).toBe(true);
    expect(body.tierAllowed).toBe(true);
    expect(body.dailyCapWouldBlock).toBe(false);
    // No side effects: no new job rows.
    expect(await activeJobCount(currentUser)).toBe(before);
  });

  it('flags an unaffordable request without blocking the estimate', async () => {
    currentUser = await makeUser(1); // basically broke
    const res = await estimate({ modelId: freeImageModel.id, params: { n: 1 } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { affordable: boolean }).affordable).toBe(false);
  });

  it('suggests cheaper same-kind alternatives the tier allows, with savings', async () => {
    currentUser = await makeUser(100_000);
    const premium = `est-premium-${nid()}`;
    const budget = `est-budget-${nid()}`;
    // Same kind + tier as the other two, but deliberately given NO price row.
    const unpriced = `est-unpriced-${nid()}`;
    const stubImage = (id: string, cost: number) => ({
      id,
      provider: 'stub',
      family: 'esttest',
      variant: id,
      kind: 'image',
      isActive: true,
      tierMin: 'free',
      unitKind: 'image' as const,
      providerModelId: id,
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
    });
    await db.insert(models).values(stubImage(unpriced, 1));
    await db.insert(models).values([
      {
        id: premium,
        provider: 'stub',
        family: 'esttest',
        variant: 'premium',
        kind: 'image',
        isActive: true,
        tierMin: 'free',
        unitKind: 'image',
        providerModelId: 'esttest-premium',
        providerEndpoint: '/stub',
        expectedLatencyMsP50: 1000,
        expectedLatencyMsP95: 3000,
      },
      {
        id: budget,
        provider: 'stub',
        family: 'esttest',
        variant: 'budget',
        kind: 'image',
        isActive: true,
        tierMin: 'free',
        unitKind: 'image',
        providerModelId: 'esttest-budget',
        providerEndpoint: '/stub',
        expectedLatencyMsP50: 1000,
        expectedLatencyMsP95: 3000,
      },
    ]);
    // Both candidates need a real priced row: an unpriced model is now REFUSED
    // rather than flat-charged, and the alternatives loop DROPS a refusal
    // (`if (!mPriced.ok) return null`) — so without these the budget row would
    // silently vanish from the suggestions instead of failing loudly.
    await db.insert(modelPricePoints).values([
      {
        id: nid(),
        modelId: premium,
        resolution: 'default',
        videoInput: false,
        audio: false,
        unitKind: 'image',
        baseCredits: 100,
        baseUnits: 1,
        isActive: true,
        sourceRef: 'test fixture',
      },
      {
        id: nid(),
        modelId: budget,
        resolution: 'default',
        videoInput: false,
        audio: false,
        unitKind: 'image',
        baseCredits: 40,
        baseUnits: 1,
        isActive: true,
        sourceRef: 'test fixture',
      },
    ]);
    try {
      const res = await estimate({ modelId: premium, params: { n: 1 } });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        cost: number;
        alternatives: Array<{ modelId: string; cost: number; savings: number }>;
      };
      expect(body.cost).toBe(100);
      const alt = body.alternatives.find((a) => a.modelId === budget);
      expect(alt).toBeTruthy();
      expect(alt!.cost).toBe(40);
      expect(alt!.savings).toBe(60);
      // An UNPRICED candidate degrades the suggestion list, it does not 500 the
      // estimate: the loop drops a refusal (`if (!mPriced.ok) return null`), which
      // is what keeps the phase-1.4 refusal from breaking this endpoint. Every
      // other active image model is priced against these same `{n:1}` params, so
      // an unpriced one would be the only way to observe a throw.
      expect(body.alternatives.find((a) => a.modelId === unpriced)).toBeUndefined();
    } finally {
      await db.delete(modelPricePoints).where(inArray(modelPricePoints.modelId, [premium, budget]));
      await db.delete(models).where(inArray(models.id, [premium, budget, unpriced]));
    }
  });

  it('normalizes the same Board request for quote, submit, and persistence', async () => {
    currentUser = await makeUser(100_000);
    const request = {
      source: 'boards',
      modelId: boardImageModel.id,
      prompt: 'Точный кадр',
      params: { aspect_ratio: '1:1', resolution: '2K', n: 2 },
    };

    const quoted = await estimate(request);
    expect(quoted.statusCode, quoted.body).toBe(200);
    const quoteBody = quoted.json() as {
      cost: number;
      normalizedRequest: typeof request;
    };
    expect(quoteBody.cost).toBe(boardImageModel.cost * 2);

    const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const submitBody = submitted.json() as {
      jobId: string;
      creditsReserved: number;
      normalizedRequest: typeof request;
    };
    createdJobIds.push(submitBody.jobId);
    expect(submitBody.creditsReserved).toBe(quoteBody.cost);
    expect(submitBody.normalizedRequest).toEqual(quoteBody.normalizedRequest);
    expect(await workflowParamsForJob(submitBody.jobId)).toEqual({
      ...quoteBody.normalizedRequest.params,
      prompt: quoteBody.normalizedRequest.prompt,
    });
  });

  it('rejects an unsupported Board field at quote and submit before persistence', async () => {
    currentUser = await makeUser(100_000);
    const request = {
      source: 'boards',
      modelId: boardImageModel.id,
      prompt: 'Точный кадр',
      params: { aspect_ratio: '1:1', resolution: '2K', n: 1, negative_prompt: 'blur' },
    };

    const quoted = await estimate(request);
    expect(quoted.statusCode).toBe(400);
    expect((quoted.json() as { error: string }).error).toBe('invalid_board_request');

    const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
    expect(submitted.statusCode).toBe(400);
    expect((submitted.json() as { error: string }).error).toBe('invalid_board_request');
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
  });
});

/**
 * Phase 1.4 — a price we cannot resolve is REFUSED on both endpoints, with a
 * stable code AND a human message. This is the exact body `useJobEstimate`
 * consumes to decide it must stop rendering the optimistic local flat price, so
 * the shape is part of the contract, not incidental.
 */
describe('a price the resolver refuses is a 400 with a code and a message', () => {
  const estimate = (body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: '/v1/jobs/estimate', payload: body });

  it('resolution_not_available — the request is outside the model’s declared list', async () => {
    currentUser = await makeUser(100_000);
    // boardImageModel declares ['2K'] and has exactly one 2K row.
    // This used to reach the resolver and report config_not_available. The API
    // boundary now deliberately rejects undeclared resolutions first: 4K is
    // not a model capability, so resolution_not_available is more specific.
    const request = { modelId: boardImageModel.id, prompt: 'кадр', params: { resolution: '4K' } };

    const quoted = await estimate(request);
    expect(quoted.statusCode, quoted.body).toBe(400);
    const q = quoted.json() as { error: string; message?: string };
    expect(q.error).toBe('resolution_not_available');

    const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
    expect(submitted.statusCode).toBe(400);
    expect((submitted.json() as { error: string }).error).toBe('resolution_not_available');
    // Nothing was reserved for a job we refused to quote.
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
  });

  it('too_many_references — more input images than the model can take is refused, not clamped', async () => {
    currentUser = await makeUser(100_000);
    // boardImageModel advertises maxRefs: 2. Three references used to be CLAMPED to
    // two for pricing and logged as a warning — which was survivable while the count
    // only picked a per-image surcharge, and became a money hole the moment it picked
    // a BAND: nothing enforces the cap on the way out (the OpenRouter image
    // serializer forwards up to 14 references), so we would charge the 2-reference
    // configuration and send a 3-reference job.
    const request = {
      modelId: boardImageModel.id,
      prompt: 'кадр',
      params: {
        resolution: '2K',
        imageUrls: [
          'https://example.test/a.png',
          'https://example.test/b.png',
          'https://example.test/c.png',
        ],
      },
    };

    const quoted = await estimate(request);
    expect(quoted.statusCode, quoted.body).toBe(400);
    const q = quoted.json() as {
      error: string;
      message?: string;
      maxReferenceCount?: number;
      requestedReferenceCount?: number;
    };
    expect(q.error).toBe('too_many_references');
    expect(q.maxReferenceCount).toBe(2);
    expect(q.requestedReferenceCount).toBe(3);
    expect(q.message).toContain('2');

    const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
    expect(submitted.statusCode).toBe(400);
    expect((submitted.json() as { error: string }).error).toBe('too_many_references');
    expect(await activeJobCount(currentUser)).toBe(0);
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);

    // At the cap it still quotes and still charges — the refusal is about exceeding
    // what we can price, not about carrying references at all.
    const atCap = await estimate({
      ...request,
      params: { ...request.params, imageUrls: request.params.imageUrls.slice(0, 2) },
    });
    expect(atCap.statusCode, atCap.body).toBe(200);
  });

  it('an over-cap request is still ACCEPTED where the count buys nothing', async () => {
    currentUser = await makeUser(100_000);
    // The refusal is about money, not tidiness. On a model whose price does not vary
    // with the reference count, sending more than `maxRefs` costs us nothing extra —
    // the vendor bills per output image — and /generate's pickers let a user attach
    // up to 10 (14 in edit mode) regardless of the cap. Refusing here would have been
    // a live regression on Gemini, Recraft and GPT Image, none of which price a band.
    const id = `plain-refs-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'plainrefs',
      variant: 'image',
      kind: 'image-edit',
      isActive: true,
      tierMin: 'free',
      unitKind: 'image',
      providerModelId: 'plain-refs-test',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
      capabilities: { reference: true, maxRefs: 2, resolutions: ['2K'] },
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: '2K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: 9,
      baseUnits: 1,
      isActive: true,
      sourceRef: 'test fixture',
    });

    const request = {
      modelId: id,
      prompt: 'кадр',
      params: {
        resolution: '2K',
        imageUrls: [
          'https://example.test/a.png',
          'https://example.test/b.png',
          'https://example.test/c.png',
        ],
      },
    };
    const quoted = await estimate(request);
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect((quoted.json() as { cost: number }).cost).toBe(9);

    const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
    expect(submitted.statusCode, submitted.body).toBe(201);

    // Deactivated rather than deleted: the job we just created references this row,
    // and a fixture that cannot be cleaned up is better left unsellable than left
    // enumerable by another test.
    await db.update(models).set({ isActive: false }).where(eq(models.id, id));
  });

  it('the estimate counts PENDING references against the cap, like the submit will', async () => {
    currentUser = await makeUser(100_000);
    // A board quote is taken before the graph runs, so the estimate is the only place
    // that knows a reference is coming. Checking the cap against today's references
    // alone would quote a shot whose own submit is then refused — the bound-quote
    // deadlock, arrived at from the other side.
    const res = await estimate({
      modelId: boardImageModel.id,
      prompt: 'кадр',
      params: {
        resolution: '2K',
        imageUrls: ['https://example.test/a.png', 'https://example.test/b.png'],
      },
      pendingReferenceCount: 1,
    });
    expect(res.statusCode, res.body).toBe(400);
    const body = res.json() as { error: string; requestedReferenceCount: number };
    expect(body.error).toBe('too_many_references');
    expect(body.requestedReferenceCount).toBe(3);
  });

  it('config_not_available — a declared resolution has no active price row', async () => {
    currentUser = await makeUser(100_000);
    const id = `declared-unpriced-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'declaredunpriced',
      variant: 'image',
      kind: 'image',
      isActive: true,
      tierMin: 'free',
      unitKind: 'image',
      providerModelId: 'declared-unpriced-test',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
      capabilities: { resolutions: ['2K', '4K'] },
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: '2K',
      videoInput: false,
      audio: false,
      unitKind: 'image',
      baseCredits: 37,
      baseUnits: 1,
      isActive: true,
      sourceRef: 'test fixture',
    });
    try {
      const request = { modelId: id, prompt: 'кадр', params: { resolution: '4K' } };

      const quoted = await estimate(request);
      expect(quoted.statusCode, quoted.body).toBe(400);
      const q = quoted.json() as { error: string; message?: string };
      expect(q.error).toBe('config_not_available');
      expect(q.message).toMatch(/конфигурация/i);

      const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
      expect(submitted.statusCode).toBe(400);
      expect((submitted.json() as { error: string }).error).toBe('config_not_available');
      expect(await activeJobCount(currentUser)).toBe(0);
      expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
    } finally {
      await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, id));
      await db.delete(models).where(eq(models.id, id));
    }
  });

  it('price_unavailable — the model has NO active rows (the old silent flat charge)', async () => {
    currentUser = await makeUser(100_000);
    const id = `unpriced-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'unpriced',
      variant: 'image',
      kind: 'image',
      isActive: true,
      tierMin: 'free',
      unitKind: 'image',
      providerModelId: 'unpriced-test',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
    });
    try {
      const request = { modelId: id, prompt: 'кадр', params: { n: 1 } };
      const quoted = await estimate(request);
      expect(quoted.statusCode, quoted.body).toBe(400);
      const q = quoted.json() as { error: string; message?: string };
      expect(q.error).toBe('price_unavailable');
      expect(q.message).toMatch(/нет цены/i);

      const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
      expect(submitted.statusCode).toBe(400);
      expect((submitted.json() as { error: string }).error).toBe('price_unavailable');
      expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
    } finally {
      await db.delete(models).where(eq(models.id, id));
    }
  });

  it('requires resolution at both estimate and submit for a video model with a menu', async () => {
    currentUser = await makeUser(100_000);
    const id = `resolution-required-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'video',
      variant: 'resolution-required',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      providerModelId: id,
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
      maxDurationSeconds: 8,
      capabilities: { resolutions: ['720p'], durations: [4] },
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: '720p',
      videoInput: false,
      audio: false,
      unitKind: 'second',
      baseCredits: 10,
      baseUnits: 4,
      isActive: true,
      sourceRef: 'test fixture',
    });
    try {
      const request = { modelId: id, prompt: 'кадр', params: { duration_seconds: 4 } };
      const quoted = await estimate(request);
      const submitted = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
      for (const response of [quoted, submitted]) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error: 'resolution_required',
          message: 'Для выбранной видеомодели укажи разрешение.',
        });
      }
    } finally {
      await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, id));
      await db.delete(models).where(eq(models.id, id));
    }
  });
});

describe('O-6: reference dimensions are checked before quoting/reservation', () => {
  it('rejects an internal reference on estimate before invoking the dimension probe', async () => {
    currentUser = await makeUser(100_000);
    let probed = false;
    const previousProbe = referenceProbe;
    referenceProbe = async () => {
      probed = true;
      return { status: 'dimensions', dimensions: { width: 100, height: 100 } };
    };
    try {
      const estimate = await app.inject({
        method: 'POST',
        url: '/v1/jobs/estimate',
        payload: {
          modelId: freeImageModel.id,
          prompt: 'не читать внутренний адрес',
          params: { imageUrls: ['http://169.254.169.254/latest/meta-data'] },
        },
      });

      expect(estimate.statusCode, estimate.body).toBe(400);
      expect(estimate.json()).toEqual({
        error: 'unsafe_reference_url',
        url: 'http://169.254.169.254/latest/meta-data',
      });
      expect(probed).toBe(false);
      expect(await activeJobCount(currentUser)).toBe(0);
      expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
    } finally {
      referenceProbe = previousProbe;
    }
  });

  it('refuses an oversized own reference on both estimate and submit', async () => {
    currentUser = await makeUser(100_000);
    const id = `dimension-guard-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'stub',
      family: 'dimension-guard',
      variant: 'reference-video',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      maxDurationSeconds: 15,
      maxResolution: '720p',
      providerModelId: 'dimension-guard-test',
      providerEndpoint: '/stub',
      expectedLatencyMsP50: 1000,
      expectedLatencyMsP95: 3000,
      capabilities: {
        reference: true,
        maxRefs: 9,
        referenceMaxDimension: 6000,
        durations: [4, 5, 6],
        resolutions: ['720p'],
      },
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: '720p',
      videoInput: false,
      audio: false,
      unitKind: 'second',
      baseCredits: 40,
      baseUnits: 4,
      isActive: true,
      sourceRef: 'test fixture',
    });
    referenceProbeResult = {
      status: 'dimensions',
      dimensions: { width: 6336, height: 2688, format: 'png' },
    };

    const request = {
      modelId: id,
      prompt: 'референс',
      params: {
        duration_seconds: 4,
        resolution: '720p',
        imageUrls: [`https://assets.example/${currentUser}/generated.png`],
      },
    };
    try {
      const before = await credits.balanceFor(currentUser);
      const estimate = await app.inject({
        method: 'POST',
        url: '/v1/jobs/estimate',
        payload: request,
      });
      expect(estimate.statusCode, estimate.body).toBe(400);
      expect(estimate.json()).toMatchObject({
        error: 'reference_dimensions_exceeded',
        referenceIndex: 1,
        width: 6336,
        height: 2688,
        maxDimension: 6000,
      });

      const submit = await postJob({ ...request, idempotencyKey: `idem-${nid()}` });
      expect(submit.statusCode, submit.body).toBe(400);
      expect(submit.json()).toMatchObject({
        error: 'reference_dimensions_exceeded',
        width: 6336,
        height: 2688,
      });
      expect(await activeJobCount(currentUser)).toBe(0);
      expect(await credits.balanceFor(currentUser)).toEqual(before);
    } finally {
      await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, id));
      await db.delete(models).where(eq(models.id, id));
    }
  });
});

describe('OpenRouter gateway forcing for slug-shaped models', () => {
  it("forces __gateway='openrouter' for a 'vendor/model' slug, ignoring the dev override", async () => {
    currentUser = await makeUser(100_000);
    const id = `or-veo-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'byteplus',
      family: 'veo',
      variant: '3.1-fast',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      maxDurationSeconds: 8,
      maxResolution: '1080p',
      providerModelId: 'google/veo-3.1-fast',
      providerEndpoint: '/openrouter',
      expectedLatencyMsP50: 120000,
      expectedLatencyMsP95: 240000,
      capabilities: { audio: true, durations: [4, 6, 8] },
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: 'default',
      videoInput: false,
      audio: false,
      unitKind: 'second',
      baseCredits: 40,
      baseUnits: 4,
      isActive: true,
      sourceRef: 'test fixture',
    });
    try {
      // Even with an explicit (and wrong) atlascloud override, OR-only slugs
      // must route to OpenRouter — Evolink/AtlasCloud don't know the slug.
      const res = await postJob({
        modelId: id,
        prompt: 'тест',
        idempotencyKey: `idem-${nid()}`,
        params: { duration_seconds: 4 },
        provider: 'atlascloud',
      });
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as { jobId: string };
      createdJobIds.push(out.jobId);
      const params = await workflowParamsForJob(out.jobId);
      expect(params['__gateway']).toBe('openrouter');
    } finally {
      // Delete in FK order: jobs → workflows → model (workflows.model_id FK).
      await db.delete(jobs).where(eq(jobs.userId, currentUser));
      await db.delete(workflows).where(eq(workflows.userId, currentUser));
      await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, id));
      await db.delete(models).where(eq(models.id, id));
    }
  });

  it('leaves the explicit provider untouched for a non-slug, non-forced model', async () => {
    currentUser = await makeUser(100_000);
    // freeImageModel (gemini-3-1-flash-lite-image, or seedream-4-5) always
    // carries a forceGateway (nanobanana / openrouter respectively — both active
    // free-tier image rows do), so neither exercises the genuine "no override"
    // fallthrough — seed a throwaway row (same pattern as the slug-shaped test
    // above) to test it directly.
    const id = `plain-seedance-${nid()}`;
    await db.insert(models).values({
      id,
      provider: 'byteplus',
      family: 'seedance',
      variant: 'test',
      kind: 'video',
      isActive: true,
      tierMin: 'free',
      unitKind: 'second',
      maxDurationSeconds: 15,
      maxResolution: '1080p',
      providerModelId: 'seedance-2-0-fast-test-only',
      providerEndpoint: '/api/v3/videos/generations',
      expectedLatencyMsP50: 120000,
      expectedLatencyMsP95: 240000,
    });
    await db.insert(modelPricePoints).values({
      id: nid(),
      modelId: id,
      resolution: 'default',
      videoInput: false,
      audio: false,
      unitKind: 'second',
      baseCredits: 40,
      baseUnits: 4,
      isActive: true,
      sourceRef: 'test fixture',
    });
    try {
      const res = await postJob(
        validBody({ modelId: id, params: { duration_seconds: 4 }, provider: 'atlascloud' }),
      );
      expect(res.statusCode, res.body).toBe(201);
      const out = res.json() as { jobId: string };
      createdJobIds.push(out.jobId);
      const params = await workflowParamsForJob(out.jobId);
      expect(params['__gateway']).toBe('atlascloud');
    } finally {
      await db.delete(jobs).where(eq(jobs.userId, currentUser));
      await db.delete(workflows).where(eq(workflows.userId, currentUser));
      await db.delete(modelPricePoints).where(eq(modelPricePoints.modelId, id));
      await db.delete(models).where(eq(models.id, id));
    }
  });
});

/**
 * Quote binding (pricing-and-routing-engine goal, Phase 2). `/v1/jobs/estimate` and
 * `POST /v1/jobs` share one resolver, so they agree for an identical request — until
 * the catalogue moves between them. Then the customer sees one number and is charged
 * another. Submit therefore carries back the quote it displayed, and any difference is
 * refused rather than repriced. The fixture moves a REAL price row between the two
 * calls; asserting on a hand-made mismatched integer would prove only that `!==` works.
 */
describe('quote binding: charge the quoted number, or refuse', () => {
  const quoteParams = { resolution: '2K' };

  function estimate(body: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/v1/jobs/estimate', payload: body });
  }

  async function setPrice(credits: number) {
    await db
      .update(modelPricePoints)
      .set({ baseCredits: credits })
      .where(eq(modelPricePoints.modelId, boardImageModel.id));
  }

  afterEach(async () => {
    await setPrice(boardImageModel.cost);
  });

  it('refuses a submit the catalogue has moved past, and charges nothing', async () => {
    currentUser = await makeUser(100_000);
    const quoted = await estimate({
      modelId: boardImageModel.id,
      prompt: 'тест',
      params: quoteParams,
    });
    expect(quoted.statusCode, quoted.body).toBe(200);
    const quotedCost = (quoted.json() as { cost: number }).cost;
    expect(quotedCost).toBe(boardImageModel.cost);

    await setPrice(boardImageModel.cost + 11);

    const res = await postJob(
      validBody({
        modelId: boardImageModel.id,
        params: quoteParams,
        expectedCost: quotedCost,
      }),
    );
    expect(res.statusCode, res.body).toBe(409);
    const out = res.json() as { error: string; cost: number; expectedCost: number };
    expect(out.error).toBe('quote_stale');
    // The refusal carries the fresh number, so the surface can show it rather than
    // asking the user to guess what changed.
    expect(out.cost).toBe(boardImageModel.cost + 11);
    expect(out.expectedCost).toBe(quotedCost);

    // Nothing reserved, nothing created — a refusal, not a reprice.
    expect((await credits.balanceFor(currentUser)).available).toBe(100_000);
    expect((await credits.balanceFor(currentUser)).pending).toBe(0);
    expect(await activeJobCount(currentUser)).toBe(0);
  });

  it('accepts a submit whose quote still holds, and reserves exactly it', async () => {
    currentUser = await makeUser(100_000);
    const res = await postJob(
      validBody({
        modelId: boardImageModel.id,
        params: quoteParams,
        expectedCost: boardImageModel.cost,
      }),
    );
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as { jobId: string; creditsReserved: number };
    createdJobIds.push(out.jobId);
    expect(out.creditsReserved).toBe(boardImageModel.cost);
  });

  it('still accepts a submit that carries no quote at all', async () => {
    // Optional by design for one release: a browser tab opened before this deploy
    // sends no `expectedCost`, and a hard rejection would strand it. It is the
    // remaining hole this phase leaves open, so it is pinned rather than implied.
    currentUser = await makeUser(100_000);
    const res = await postJob(validBody({ modelId: boardImageModel.id, params: quoteParams }));
    expect(res.statusCode, res.body).toBe(201);
    createdJobIds.push((res.json() as { jobId: string }).jobId);
  });

  it('does not burn the idempotency key when it refuses a stale quote', async () => {
    // The refusal happens inside the create transaction, after the lock and the
    // existing-job lookup — so a replay outranks it, and it rolls back rather than
    // half-claiming the key. If it ever moves back ahead of that lookup, a retry
    // arriving while the original is still committing would be refused as stale.
    currentUser = await makeUser(100_000);
    const idempotencyKey = `idem-${nid()}`;
    const stale = await postJob(
      validBody({
        modelId: boardImageModel.id,
        params: quoteParams,
        expectedCost: boardImageModel.cost + 7,
        idempotencyKey,
      }),
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect((stale.json() as { error: string }).error).toBe('quote_stale');
    expect(await activeJobCount(currentUser)).toBe(0);

    const retry = await postJob(
      validBody({
        modelId: boardImageModel.id,
        params: quoteParams,
        expectedCost: boardImageModel.cost,
        idempotencyKey,
      }),
    );
    expect(retry.statusCode, retry.body).toBe(201);
    createdJobIds.push((retry.json() as { jobId: string }).jobId);
  });

  it('returns the existing job on a replay, even after the price moved', async () => {
    // A retry of a submit whose response was lost must get its job back. Refusing it
    // as stale would report «not submitted» for a job that is already running against
    // reserved credits.
    currentUser = await makeUser(100_000);
    const idempotencyKey = `idem-${nid()}`;
    const body = validBody({
      modelId: boardImageModel.id,
      params: quoteParams,
      expectedCost: boardImageModel.cost,
      idempotencyKey,
    });
    const first = await postJob(body);
    expect(first.statusCode, first.body).toBe(201);
    const jobId = (first.json() as { jobId: string }).jobId;
    createdJobIds.push(jobId);

    await setPrice(boardImageModel.cost + 11);

    const replay = await postJob(body);
    expect(replay.statusCode, replay.body).toBe(200);
    expect((replay.json() as { jobId: string }).jobId).toBe(jobId);
    // One reservation, not two.
    expect((await credits.balanceFor(currentUser)).pending).toBe(boardImageModel.cost);
  });
});
