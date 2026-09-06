import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import {
  FallbackChainAdapter,
  MockGatewayAdapter,
  type ProviderAdapter,
  type WorkflowSpec,
} from '@seed/provider-byteplus';
import {
  db,
  galleryItems,
  jobs,
  lockMediaStorageUser,
  models,
  nid,
  pool,
  projectAssets,
  projects,
  routeAttemptJournal,
  routeLegHealth,
  beginRouteAttempt,
  recordRouteAttemptAccepted,
  subscriptions,
  workflows,
} from '@seed/db';
import { creditService } from '@seed/credits';
import type { ExecutionSnapshot } from '@seed/shared/execution-snapshot';
import { MANUAL_RECONCILIATION_REQUIRED, runJob, type ProviderAdapterFactory } from './job-runner';
import { legacyUnsnapshottedJobsTotal } from './metrics';
import type { AssetUploadInput, UploadedAsset } from './storage';
import {
  seedUser,
  seedModel,
  seedJob,
  outboxFor,
  cleanupIntegrationData,
} from './test-support/seed';
import { corpusPath } from './test-support/corpus';

/**
 * In-memory asset store that fails the MAIN put for one asset index, so a
 * multi-asset upload rejects mid-stream with earlier objects already "stored".
 * Records uploaded + removed keys so a spec can assert the cleanup path.
 */
class StubStorage {
  readonly uploaded: string[] = [];
  readonly removed: string[] = [];
  removeShouldThrow = false;
  constructor(private readonly failMainIndex: number) {}
  async put(input: AssetUploadInput): Promise<UploadedAsset> {
    const isThumb = input.extension.startsWith('thumb');
    const key = `${input.userId}/${input.jobId}/${input.index}.${input.extension}`;
    if (!isThumb && input.index === this.failMainIndex) {
      throw new Error('simulated upload failure');
    }
    this.uploaded.push(key);
    return { key, url: `http://stub.local/${key}` };
  }
  async removeObjects(keys: string[]): Promise<void> {
    if (this.removeShouldThrow) throw new Error('minio remove failed');
    this.removed.push(...keys);
  }
}

/**
 * Canvas generation lifecycle over the MOCK gateway (T3, half A). Drives the
 * REAL worker runJob against the ephemeral test DB for each representative
 * outcome and asserts the job state-machine + the credit reserve/refund path
 * (via the outbox enqueue, the worker's contract boundary). Zero credit spend,
 * zero live gateway.
 */
const log = pino({ level: 'silent' });
let userId: string;
let imageModel: string;
let videoModel: string;

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser({ tier: 'studio' });
  imageModel = await seedModel({ kind: 'image' });
  videoModel = await seedModel({ kind: 'video', maxDurationSeconds: 5 });
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

async function jobRow(jobId: string) {
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  return rows[0]!;
}

async function legacySnapshotMetric(): Promise<number> {
  const metric = await legacyUnsnapshottedJobsTotal.get();
  return Number(metric.values[0]?.value ?? 0);
}

/** A pino logger that captures its output lines so a spec can assert a warning
 * fired (used by the resume-binding specs — a wrong-gateway/legacy handle must
 * log loudly before it falls back to a fresh generation). */
function capturingLog() {
  const records: string[] = [];
  const logger = pino({ level: 'warn' }, { write: (line: string) => records.push(line) });
  return { logger, records };
}

describe('canvas lifecycle — mock gateway (zero spend)', () => {
  it('single image shot: success → succeeded + commit enqueued', async () => {
    const legacyBefore = await legacySnapshotMetric();
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    const outcome = await runJob({ jobId, log });
    expect(outcome).toBe('succeeded');
    const job = await jobRow(jobId);
    expect(job.status).toBe('succeeded');
    expect((job.resultAssets as string[]).length).toBe(1);
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('commit'))).toBe(true);
    expect(await legacySnapshotMetric()).toBe(legacyBefore + 1);
  });

  it('executes from the pre-queue snapshot after the live model row changes', async () => {
    const [before] = await db.select().from(models).where(eq(models.id, imageModel));
    if (!before) throw new Error('image model fixture disappeared');
    const snapshot: ExecutionSnapshot = {
      snapshotVersion: 2,
      model: {
        kind: before.kind,
        provider: before.provider,
        providerModelId: before.providerModelId,
        providerEndpoint: before.providerEndpoint,
        gatewayOverride: before.gatewayOverride,
        fallbackGateway: before.fallbackGateway,
        capabilities: before.capabilities,
        maxDurationSeconds: before.maxDurationSeconds,
        pricing: { source: 'parametric', imageUnitCredits: 10 },
      },
      effectiveGateway: 'mock',
      validatedRequest: {
        prompt: 'snapshot prompt',
        params: { prompt: 'snapshot prompt', __gateway: 'mock', n: 1 },
        referenceAssets: [],
      },
      unitsBreakdown: { units: 1, imageUnitCredits: 10, referenceCount: 0 },
      quotedCredits: 10,
    };
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
      creditUnitCost: 10,
      executionSnapshot: snapshot,
    });

    await db
      .update(models)
      .set({
        kind: 'video',
        providerModelId: 'mutated/live-model',
        providerEndpoint: '/mutated/live-endpoint',
        capabilities: { resolutions: ['4K'] },
        fallbackGateway: 'atlascloud',
      })
      .where(eq(models.id, imageModel));

    let seen: WorkflowSpec | null = null;
    const delegate = new MockGatewayAdapter();
    const adapter: ProviderAdapter = {
      generate: async (spec) => {
        seen = spec;
        return delegate.generate(spec);
      },
      awaitResult: (handle, spec) => delegate.awaitResult(handle, spec),
    };
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
    const legacyBefore = await legacySnapshotMetric();

    try {
      expect(await runJob({ jobId, log, storage: new StubStorage(-1), adapterFactory })).toBe(
        'succeeded',
      );
      expect(seen).toMatchObject({
        modelId: imageModel,
        kind: 'image',
        providerModelId: before.providerModelId,
        providerEndpoint: before.providerEndpoint,
        prompt: 'snapshot prompt',
        capabilities: before.capabilities,
      });
      expect((await jobRow(jobId)).creditsSpent).toBe(10);
      expect(
        (await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId)))[0]?.kind,
      ).toBe('image');
      expect(await legacySnapshotMetric()).toBe(legacyBefore);
    } finally {
      await db
        .update(models)
        .set({
          kind: before.kind,
          providerModelId: before.providerModelId,
          providerEndpoint: before.providerEndpoint,
          capabilities: before.capabilities,
          fallbackGateway: before.fallbackGateway,
        })
        .where(eq(models.id, imageModel));
    }
  });

  it('refuses a snapshot/job money mismatch before provider construction', async () => {
    const [before] = await db.select().from(models).where(eq(models.id, imageModel));
    if (!before) throw new Error('image model fixture disappeared');
    const snapshot: ExecutionSnapshot = {
      snapshotVersion: 2,
      model: {
        kind: before.kind,
        provider: before.provider,
        providerModelId: before.providerModelId,
        providerEndpoint: before.providerEndpoint,
        gatewayOverride: before.gatewayOverride,
        fallbackGateway: before.fallbackGateway,
        capabilities: before.capabilities,
        maxDurationSeconds: before.maxDurationSeconds,
        pricing: { source: 'parametric', imageUnitCredits: 10 },
      },
      effectiveGateway: 'mock',
      validatedRequest: {
        prompt: 'mismatched snapshot',
        params: { prompt: 'mismatched snapshot', __gateway: 'mock', n: 1 },
        referenceAssets: [],
      },
      unitsBreakdown: { units: 1, imageUnitCredits: 10, referenceCount: 0 },
      quotedCredits: 11,
    };
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
      creditUnitCost: 10,
      executionSnapshot: snapshot,
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getAdapterWithFallback: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getResumeAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
    };

    expect(await runJob({ jobId, log, adapterFactory })).toBe('failed');
    expect((await jobRow(jobId)).errorCode).toBe('execution_snapshot_mismatch');
    expect(adapterFactory.getAdapter).not.toHaveBeenCalled();
    expect(adapterFactory.getAdapterWithFallback).not.toHaveBeenCalled();
    expect(adapterFactory.getResumeAdapter).not.toHaveBeenCalled();
    expect((await outboxFor(jobId)).some((row) => row.queueName.includes('refund'))).toBe(true);
  });

  it('REQUIRE_EXECUTION_SNAPSHOT refuses a legacy job before provider construction', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
      creditUnitCost: 10,
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getAdapterWithFallback: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getResumeAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
    };
    const previous = process.env.REQUIRE_EXECUTION_SNAPSHOT;
    process.env.REQUIRE_EXECUTION_SNAPSHOT = '1';
    try {
      expect(await runJob({ jobId, log, adapterFactory })).toBe('failed');
      expect((await jobRow(jobId)).errorCode).toBe('missing_execution_snapshot');
      expect(adapterFactory.getAdapter).not.toHaveBeenCalled();
      expect(adapterFactory.getAdapterWithFallback).not.toHaveBeenCalled();
      expect(adapterFactory.getResumeAdapter).not.toHaveBeenCalled();
      expect((await outboxFor(jobId)).some((row) => row.queueName.includes('refund'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_EXECUTION_SNAPSHOT;
      else process.env.REQUIRE_EXECUTION_SNAPSHOT = previous;
    }
  });

  it('settles a flat image at its persisted reserve-time rate after a live-model mutation', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 25,
      creditUnitCost: 25,
    });
    // Simulate the race the ledger lock exists for: the API reserved 25 per
    // image, then ANY model-row mutation happens while the job is queued
    // (operator re-pin, capability sync, price work). Settlement must remain
    // locked to the persisted job rate of 25.
    await db
      .update(models)
      .set({ capabilities: { resolutions: ['4K'] } })
      .where(eq(models.id, imageModel));
    try {
      expect(await runJob({ jobId, log })).toBe('succeeded');
      expect((await jobRow(jobId)).creditsSpent).toBe(25);
      const commit = (await outboxFor(jobId)).find((o) => o.queueName.includes('commit'));
      expect((commit?.payload as { amount?: number } | undefined)?.amount).toBe(25);
    } finally {
      await db.update(models).set({ capabilities: {} }).where(eq(models.id, imageModel));
    }
  });

  it('refuses an unsettleable legacy image before constructing or invoking a provider adapter', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      // NULL credit_unit_cost plus no safe integer n is not safely settleable.
      params: { n: 1.5 },
      creditsReserved: 10,
      creditUnitCost: null,
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getAdapterWithFallback: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
      getResumeAdapter: vi.fn((): never => {
        throw new Error('provider adapter must not be constructed');
      }),
    };

    expect(await runJob({ jobId, log, adapterFactory })).toBe('failed');
    expect(adapterFactory.getAdapter).not.toHaveBeenCalled();
    expect(adapterFactory.getAdapterWithFallback).not.toHaveBeenCalled();
    expect(adapterFactory.getResumeAdapter).not.toHaveBeenCalled();
    const job = await jobRow(jobId);
    expect(job.errorCode).toBe(MANUAL_RECONCILIATION_REQUIRED);
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('refund'))).toBe(true);
    expect(outbox.some((o) => o.queueName.includes('commit'))).toBe(false);
  });

  it('M-1: provider-flagged NSFW asset → gallery item tagged "nsfw"', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success', nsfw: true },
      params: { n: 1 },
      creditsReserved: 10,
    });
    expect(await runJob({ jobId, log })).toBe('succeeded');
    const items = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(items).toHaveLength(1);
    expect(items[0]!.tags).toEqual(['nsfw']);
  });

  it('clean asset → gallery item carries no nsfw tag', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    expect(await runJob({ jobId, log })).toBe('succeeded');
    const items = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(items[0]!.tags).toEqual([]);
    expect(items[0]!.sourceKind).toBe('generation');
    expect(items[0]!.mimeType).toBe('image/svg+xml');
    expect(items[0]!.sizeBytes).toBeGreaterThan(0);
  });

  it('sets generation origin + membership only while its enqueue-validated project is live', async () => {
    const liveProjectId = `it-project-${nid()}`;
    const deletedProjectId = `it-project-${nid()}`;
    await db.insert(projects).values([
      { id: liveProjectId, userId, title: 'Live generation' },
      { id: deletedProjectId, userId, title: 'Deleted generation' },
    ]);
    const live = await seedJob({
      userId,
      modelId: imageModel,
      projectId: liveProjectId,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    const deleted = await seedJob({
      userId,
      modelId: imageModel,
      projectId: deletedProjectId,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    await db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(eq(projects.id, deletedProjectId));

    expect(await runJob({ jobId: live.jobId, log })).toBe('succeeded');
    expect(await runJob({ jobId: deleted.jobId, log })).toBe('succeeded');
    const [liveAsset] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.jobId, live.jobId));
    const [deletedAsset] = await db
      .select()
      .from(galleryItems)
      .where(eq(galleryItems.jobId, deleted.jobId));
    expect(liveAsset?.originProjectId).toBe(liveProjectId);
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, liveAsset!.id)),
    ).toEqual([expect.objectContaining({ projectId: liveProjectId, userId })]);
    expect(deletedAsset?.originProjectId).toBeNull();
    expect(
      await db.select().from(projectAssets).where(eq(projectAssets.assetId, deletedAsset!.id)),
    ).toHaveLength(0);
  });

  it('M3: reaper wins mid-run → late success is suppressed (no resurrect, no commit, asset cleaned)', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    // Storage whose first put simulates the reaper winning the race: it flips the
    // already-'running' row to failed+refunded WHILE the provider asset uploads,
    // then returns the asset. The settle must NOT resurrect the job to succeeded.
    class RacingStorage extends StubStorage {
      private flipped = false;
      constructor() {
        super(-1);
      }
      override async put(input: AssetUploadInput): Promise<UploadedAsset> {
        if (!this.flipped) {
          this.flipped = true;
          await db
            .update(jobs)
            .set({ status: 'failed', errorCode: 'TIMEOUT_REAPED' })
            .where(eq(jobs.id, jobId));
        }
        return super.put(input);
      }
    }
    const racing = new RacingStorage();
    expect(await runJob({ jobId, log, storage: racing })).toBe('skipped');
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed'); // NOT resurrected to succeeded
    const items = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(items).toHaveLength(0); // no gallery insert
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('commit'))).toBe(false); // no double-commit
    expect(racing.removed.length).toBeGreaterThan(0); // the uploaded object is cleaned up
  });

  it('cancel-vs-generation serializes on the user lock and leaves free media at 30 days', async () => {
    const raceUserId = await seedUser({ tier: 'free' });
    const subId = nid();
    await db.insert(subscriptions).values({
      id: subId,
      userId: raceUserId,
      tier: 'start',
      status: 'active',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      cancelAtPeriodEnd: false,
      cycleNumber: 1,
      priceRub: 490,
      creditsPerCycle: 1175,
    });
    const { jobId } = await seedJob({
      userId: raceUserId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });

    let releaseCancel!: () => void;
    const cancelMayCommit = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelHasLock!: () => void;
    const cancelLocked = new Promise<void>((resolve) => {
      cancelHasLock = resolve;
    });
    let cancelPromise: Promise<void> | null = null;
    class CancelRacingStorage extends StubStorage {
      private started = false;
      constructor() {
        super(-1);
      }
      override async put(input: AssetUploadInput): Promise<UploadedAsset> {
        if (!this.started) {
          this.started = true;
          cancelPromise = db.transaction(async (tx) => {
            await lockMediaStorageUser(tx, raceUserId);
            await tx
              .update(subscriptions)
              .set({ status: 'canceled' })
              .where(eq(subscriptions.id, subId));
            cancelHasLock();
            await cancelMayCommit;
          });
          await cancelLocked;
          // Let runJob reach its writer transaction while cancellation still
          // owns the user lock; cancellation then commits first.
          setTimeout(releaseCancel, 25);
        }
        return super.put(input);
      }
    }

    expect(await runJob({ jobId, log, storage: new CancelRacingStorage() })).toBe('succeeded');
    await cancelPromise;
    const [asset] = await db
      .select({ expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.jobId, jobId));
    expect(asset?.expiresAt).toBeInstanceOf(Date);
    expect(asset!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(asset!.expiresAt!.getTime()).toBeLessThan(Date.now() + 31 * 86_400_000);
  });

  // What the admin cost report prices a job off. A chain leg that goes unrecorded
  // is charged to us at the leg's rate and reported at the primary's.
  const deadLeg = (name: string): ProviderAdapter => ({
    generate: () => Promise.reject(new Error(`${name} down`)),
    awaitResult: () => Promise.reject(new Error(`${name} down`)),
  });
  function factoryFor(adapter: ProviderAdapter): ProviderAdapterFactory {
    return {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
  }

  it('G7: the real worker commit is leg-blind and charges the same reserve on either leaf', async () => {
    const previousAiProvider = process.env.AI_PROVIDER;
    delete process.env.AI_PROVIDER;
    const leaf = (gateway: string): ProviderAdapter => ({
      generate: vi.fn(async () => ({
        providerJobId: `${gateway}-g7-${nid()}`,
        gateway,
        inlineResult: {
          assets: [
            {
              bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
              contentType: 'image/svg+xml',
              extension: 'svg',
            },
            {
              bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
              contentType: 'image/svg+xml',
              extension: 'svg',
            },
          ],
          meta: { servedBy: gateway, fallbackDepth: 0 },
        },
      })),
      awaitResult: vi.fn(async (handle) => handle.inlineResult!),
    });
    const adapters = new Map<string, ProviderAdapter>([
      ['kie', leaf('kie')],
      ['openrouter', leaf('openrouter')],
    ]);
    const factory: ProviderAdapterFactory = {
      getAdapter: (gateway) => adapters.get(gateway ?? '')!,
      getAdapterWithFallback: (gateway) => adapters.get(gateway ?? '')!,
      getResumeAdapter: (gateway) => adapters.get(gateway) ?? null,
    };

    try {
      const jobsByLeaf = await Promise.all(
        (['kie', 'openrouter'] as const).map((gateway) =>
          seedJob({
            userId,
            modelId: imageModel,
            params: { __gateway: gateway, n: 2 },
            creditsReserved: 20,
            creditUnitCost: 10,
          }),
        ),
      );
      for (const { jobId } of jobsByLeaf) {
        expect(
          await runJob({ jobId, log, storage: new StubStorage(-1), adapterFactory: factory }),
        ).toBe('succeeded');
      }

      const settled = await Promise.all(jobsByLeaf.map(({ jobId }) => jobRow(jobId)));
      expect(settled.map((job) => job.creditsReserved)).toEqual([20, 20]);
      expect(settled.map((job) => job.creditsSpent)).toEqual([20, 20]);
      expect(settled.map((job) => job.gatewayUsed)).toEqual(['kie', 'openrouter']);
      const commits = await Promise.all(
        jobsByLeaf.map(async ({ jobId }) => {
          const commit = (await outboxFor(jobId)).find((row) => row.queueName.includes('commit'));
          return commit?.payload as Record<string, unknown>;
        }),
      );
      expect(commits.map((payload) => payload.amount)).toEqual([20, 20]);
      expect(commits.every((payload) => !('gateway' in payload) && !('leg' in payload))).toBe(true);

      // Everything above compares the worker against a `creditsReserved` this test
      // typed itself, so it proves the worker is consistent with a fixture — not that
      // the money moved the same way on either leg. Drive the REAL ledger: reserve
      // through `creditService`, settle the commit payload the worker actually wrote,
      // and read the balance back. This is the part I-1 is about.
      const ledgerUser = await seedUser();
      await creditService.grant({
        userId: ledgerUser,
        amount: 100,
        reason: 'g7-ledger',
        account: 'pack_grant',
        idempotencyKey: `g7-grant-${nid()}`,
      });
      const ledgerBalances: Array<{ available: number; pending: number }> = [];
      for (const [index, gateway] of (['kie', 'openrouter'] as const).entries()) {
        const { jobId } = await seedJob({
          userId: ledgerUser,
          modelId: imageModel,
          params: { __gateway: gateway, n: 2 },
          creditsReserved: 20,
          creditUnitCost: 10,
        });
        await creditService.reserve({
          userId: ledgerUser,
          jobId,
          amount: 20,
          reason: 'g7-reserve',
          idempotencyKey: `g7-reserve-${jobId}`,
        });
        expect(
          await runJob({ jobId, log, storage: new StubStorage(-1), adapterFactory: factory }),
        ).toBe('succeeded');
        const commit = (await outboxFor(jobId)).find((row) => row.queueName.includes('commit'));
        const payload = commit!.payload as { userId: string; jobId: string; amount: number };
        await creditService.commit({
          userId: payload.userId,
          jobId: payload.jobId,
          amount: payload.amount,
          idempotencyKey: `g7-commit-${jobId}`,
        });
        ledgerBalances.push(await creditService.balanceFor(ledgerUser));
        // The reserve is released and the spend booked once, whichever leg served.
        expect(ledgerBalances[index]!.pending).toBe(0);
      }
      // 100 granted, 20 charged per job, and the second leg charges exactly what the
      // first did. A leg-aware reserve would show a different second step here.
      expect(ledgerBalances.map((balance) => balance.available)).toEqual([80, 60]);
    } finally {
      if (previousAiProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = previousAiProvider;
    }
  });

  it('crash-after-accept recovery polls the accepted journal row without submitting again', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      params: { __gateway: 'kie', n: 1 },
      creditsReserved: 10,
      creditUnitCost: 10,
    });
    const attempt = await beginRouteAttempt({
      jobId,
      modelId: imageModel,
      gateway: 'kie',
      legIdentity: `it-g7-${nid()}`,
      rung: 'default',
      role: 'primary',
    });
    await recordRouteAttemptAccepted(attempt.attemptId, 'accepted-before-crash', 'kie');

    const generate = vi.fn(async () => {
      throw new Error('a recovered accepted submit must never generate again');
    });
    const resume: ProviderAdapter = {
      generate,
      awaitResult: vi.fn(async () => ({
        assets: [
          {
            bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'),
            contentType: 'image/svg+xml',
            extension: 'svg',
          },
        ],
        meta: { servedBy: 'kie', fallbackDepth: 0 },
      })),
    };
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => ({ generate, awaitResult: resume.awaitResult }),
      getAdapterWithFallback: () => ({ generate, awaitResult: resume.awaitResult }),
      getResumeAdapter: (gateway) => (gateway === 'kie' ? resume : null),
    };

    expect(await runJob({ jobId, log, storage: new StubStorage(-1), adapterFactory })).toBe(
      'succeeded',
    );
    expect(generate).not.toHaveBeenCalled();
    expect((await jobRow(jobId)).providerJobId).toBe('accepted-before-crash');
  });

  it('the chain LEAF that served is persisted, with its distance from the primary', async () => {
    // nanobanana in the shape that hurts: both relays dead, the official
    // OpenRouter leg (~2.7x the primary's rate) serves.
    const chain = new FallbackChainAdapter([
      { name: 'laozhang', adapter: deadLeg('laozhang') },
      { name: 'kie', adapter: deadLeg('kie') },
      { name: 'openrouter-official', adapter: new MockGatewayAdapter() },
    ]);
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });

    expect(await runJob({ jobId, log, adapterFactory: factoryFor(chain) })).toBe('succeeded');

    const job = await jobRow(jobId);
    expect(job.gatewayUsed).toBe('openrouter-official');
    expect(job.usedFallback).toBe(true);
    expect(job.fallbackDepth).toBe(2);
  });

  it('a primary-leg job names the leaf vendor too, at depth 0 — never the chain alias', async () => {
    const chain = new FallbackChainAdapter([
      { name: 'laozhang', adapter: new MockGatewayAdapter() },
      { name: 'kie', adapter: deadLeg('kie') },
    ]);
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });

    expect(await runJob({ jobId, log, adapterFactory: factoryFor(chain) })).toBe('succeeded');

    const job = await jobRow(jobId);
    expect(job.gatewayUsed).toBe('laozhang');
    expect(job.usedFallback).toBe(false);
    expect(job.fallbackDepth).toBe(0);
  });

  it('«Снять всё» fan-out: 3 independent shots all succeed', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { jobId } = await seedJob({
        userId,
        modelId: imageModel,
        mock: { outcome: 'success' },
        params: { n: 1, shot: i },
        creditsReserved: 10,
      });
      ids.push(jobId);
    }
    const outcomes = await Promise.all(ids.map((jobId) => runJob({ jobId, log })));
    expect(outcomes).toEqual(['succeeded', 'succeeded', 'succeeded']);
    for (const jobId of ids) expect((await jobRow(jobId)).status).toBe('succeeded');
  });

  it('video shot: success → succeeded with an mp4 asset', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 5 },
      creditsReserved: 50,
    });
    expect(await runJob({ jobId, log })).toBe('succeeded');
    const job = await jobRow(jobId);
    expect(job.status).toBe('succeeded');
    expect((job.resultAssets as string[])[0]).toMatch(/\.mp4$/);
  });

  it('video ingest stores an MP4 with moov before mdat', async () => {
    const sourcePath = corpusPath('bars-720p');
    const adapter = new MockGatewayAdapter({
      corpus: [{ durationSec: 2, path: sourcePath }],
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
    class RecordingStorage extends StubStorage {
      mainBytes: Buffer | null = null;
      constructor() {
        super(-1);
      }
      override async put(input: AssetUploadInput): Promise<UploadedAsset> {
        if (!input.extension.startsWith('thumb')) this.mainBytes = Buffer.from(input.bytes);
        return super.put(input);
      }
    }
    const storage = new RecordingStorage();
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 2 },
      creditsReserved: 20,
    });

    expect(await runJob({ jobId, log, storage, adapterFactory })).toBe('succeeded');
    const stored = storage.mainBytes!;
    const moov = stored.indexOf(Buffer.from('moov'));
    const mdat = stored.indexOf(Buffer.from('mdat'));
    expect(moov).toBeGreaterThan(0);
    expect(mdat).toBeGreaterThan(0);
    expect(moov).toBeLessThan(mdat);
  });

  it('video ingest keeps a generic-MIME MP4 as video and applies faststart', async () => {
    const sourcePath = corpusPath('bars-720p');
    const adapter = new MockGatewayAdapter({
      corpus: [
        {
          durationSec: 2,
          path: sourcePath,
          contentType: 'application/octet-stream',
          extension: 'bin',
        },
      ],
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
    class RecordingStorage extends StubStorage {
      mainBytes: Buffer | null = null;
      constructor() {
        super(-1);
      }
      override async put(input: AssetUploadInput): Promise<UploadedAsset> {
        if (!input.extension.startsWith('thumb')) this.mainBytes = Buffer.from(input.bytes);
        return super.put(input);
      }
    }
    const storage = new RecordingStorage();
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 2 },
      creditsReserved: 20,
    });

    expect(await runJob({ jobId, log, storage, adapterFactory })).toBe('succeeded');
    const [item] = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(item!.kind).toBe('video');
    expect(item!.assetUrl.endsWith('.bin')).toBe(true);
    expect(item!.thumbnailUrl).not.toBeNull();
    const stored = storage.mainBytes!;
    expect(stored.indexOf(Buffer.from('moov'))).toBeLessThan(stored.indexOf(Buffer.from('mdat')));
  });

  it('video ingest stores the original asset and succeeds when faststart remux fails', async () => {
    const sourcePath = corpusPath('bars-720p');
    const original = await readFile(sourcePath);
    const adapter = new MockGatewayAdapter({
      corpus: [{ durationSec: 2, path: sourcePath }],
    });
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
    class RecordingStorage extends StubStorage {
      mainBytes: Buffer | null = null;
      constructor() {
        super(-1);
      }
      override async put(input: AssetUploadInput): Promise<UploadedAsset> {
        if (!input.extension.startsWith('thumb')) this.mainBytes = Buffer.from(input.bytes);
        return super.put(input);
      }
    }
    const storage = new RecordingStorage();
    const remuxVideo = vi.fn(async (): Promise<Buffer> => {
      throw new Error('simulated ffmpeg failure');
    });
    const { logger, records } = capturingLog();
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 2 },
      creditsReserved: 20,
    });

    expect(await runJob({ jobId, log: logger, storage, adapterFactory, remuxVideo })).toBe(
      'succeeded',
    );
    expect(remuxVideo).toHaveBeenCalledOnce();
    expect(storage.mainBytes!.equals(original)).toBe(true);
    expect(records.some((record) => record.includes('faststart remux failed'))).toBe(true);
  });

  it('video job with return_last_frame records the extracted still as kind=image', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 4 },
      params: { duration_seconds: 4, return_last_frame: true },
      creditsReserved: 40,
    });
    expect(await runJob({ jobId, log })).toBe('succeeded');
    const items = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.kind === 'video')).toHaveLength(1);
    expect(items.find((i) => i.assetUrl.endsWith('.jpg'))!.kind).toBe('image');
  });

  it('video job keeps a provider-returned last-frame still as kind=image', async () => {
    const videoBytes = await readFile(corpusPath('bars-720p'));
    const stillBytes = await readFile(corpusPath('still-portrait'));
    class VideoWithStillAdapter extends MockGatewayAdapter {
      override async awaitResult() {
        return {
          assets: [
            { bytes: videoBytes, contentType: 'video/mp4', extension: 'mp4' },
            { bytes: stillBytes, contentType: 'image/png', extension: 'png' },
          ],
        };
      }
    }
    const adapter = new VideoWithStillAdapter();
    const adapterFactory: ProviderAdapterFactory = {
      getAdapter: () => adapter,
      getAdapterWithFallback: () => adapter,
      getResumeAdapter: () => adapter,
    };
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success', durationSec: 2 },
      params: { duration_seconds: 2, return_last_frame: true },
      creditsReserved: 20,
    });

    expect(await runJob({ jobId, log, storage: new StubStorage(-1), adapterFactory })).toBe(
      'succeeded',
    );
    const items = await db.select().from(galleryItems).where(eq(galleryItems.jobId, jobId));
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'video')).toHaveLength(1);
    expect(items.find((item) => item.assetUrl.endsWith('.png'))!.kind).toBe('image');
  });

  it('moderation rejection: failed + full refund enqueued, no partial commit', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'moderation' },
      creditsReserved: 50,
    });
    expect(await runJob({ jobId, log })).toBe('failed');
    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('SUBMIT_REJECTED');
    const outbox = await outboxFor(jobId);
    const refund = outbox.find((o) => o.queueName.includes('refund'));
    expect(refund).toBeTruthy();
    expect((refund!.payload as { amount: number }).amount).toBe(50);
    expect(outbox.some((o) => o.queueName.includes('commit'))).toBe(false);
  });

  it('insufficient credits (402): failed with HTTP_402 + refund', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'insufficient' },
      creditsReserved: 50,
    });
    expect(await runJob({ jobId, log })).toBe('failed');
    const job = await jobRow(jobId);
    expect(job.errorCode).toBe('HTTP_402');
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('refund'))).toBe(true);
  });

  it('retryable poll error on the FINAL attempt: fails cleanly + refund (no stuck job)', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'retry' },
      creditsReserved: 50,
    });
    // attempt 0 of max 1 → no attempts left → falls through to failed+refund.
    expect(await runJob({ jobId, log, attempt: 0, maxAttempts: 1 })).toBe('failed');
    expect((await jobRow(jobId)).errorCode).toBe('POLL_UNREACHABLE');
  });

  it('partial upload failure: first uploaded asset is cleaned up, job fails + full refund', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 2 }, // two image assets; the second one's main put will fail
      creditsReserved: 20,
    });
    const stub = new StubStorage(1);
    expect(await runJob({ jobId, log, storage: stub })).toBe('failed');

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    // The first asset (index 0) was uploaded, then deleted on the failure path.
    expect(stub.uploaded).toContain(`${userId}/${jobId}/0.svg`);
    expect(stub.removed).toContain(`${userId}/${jobId}/0.svg`);
    // The user is made whole: a full refund is enqueued, no spend committed.
    const outbox = await outboxFor(jobId);
    const refund = outbox.find((o) => o.queueName.includes('refund'));
    expect(refund).toBeTruthy();
    expect((refund!.payload as { amount: number }).amount).toBe(20);
    expect(outbox.some((o) => o.queueName.includes('commit'))).toBe(false);
  });

  it('cleanup failure does not mask the original upload error', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 2 },
      creditsReserved: 20,
    });
    const stub = new StubStorage(1);
    stub.removeShouldThrow = true; // cleanup itself fails
    expect(await runJob({ jobId, log, storage: stub })).toBe('failed');

    const job = await jobRow(jobId);
    expect(job.status).toBe('failed');
    // The reported failure is the upload error, not the cleanup error.
    expect(job.errorCode).toBe('INTERNAL');
    expect(job.errorMessage).toContain('simulated upload failure');
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('refund'))).toBe(true);
  });

  it('retryable poll error WITH attempts left: re-queues, no refund yet', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'retry' },
      creditsReserved: 50,
    });
    // attempt 0 of max 3 → retryable → re-throws and resets to queued.
    await expect(runJob({ jobId, log, attempt: 0, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'POLL_UNREACHABLE',
    });
    const job = await jobRow(jobId);
    expect(job.status).toBe('queued'); // handed back to BullMQ
    const outbox = await outboxFor(jobId);
    expect(outbox.some((o) => o.queueName.includes('refund'))).toBe(false);
  });

  it('retry resumes the persisted provider handle instead of submitting a new paid job', async () => {
    const { jobId, workflowId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'retry' },
      params: { seed: 1 },
      creditsReserved: 50,
    });

    await expect(runJob({ jobId, log, attempt: 0, maxAttempts: 3 })).rejects.toMatchObject({
      code: 'POLL_UNREACHABLE',
    });
    const firstAttempt = await jobRow(jobId);
    expect(firstAttempt.status).toBe('queued');
    // The async handle is persisted as `${gateway}::${providerJobId}` so the
    // retry re-binds to the SAME vendor that minted it.
    expect(firstAttempt.providerJobId).toMatch(/^mock::mock-video-/);
    const firstBareId = firstAttempt.providerJobId!.slice('mock::'.length);

    // If runJob submitted again, MockGatewayAdapter would derive a different
    // provider id from the changed seed. Correct behavior is to keep resolving
    // the provider handle captured on the first attempt.
    await db
      .update(workflows)
      .set({
        params: {
          prompt: 'тестовый кадр',
          __gateway: 'mock',
          __mock: { outcome: 'success' },
          seed: 999,
        },
      })
      .where(eq(workflows.id, workflowId));

    expect(await runJob({ jobId, log, attempt: 1, maxAttempts: 3 })).toBe('succeeded');
    const secondAttempt = await jobRow(jobId);
    // Settle writes the resolved handle's bare id — it must equal the first
    // attempt's id (a resubmit under the changed seed would have minted another).
    expect(secondAttempt.providerJobId).toBe(firstBareId);
  });

  it('legacy bare provider id → no resume, fresh generation, warning logged', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      creditsReserved: 50,
    });
    // Simulate a job whose provider id predates the composite format (bare id,
    // no gateway prefix) — e.g. persisted by an older worker build.
    await db.update(jobs).set({ providerJobId: 'legacy-bare-xyz' }).where(eq(jobs.id, jobId));

    const { logger, records } = capturingLog();
    expect(await runJob({ jobId, log: logger, attempt: 1, maxAttempts: 3 })).toBe('succeeded');

    const done = await jobRow(jobId);
    // A fresh mock generation ran: the stored id is a newly minted mock id, NOT
    // the unbindable legacy value we planted.
    expect(done.providerJobId).toMatch(/^mock-video-/);
    expect(done.providerJobId).not.toBe('legacy-bare-xyz');
    expect(records.some((r) => r.includes('not bindable'))).toBe(true);
  });

  it('unknown/removed gateway in a composite id → no resume, fresh generation', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      creditsReserved: 50,
    });
    // A composite whose gateway key the registry no longer recognises must NOT
    // be polled against the routing default (that was the wrong-vendor bug).
    await db.update(jobs).set({ providerJobId: 'gone::mock-video-old' }).where(eq(jobs.id, jobId));

    const { logger, records } = capturingLog();
    expect(await runJob({ jobId, log: logger, attempt: 1, maxAttempts: 3 })).toBe('succeeded');

    const done = await jobRow(jobId);
    expect(done.providerJobId).toMatch(/^mock-video-/);
    expect(done.providerJobId).not.toBe('gone::mock-video-old');
    expect(records.some((r) => r.includes('not bindable'))).toBe(true);
  });

  it('sync (inline) handle is never persisted as a resumable id', async () => {
    // Mock image success returns an inlineResult handle (synthetic id, no
    // durable vendor job). Fail storage so the run ends terminally BEFORE
    // settle — the mid-run provider_job_id must still be null, proving the sync
    // handle was never persisted for resume.
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      creditsReserved: 50,
    });
    const storage = new StubStorage(0); // main put for asset 0 throws
    expect(await runJob({ jobId, log, storage })).toBe('failed');

    const done = await jobRow(jobId);
    expect(done.status).toBe('failed');
    expect(done.providerJobId).toBeNull();
  });
});

/**
 * Finance rev. 20 §2 — «the delivered rank governs the charge», and before anything can
 * govern anything, the delivered rank has to be MEASURED and written down. The letter is
 * explicit about the field: «Record the measured rank on the job. That single field turns
 * the 4% 4K weight in our consumption mix from a hypothesis into a measurement.»
 *
 * These specs drive the seam, not ffprobe — `measureFrame` is injected, so what is under
 * test is the wiring and the write, and the comparison rule has its own unit suite in
 * `@seed/shared/delivered-rank`.
 */
describe('delivered rank is measured and recorded (finance rev. 20 §2)', () => {
  it('records ok + the measured area for a delivery at the rung sold', async () => {
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      params: { resolution: '720p', duration_seconds: 5 },
      creditsReserved: 100,
    });
    expect(
      await runJob({
        jobId,
        log,
        measureFrame: async () => ({ width: 1280, height: 720 }),
      }),
    ).toBe('succeeded');
    const done = await jobRow(jobId);
    expect(done.deliveredRankStatus).toBe('ok');
    expect(done.deliveredPixels).toBe(1280 * 720);
    expect(done.deliveredRankSold).toBe('720p');
  });

  it('records ok for the REAL paid kie i2v shape — 1108x830 sold as 720p', async () => {
    // Task d1f623742cc98f2af897ab45048eb63d, 2026-08-11, USD 0,40 debited. kie fitted the
    // 720p pixel budget to the input frame's 4:3 aspect. A dimension check calls this a
    // downgrade and refunds a job we billed correctly — this spec is the guard against
    // anyone "fixing" the comparison back to width/height.
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      params: { resolution: '720p', duration_seconds: 5 },
      creditsReserved: 100,
    });
    expect(
      await runJob({ jobId, log, measureFrame: async () => ({ width: 1108, height: 830 }) }),
    ).toBe('succeeded');
    const done = await jobRow(jobId);
    expect(done.deliveredRankStatus).toBe('ok');
  });

  it('records downgraded + warns when the vendor delivers below the rung sold', async () => {
    const { logger, records } = capturingLog();
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      params: { resolution: '1080p', duration_seconds: 5 },
      creditsReserved: 100,
    });
    expect(
      await runJob({
        jobId,
        log: logger,
        measureFrame: async () => ({ width: 1280, height: 720 }),
      }),
    ).toBe('succeeded');
    const done = await jobRow(jobId);
    expect(done.deliveredRankStatus).toBe('downgraded');
    expect(done.deliveredPixels).toBe(1280 * 720);
    expect(records.some((r) => r.includes('delivered rank below the rung sold'))).toBe(true);
  });

  it('records unknown — never downgraded — when the asset cannot be measured', async () => {
    // The fail-open direction is the whole point: a broken prober must not hand money
    // back on every job it cannot read. `delivered_pixels` stays NULL so an aggregate
    // over the column never counts an unmeasured job as evidence either way.
    const { jobId } = await seedJob({
      userId,
      modelId: videoModel,
      mock: { outcome: 'success' },
      params: { resolution: '1080p', duration_seconds: 5 },
      creditsReserved: 100,
    });
    expect(await runJob({ jobId, log, measureFrame: async () => null })).toBe('succeeded');
    const done = await jobRow(jobId);
    expect(done.deliveredRankStatus).toBe('unknown');
    expect(done.deliveredPixels).toBeNull();
    // The rung is still recorded — it is what was SOLD, and it is known regardless of
    // whether the delivery could be measured.
    expect(done.deliveredRankSold).toBe('1080p');
  });

  it('does not judge a job whose rung is not a size', async () => {
    // No `resolution` in params → the rung resolves to 'default', which is not a size.
    // Judging it on pixels would invent a promise we never made.
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1 },
      creditsReserved: 10,
    });
    expect(
      await runJob({ jobId, log, measureFrame: async () => ({ width: 64, height: 64 }) }),
    ).toBe('succeeded');
    const done = await jobRow(jobId);
    expect(done.deliveredRankStatus).toBe('unknown');
    // The AREA is recorded anyway. The image ladder's per-vendor pixel budgets are
    // unknown only because nothing has ever measured them, and a verdict-gated write
    // would keep them unknown forever — this column is how they get measured.
    expect(done.deliveredPixels).toBe(64 * 64);
  });

  it('one unmeasurable asset makes the whole job unmeasurable, not "small"', async () => {
    // The null arrives SECOND, after a good measurement, so this fails if the reduce
    // seeds from the first frame and then ignores later nulls. Answering 'downgraded'
    // — or recording the readable asset's area as the job's — would refund on the
    // strength of an asset we could not read.
    const frames: ({ width: number; height: number } | null)[] = [
      { width: 1280, height: 720 },
      null,
    ];
    let call = 0;
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 2, resolution: '1080p' },
      creditsReserved: 20,
    });
    expect(await runJob({ jobId, log, measureFrame: async () => frames[call++] ?? null })).toBe(
      'succeeded',
    );
    const done = await jobRow(jobId);
    expect(call).toBe(2);
    expect(done.deliveredRankStatus).toBe('unknown');
    expect(done.deliveredPixels).toBeNull();
  });

  it("records the rung from the job params, not from the model's live ladder", async () => {
    // The sold rung has to survive an admin editing the model's declared resolutions
    // between enqueue and run — the weekly under-delivery rate groups by what the
    // customer bought. Reading the frozen params is what makes that true.
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 1, resolution: '2K' },
      creditsReserved: 10,
    });
    await db
      .update(models)
      .set({ capabilities: { resolutions: [] } })
      .where(eq(models.id, imageModel));
    try {
      expect(
        await runJob({ jobId, log, measureFrame: async () => ({ width: 1536, height: 1536 }) }),
      ).toBe('succeeded');
      const done = await jobRow(jobId);
      expect(done.deliveredRankSold).toBe('2K');
      expect(done.deliveredPixels).toBe(1536 * 1536);
    } finally {
      await db.update(models).set({ capabilities: {} }).where(eq(models.id, imageModel));
    }
  });

  it('judges a multi-image job by its WORST asset, not by whichever came back first', async () => {
    // Kie and OpenRouter fan the outputs out independently, so one full-size and one
    // undersized image is a real shape. Charging in full because the first happened to be
    // fine — or refunding because it happened to be the small one — are both accidents
    // of ordering.
    const sizes = [
      { width: 1280, height: 720 },
      { width: 320, height: 180 },
    ];
    let call = 0;
    const { jobId } = await seedJob({
      userId,
      modelId: imageModel,
      mock: { outcome: 'success' },
      params: { n: 2, resolution: '720p' },
      creditsReserved: 20,
    });
    expect(await runJob({ jobId, log, measureFrame: async () => sizes[call++] ?? sizes[0]! })).toBe(
      'succeeded',
    );
    const done = await jobRow(jobId);
    expect(call).toBeGreaterThan(1); // it measured more than the first asset
    expect(done.deliveredPixels).toBe(320 * 180);
    expect(done.deliveredRankStatus).toBe('downgraded');
  });
});
