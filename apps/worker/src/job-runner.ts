import type { Logger } from 'pino';
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  galleryItems,
  hasPaidMediaStorage,
  jobs,
  lockMediaStorageUser,
  models,
  mediaExpiresAt,
  nid,
  projectAssets,
  projects,
  readConservativeCreditFloorRub,
  workflows,
} from '@seed/db';
import { CREDIT_COMMIT_QUEUE, CREDIT_REFUND_QUEUE, enqueueViaOutbox } from '@seed/credits';
import { generatedMediaTitle } from '@seed/shared/media-title';
import { judgeDeliveredRank, soldRungFromParams } from '@seed/shared';
import { parseExecutionSnapshot, type ExecutionSnapshot } from '@seed/shared/execution-snapshot';
import {
  getAdapter,
  getAdapterWithFallback,
  getResumeAdapter,
  isMockProviderAllowed,
  ProviderError,
  type AdapterOptions,
  type AdapterRouteRequest,
  type GenerationHandle,
  type ProviderAdapter,
  type WorkflowSpec,
} from '@seed/provider-byteplus';
import { officialLegInvoiceOf, settleOfficialLegJob } from './official-leg-budget';
import { AssetStorage } from './storage';
import { extractLastFrame, makeThumbnail } from './thumbnails';
import { watermarkAsset } from './watermark';
import { measureAssetFrame } from './measure-asset';
import { publishJobEvent } from './events';
import { encodeResumeToken, parseResumeToken } from './resume-token';
import { remuxVideoFaststart } from './video-faststart';
import { WorkerAttemptJournal } from './route-attempt-journal';
import { routeAttemptContext, type RouteAttemptContext } from './route-attempt-context';
import { adapterRouteRequest } from './route-request';
import { legacyUnsnapshottedJobsTotal } from './metrics';

const defaultStorage = new AssetStorage();

export const MANUAL_RECONCILIATION_REQUIRED = 'manual_reconciliation_required';
export const EXECUTION_SNAPSHOT_MISMATCH = 'execution_snapshot_mismatch';

export interface ProviderAdapterFactory {
  getAdapter(gateway: string | undefined, options?: AdapterOptions): ProviderAdapter;
  getAdapterWithFallback(
    primaryGateway: string | undefined,
    fallbackGateway: string | null | undefined,
    options?: AdapterOptions,
    request?: AdapterRouteRequest,
  ): ProviderAdapter;
  getResumeAdapter(gateway: string, options?: AdapterOptions): ProviderAdapter | null;
}

const defaultAdapterFactory: ProviderAdapterFactory = {
  getAdapter: (gateway, options) => getAdapter(gateway, undefined, options),
  getAdapterWithFallback: (primary, fallback, options, request) =>
    getAdapterWithFallback(primary, fallback, undefined, options, request),
  getResumeAdapter: (gateway, options) => getResumeAdapter(gateway, undefined, options),
};

function hasSafeRequestedImageCount(params: Record<string, unknown>): boolean {
  const requested = params['n'];
  return typeof requested === 'number' && Number.isSafeInteger(requested) && requested > 0;
}

function faststartExtension(bytes: Buffer, extension: string): string | null {
  const normalizedExtension = extension.replace(/^\./, '').toLowerCase();
  if (['mp4', 'mov', 'm4v'].includes(normalizedExtension)) return normalizedExtension;
  return bytes.length >= 12 && bytes.subarray(4, 8).equals(Buffer.from('ftyp')) ? 'mp4' : null;
}

export function requiresManualReconciliation(
  model: { kind: string },
  creditUnitCost: number | null,
  params: Record<string, unknown>,
): boolean {
  return model.kind === 'image' && creditUnitCost === null && !hasSafeRequestedImageCount(params);
}

function manualReconciliationError(): ProviderError {
  return new ProviderError({
    code: MANUAL_RECONCILIATION_REQUIRED,
    status: 500,
    retryable: false,
    message: 'manual_reconciliation_required: legacy image job has no safe requested count',
  });
}

/**
 * The schema proves that a snapshot is well-shaped; this proves that it is the
 * same money contract as the job row that holds the reservation. Both rows are
 * written in one API transaction, so a mismatch means corruption, a partial
 * manual repair, or an incompatible rollout — never a reason to call a paid
 * provider. Keep this check before adapter construction and settlement.
 */
export function executionSnapshotMismatch(
  job: { creditsReserved: number; creditUnitCost: number | null },
  snapshot: ExecutionSnapshot,
): string | null {
  if (snapshot.quotedCredits !== job.creditsReserved) {
    return `quoted credits ${snapshot.quotedCredits} != reserved credits ${job.creditsReserved}`;
  }

  const isImage = snapshot.model.kind === 'image' || snapshot.model.kind === 'image-edit';
  const snapshotUnitCredits = snapshot.unitsBreakdown.imageUnitCredits;
  if (isImage) {
    if (snapshotUnitCredits === null) {
      return 'image snapshot has no effective image unit rate';
    }
    if (snapshotUnitCredits !== job.creditUnitCost) {
      return `image unit rate ${snapshotUnitCredits} != persisted unit rate ${job.creditUnitCost}`;
    }
  } else if (snapshotUnitCredits !== null || job.creditUnitCost !== null) {
    return 'non-image snapshot carries an image settlement rate';
  }

  const modelPrice = snapshot.model.pricing?.imageUnitCredits;
  if (modelPrice !== undefined && modelPrice !== snapshotUnitCredits) {
    return `snapshot pricing rate ${modelPrice} != units rate ${snapshotUnitCredits}`;
  }
  return null;
}

async function failClaimedJobWithRefund(
  job: { id: string; userId: string; creditsReserved: number },
  errorCode: string,
  errorMessage: string,
  reqId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // The reaper may win the race after the runner claims the row. In that case
    // it already wrote the refund outbox row; do not enqueue a second one here.
    const failed = await tx
      .update(jobs)
      .set({
        status: 'failed',
        finishedAt: new Date(),
        errorCode,
        errorMessage: errorMessage.slice(0, 1000),
      })
      .where(and(eq(jobs.id, job.id), eq(jobs.status, 'running')))
      .returning({ id: jobs.id });
    if (failed.length === 0) return;

    await enqueueViaOutbox({
      tx,
      queueName: CREDIT_REFUND_QUEUE,
      jobId: `refund-${job.id}`,
      payload: {
        userId: job.userId,
        jobId: job.id,
        amount: job.creditsReserved,
        reason: `provider.failed:${errorCode}`,
        idempotencyKey: `job:${job.id}:refund`,
        ...(reqId ? { _reqId: reqId } : {}),
      },
    });
  });
}

function ambiguousRecoveryError(detail: string): ProviderError {
  return new ProviderError({
    code: 'AMBIGUOUS_SUBMIT',
    status: 409,
    retryable: false,
    message: `manual reconciliation required: ${detail}; refusing a second provider submit`,
  });
}

function providerInvoiceRub(
  meta: Record<string, unknown> | undefined,
  context: RouteAttemptContext | null,
  gateway: string,
): { rub: number } | null {
  if (meta?.['providerCostComplete'] !== true) return null;
  const usd = meta['providerCostUsd'];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return null;
  const leg = context?.legs[gateway] ?? context?.legs[gateway.toLowerCase()];
  if (!leg || !Number.isFinite(leg.vendorRubPerUsd)) return null;
  return { rub: usd * leg.vendorRubPerUsd };
}

/** The slice of AssetStorage runJob needs; tests inject a stub to exercise the
 * partial-upload cleanup path. */
type StorageLike = Pick<AssetStorage, 'put' | 'removeObjects'>;

/**
 * Which gateway LEG served this job, for `jobs.gateway_used` / `fallback_depth`.
 *
 * Both failover wrappers stamp the same `servedBy`/`fallbackDepth` meta
 * (@seed/provider-byteplus `serving-leg.ts`). Reading only the old circuit-breaker
 * field names is what made an inner chain leg invisible: the job was recorded
 * under the chain's alias ('nanobanana') at depth 0, and the admin cost report
 * then priced it at the model's primary rate instead of the ~2.7x official leg.
 *
 * `routedGateway` is the last-resort answer for an adapter that does no failover
 * at all (single-gateway, mock) — there the routed gateway IS the serving leg.
 */
export function resolveServingLeg(
  meta: Record<string, unknown> | undefined,
  routedGateway: string,
): { gatewayUsed: string; fallbackDepth: number } {
  const servedBy = meta?.['servedBy'];
  const depth = meta?.['fallbackDepth'];
  return {
    gatewayUsed: typeof servedBy === 'string' && servedBy ? servedBy : routedGateway,
    fallbackDepth: typeof depth === 'number' && Number.isFinite(depth) ? depth : 0,
  };
}

export function computeSpent(
  model: { kind: string },
  assetCount: number,
  reserved: number,
  // Resolved effective per-image rate the API charged (jobs.credit_unit_cost),
  // including any per-generated-image reference add-on.
  creditUnitCost: number | null,
  params: Record<string, unknown>,
): number {
  // For image kinds, each returned asset is a billable unit. Video bills by
  // requested duration (already locked at reserve time), so the reserved
  // amount IS the spend unless we got zero assets back.
  if (model.kind === 'video') return assetCount > 0 ? reserved : 0;
  // Settle at the SAME effective per-image rate the API charged so, for a
  // fully-delivered request, spend == reserved (estimate==charge==settlement).
  // A partial delivery pays only for the assets returned; capped at reserved
  // defensively.
  if (creditUnitCost != null && creditUnitCost > 0) {
    return Math.min(assetCount * creditUnitCost, reserved);
  }
  if (!hasSafeRequestedImageCount(params)) throw manualReconciliationError();
  const requested = params['n'] as number;
  return Math.min(reserved, Math.ceil((reserved * assetCount) / requested));
}

export interface RunJobInput {
  jobId: string;
  log: Logger;
  /**
   * Correlation id minted by the API on POST /v1/jobs and persisted
   * into the outbox payload. We re-emit it on every downstream
   * outbox row so a single `grep "<reqId>"` traces the request from
   * api → worker → credits.commit / refund.
   */
  reqId?: string;
  /** BullMQ attempt bookkeeping so the LAST attempt fails cleanly (refund)
   * instead of looping a retryable error forever. */
  attempt?: number;
  maxAttempts?: number;
  /** Override the asset store. Defaults to the module-level AssetStorage; tests
   * inject a stub to simulate a mid-stream upload failure. */
  storage?: StorageLike;
  /** Provider factory seam for lifecycle tests. */
  adapterFactory?: ProviderAdapterFactory;
  /** Faststart remux seam for lifecycle failure-path tests. */
  remuxVideo?: (bytes: Buffer, extension: string) => Promise<Buffer>;
  /** Delivered-frame measurement seam (finance rev. 20 §2). Tests inject a size
   * without needing ffprobe or a real encoded asset. */
  measureFrame?: (
    bytes: Buffer,
    extension: string,
  ) => Promise<{ width: number; height: number } | null>;
}

export type RunJobOutcome = 'succeeded' | 'failed' | 'skipped';

// Generation jobs that are marooned in `running` are recovered by the periodic
// reaper (`apps/worker/src/reaper.ts`), which atomically fails the row and writes
// the refund outbox entry. Keep the runner's guarded terminal updates aligned
// with that reaper race; a stale W1 TODO must not suggest this money-safety gate
// is still missing.
export async function runJob(input: RunJobInput): Promise<RunJobOutcome> {
  const { jobId, log, reqId } = input;
  const storage = input.storage ?? defaultStorage;
  const adapterFactory = input.adapterFactory ?? defaultAdapterFactory;
  const remuxVideo = input.remuxVideo ?? remuxVideoFaststart;
  const measureFrame = input.measureFrame ?? measureAssetFrame;
  const rows = await db
    .select({ job: jobs, workflow: workflows, model: models })
    .from(jobs)
    .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
    .innerJoin(models, eq(models.id, jobs.modelId))
    .where(eq(jobs.id, jobId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    log.warn({ jobId }, 'job not found, skipping');
    return 'skipped';
  }
  const { job, workflow, model } = row;
  if (job.status !== 'queued') {
    log.info({ jobId, status: job.status }, 'job not in queued state, skipping');
    return 'skipped';
  }

  // Claim the row atomically (status='queued' → 'running'). The conditional
  // guard closes the race with the queued-reaper: if the reaper already flipped
  // this stale job to failed+refunded, the claim updates zero rows and we skip
  // — never resurrecting a job whose credits were already returned.
  const claimed = await db
    .update(jobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  if (claimed.length === 0) {
    log.info({ jobId }, 'job already claimed/reaped, skipping');
    return 'skipped';
  }
  publishJobEvent({ userId: job.userId, jobId, status: 'running', source: 'generation' });

  const parsedSnapshot =
    job.executionSnapshot == null ? null : parseExecutionSnapshot(job.executionSnapshot);
  if (parsedSnapshot && !parsedSnapshot.ok) {
    const message = 'invalid_execution_snapshot: queued job facts failed validation';
    log.error({ jobId, issues: parsedSnapshot.error.issues }, message);
    await failClaimedJobWithRefund(job, 'invalid_execution_snapshot', message, reqId);
    publishJobEvent({ userId: job.userId, jobId, status: 'failed', source: 'generation' });
    return 'failed';
  }
  const executionSnapshot: ExecutionSnapshot | null = parsedSnapshot?.snapshot ?? null;
  if (executionSnapshot) {
    const mismatch = executionSnapshotMismatch(job, executionSnapshot);
    if (mismatch) {
      const message = `${EXECUTION_SNAPSHOT_MISMATCH}: ${mismatch}`;
      log.error({ jobId, mismatch }, message);
      await failClaimedJobWithRefund(job, EXECUTION_SNAPSHOT_MISMATCH, message, reqId);
      publishJobEvent({ userId: job.userId, jobId, status: 'failed', source: 'generation' });
      return 'failed';
    }
  }
  if (!executionSnapshot && process.env.REQUIRE_EXECUTION_SNAPSHOT === '1') {
    const message =
      'missing_execution_snapshot: refusing a queued job without immutable execution facts';
    log.error({ jobId }, message);
    await failClaimedJobWithRefund(job, 'missing_execution_snapshot', message, reqId);
    publishJobEvent({ userId: job.userId, jobId, status: 'failed', source: 'generation' });
    return 'failed';
  }
  if (!executionSnapshot) legacyUnsnapshottedJobsTotal.inc();

  // New jobs execute from the snapshot. The live model row remains available
  // only as the compatibility fallback for legacy rows created before B4.
  const executionModel = executionSnapshot
    ? {
        // `id` is the immutable FK already stored on the job. Every mutable
        // provider-facing field below comes from the snapshot, not this live
        // join.
        id: model.id,
        provider: executionSnapshot.model.provider as typeof model.provider,
        kind: executionSnapshot.model.kind as typeof model.kind,
        providerModelId: executionSnapshot.model.providerModelId,
        providerEndpoint: executionSnapshot.model.providerEndpoint,
        gatewayOverride: executionSnapshot.model.gatewayOverride,
        fallbackGateway: executionSnapshot.model.fallbackGateway,
        capabilities: executionSnapshot.model.capabilities,
        maxDurationSeconds: executionSnapshot.model.maxDurationSeconds,
      }
    : model;
  const executionParams = executionSnapshot?.validatedRequest.params ?? workflow.params;
  const executionPrompt =
    executionSnapshot?.validatedRequest.prompt ??
    (workflow.params['prompt'] as string | undefined) ??
    '';
  const executionReferenceAssets =
    executionSnapshot?.validatedRequest.referenceAssets ?? workflow.referenceAssets;

  // Legacy images without a reserve-time unit rate cannot settle safely unless
  // they persisted a valid requested count. Reject immediately after claim,
  // before gateway resolution or adapter construction can reach a paid vendor.
  if (requiresManualReconciliation(executionModel, job.creditUnitCost, executionParams)) {
    const err = manualReconciliationError();
    log.error({ jobId, err }, 'job cannot be settled safely; refusing before provider call');
    await failClaimedJobWithRefund(job, err.code, err.message, reqId);
    publishJobEvent({ userId: job.userId, jobId, status: 'failed', source: 'generation' });
    return 'failed';
  }

  // Per-job gateway selection (dev dropdown → workflow.params.__gateway). Active
  // models pin their own routing, so there is no global env default.
  // Unconfigured/unknown gateway → zero-spend stub.
  //
  // AI_PROVIDER=mock is a HARD override (generate-ux-excellence-plan Phase 0): it
  // forces the offline MockGatewayAdapter for EVERY generation job — sample
  // assets, staged progress, simulated usage — regardless of the per-job
  // __gateway dropdown, so all /generate UX work runs at zero provider spend and
  // never reaches OpenRouter. Scoped to this generation path only; Studio renders
  // (studio-render.ts) stay real and untouched.
  // BL-11: AI_PROVIDER=mock hands out FREE fake assets. Honour it in dev/CI, but
  // fail closed in a production NODE_ENV (unless ALLOW_MOCK_IN_PROD is armed) so a
  // leaked env can't silently break revenue — fall through to the real provider.
  const mockRequested = process.env.AI_PROVIDER === 'mock';
  const useMock = mockRequested && isMockProviderAllowed();
  if (mockRequested && !useMock) {
    log.warn(
      { jobId, nodeEnv: process.env.NODE_ENV },
      'AI_PROVIDER=mock ignored in production (set ALLOW_MOCK_IN_PROD=1 to override) — using real provider',
    );
  }
  const gateway = executionSnapshot
    ? (executionSnapshot.effectiveGateway ?? undefined)
    : typeof executionParams['__gateway'] === 'string'
      ? (executionParams['__gateway'] as string)
      : undefined;
  // Per-model fallback (models.fallback_gateway, admin-editable in /admin/models):
  // wraps the resolved primary gateway in a CircuitBreakerAdapter so a primary
  // outage automatically retries via the fallback instead of failing the job.
  // No global PROVIDER_GATEWAY default: every model must declare explicit routing.
  const resolvedPrimaryGateway = useMock ? 'mock' : gateway;
  if (!resolvedPrimaryGateway) {
    throw new Error(
      `job ${jobId}: no primary gateway resolved for model ${executionModel.id}; ` +
        'set capabilities.forceGateway, gatewayOverride, or workflow.params.__gateway',
    );
  }
  log.info(
    { jobId, gateway: resolvedPrimaryGateway, fallback: executionModel.fallbackGateway },
    'job gateway',
  );

  if (useMock) {
    // Realistic staged progress: hold the 'running' phase ~1.5–3s (override via
    // MOCK_LATENCY_MS) so the Stage's generating treatment is observable across
    // the SSE queued→running→succeeded sequence. Mock assets otherwise resolve
    // instantly, which would skip the generating state entirely.
    const override = Number(process.env.MOCK_LATENCY_MS);
    const ms = Number.isFinite(override) ? override : 1500 + Math.floor(Math.random() * 1500);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Object keys uploaded so far. A mid-stream upload failure (Promise.all
  // rejects on asset N while assets <N are already in MinIO) would otherwise
  // orphan those objects — the credit side is made whole by refund-partial,
  // but the bytes leak. We record every successful put and best-effort delete
  // them on the terminal failure path.
  const uploadedKeys: string[] = [];
  let attemptJournal!: WorkerAttemptJournal;
  let attemptId: string | null = null;
  let providerAccepted = false;
  let providerOutcomeRecorded = false;
  let creditFloorRub = 0;

  try {
    attemptJournal = new WorkerAttemptJournal();
    creditFloorRub = await readConservativeCreditFloorRub(db);
    const attemptContext: RouteAttemptContext | null = routeAttemptContext({
      model: executionModel,
      params: executionParams,
      referenceAssets: executionReferenceAssets,
      revenueRub: job.creditsReserved * creditFloorRub,
    });
    const spec: WorkflowSpec = {
      modelId: executionModel.id,
      // The official-OpenRouter leg books its ₽ loss against finance's cap BEFORE
      // it submits, keyed on this id — and refuses to submit without it, because a
      // reservation nothing can settle would hold budget forever.
      jobId: job.id,
      providerModelId: executionModel.providerModelId,
      providerEndpoint: executionModel.providerEndpoint,
      kind: executionModel.kind,
      prompt: executionPrompt,
      params: executionParams,
      referenceAssets: executionReferenceAssets,
      maxDurationSeconds: executionModel.maxDurationSeconds,
      capabilities: executionModel.capabilities,
      ...(attemptContext ? { attemptContext: { legs: attemptContext.legs } } : {}),
    };
    const adapterOptions: AdapterOptions = { attemptJournal };
    // Construct the adapter INSIDE the try so a fail-closed config error (e.g.
    // KieUnarmedError from an unarmed prod kie gateway) becomes a terminal
    // failed+refund via the catch below, instead of an uncaught escape that leaves
    // the already-'running' job stuck until the reaper reclaims it.
    const adapter = useMock
      ? adapterFactory.getAdapter('mock', adapterOptions)
      : adapterFactory.getAdapterWithFallback(
          gateway,
          executionModel.fallbackGateway,
          adapterOptions,
          adapterRouteRequest(executionModel, executionParams, executionReferenceAssets),
        );
    let handle: GenerationHandle;
    // Adapter that resolves the handle. On a resume it is bound to the gateway
    // that minted the persisted handle, NOT the routing-resolved `adapter`.
    let resolveAdapter: ProviderAdapter = adapter;
    const parsed = job.providerJobId ? parseResumeToken(job.providerJobId) : null;
    const recovery = job.providerJobId ? null : await attemptJournal.recovery(jobId);
    const recoveryAdapter =
      recovery?.outcome === 'accepted' && recovery.providerJobId
        ? adapterFactory.getResumeAdapter(recovery.gateway, adapterOptions)
        : null;
    const boundAdapter = parsed
      ? adapterFactory.getResumeAdapter(parsed.gateway, adapterOptions)
      : null;
    // Set ONLY when we actually resume that handle — an unbindable token falls
    // through to a fresh submit below, where routing (not the token) picks the leg.
    let resumedGateway: string | null = null;
    if (recovery?.outcome === 'accepted' && recovery.providerJobId && recoveryAdapter) {
      handle = { providerJobId: recovery.providerJobId, gateway: recovery.gateway };
      resolveAdapter = recoveryAdapter;
      attemptId = recovery.id;
      attemptJournal.rememberAttempt(recovery.id, recovery.legIdentity);
      providerAccepted = true;
      resumedGateway = recovery.gateway;
      log.warn(
        { jobId, gateway: recovery.gateway, providerJobId: recovery.providerJobId },
        'recovered accepted provider handle from attempt journal after job-token loss',
      );
      if (handle.gateway) {
        await db
          .update(jobs)
          .set({ providerJobId: encodeResumeToken(handle.gateway, handle.providerJobId) })
          .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')));
      }
    } else if (recovery && recovery.outcome !== 'accepted') {
      throw ambiguousRecoveryError(
        recovery.outcome === 'ambiguous'
          ? 'an earlier submit has an ambiguous durable outcome'
          : 'an earlier submit has only an intent row; its provider outcome cannot be proven',
      );
    } else if (recovery?.outcome === 'accepted' && recovery.providerJobId && !recoveryAdapter) {
      throw ambiguousRecoveryError(
        `accepted provider handle cannot be safely rebound through gateway '${recovery.gateway}'`,
      );
    } else if (parsed && boundAdapter) {
      handle = { providerJobId: parsed.providerJobId, gateway: parsed.gateway };
      resolveAdapter = boundAdapter;
      attemptId = await attemptJournal.findAttempt(jobId, parsed.providerJobId);
      providerAccepted = attemptId !== null;
      resumedGateway = parsed.gateway;
      log.info(
        { jobId, gateway: parsed.gateway, providerJobId: parsed.providerJobId },
        'resuming provider job via bound gateway',
      );
    } else {
      if (job.providerJobId) {
        // A persisted handle we cannot bind: a legacy bare id (pre-composite),
        // an unknown/removed gateway, or a gateway that refused to build (mock
        // in prod). Polling it against current routing risks fetching the wrong
        // vendor's output, so submit a fresh generation instead — the company
        // absorbs the prior provider cost (docs/platform/provider-output-retry-billing.md §1).
        log.warn(
          { jobId, stored: job.providerJobId },
          'persisted provider handle not bindable to its gateway — submitting fresh generation (company absorbs prior provider cost)',
        );
      }
      handle = await adapter.generate(spec);
      attemptId = handle.attemptId ?? null;
      providerAccepted = attemptId !== null;
      // Persist the provider handle before polling/downloading so a retry
      // resumes it instead of submitting a second paid provider job. The value
      // is `${gateway}::${providerJobId}` so the retry re-binds to the SAME
      // vendor. Sync handles (inlineResult attached) use synthetic ids that
      // cannot be resumed — never persist them. An async handle with no gateway
      // stamp is unbindable (a retry could only poll it against current routing,
      // risking a wrong-vendor poll), so we skip persisting and let the retry
      // regenerate (company absorbs).
      if (!handle.inlineResult) {
        if (handle.gateway) {
          await db
            .update(jobs)
            .set({ providerJobId: encodeResumeToken(handle.gateway, handle.providerJobId) })
            .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')));
        } else {
          log.warn(
            { jobId, providerJobId: handle.providerJobId },
            'async provider handle has no gateway stamp — not persisting (unbindable on retry)',
          );
        }
      }
    }
    const result = await resolveAdapter.awaitResult(handle, spec);
    const baseGalleryKind: 'image' | 'video' = executionModel.kind === 'video' ? 'video' : 'image';
    const galleryKinds = new Map<(typeof result.assets)[number], 'image' | 'video'>();
    for (const asset of result.assets) {
      galleryKinds.set(
        asset,
        executionModel.kind === 'video' && asset.contentType.startsWith('image/')
          ? 'image'
          : baseGalleryKind,
      );
    }

    // Free-tier branding (owner 2026-07-25): stamp every asset BEFORE upload
    // when the user lacks the paid-media-storage entitlement, so the stored
    // bytes carry the mark on every surface. Runs before last-frame extraction
    // so the extracted still inherits the mark. Fail-open: a broken stamp must
    // not kill a finished paid provider job — log and deliver unmarked.
    if (!(await hasPaidMediaStorage(db, job.userId))) {
      for (const asset of result.assets) {
        try {
          asset.bytes = await watermarkAsset(asset.bytes, executionModel.kind, asset.extension);
        } catch (err) {
          log.error({ jobId, err }, 'watermark failed — delivering asset unmarked');
        }
      }
    }

    // Uniform «Продолжить»: when the job asked for the last frame but the
    // gateway returned only video (OpenRouter has no return_last_frame),
    // extract it locally so extend behaves the same on every gateway.
    if (executionModel.kind === 'video' && executionParams['return_last_frame'] === true) {
      const hasStill = result.assets.some((asset) => galleryKinds.get(asset) === 'image');
      const video = result.assets.find((asset) => galleryKinds.get(asset) === 'video');
      if (!hasStill && video) {
        const frame = await extractLastFrame(video.bytes, video.extension);
        if (frame) {
          const extractedStill = {
            bytes: frame.bytes,
            contentType: frame.contentType,
            extension: frame.extension,
          };
          result.assets.push(extractedStill);
          galleryKinds.set(extractedStill, 'image');
        }
      }
    }

    // A resumed job was minted by the leaf gateway stamped in its resume token,
    // and only a PRIMARY/leg-0 handle is ever pollable (fallback legs resolve
    // inline), so a bound resume is depth 0 on that gateway.
    const servingLeg = resolveServingLeg(result.meta, resumedGateway ?? resolvedPrimaryGateway);

    // Finance rev. 20 §2: record the measured rank on the job. The bytes are already in
    // memory (the watermark path holds them), so this is one ffprobe per delivered asset
    // on a path that has just spent tens of seconds waiting on a vendor.
    //
    // Measured on the assets the rung was SOLD for — those whose gallery kind matches the
    // model's kind. There is deliberately no `?? assets[0]` fallback: on a video job the
    // extracted last-frame still is also in `result.assets`, and measuring it when no
    // video came back would record a still's frame size as a successful video delivery.
    // No asset of the sold kind means nothing to judge, which is `unknown`.
    //
    // A multi-image job (n > 1) is judged by its WORST asset. Kie and OpenRouter fan the
    // outputs out independently, so one full-size and one undersized image is a real
    // shape; charging in full because the first one happened to be fine — or refunding
    // because it happened to be the small one — would both be accidents of ordering.
    //
    // Fail-open at every step: `measureAssetFrame` returns null on any probe error and
    // `judgeDeliveredRank` answers 'unknown' — never 'downgraded' — for an asset it could
    // not read. An unmeasured job settles exactly as it always did.
    const soldKindAssets = result.assets.filter(
      (asset) => (galleryKinds.get(asset) ?? baseGalleryKind) === baseGalleryKind,
    );
    // SEQUENTIAL, not Promise.all. Each probe copies its asset to the container's temp
    // storage, and some providers accept n=15 — fifteen concurrent copies of a
    // large asset, multiplied by worker concurrency, is a way to run the disk out from
    // under the upload and settle work that follows. One temp file per job at a time
    // keeps the aggregate no worse than the single-asset case; the cost is a few tens of
    // milliseconds per asset on a path that just waited tens of seconds on a vendor.
    const measuredFrames: ({ width: number; height: number } | null)[] = [];
    for (const asset of soldKindAssets) {
      measuredFrames.push(await measureFrame(asset.bytes, asset.extension));
    }
    const worstFrame = measuredFrames.reduce<{ width: number; height: number } | null>(
      (worst, frame) =>
        frame === null || worst === null
          ? null // one unmeasurable asset makes the whole job unmeasurable, not "small"
          : frame.width * frame.height < worst.width * worst.height
            ? frame
            : worst,
      measuredFrames.length > 0 ? (measuredFrames[0] ?? null) : null,
    );
    // Read from the job's frozen params, NOT via the model's declared ladder: an admin
    // editing capabilities between enqueue and run would otherwise change what this row
    // says was sold, and the weekly under-delivery rate groups by exactly that.
    const soldRung = soldRungFromParams(executionParams);
    const deliveredRank = judgeDeliveredRank(soldRung, worstFrame);
    // The measured AREA is recorded whether or not the rung could be judged. That is the
    // point of the column: the image ladder's per-vendor pixel budgets are unknown today
    // precisely because nothing has ever measured them, and a verdict-gated write would
    // keep them unknown forever. `delivered_rank_status` carries the judgement; this
    // carries the evidence.
    const measuredArea =
      worstFrame && worstFrame.width * worstFrame.height <= 2_147_483_647
        ? worstFrame.width * worstFrame.height
        : null;
    if (deliveredRank.status === 'downgraded') {
      // WARN, not an outbound alert. The per-job money path must not take a network call,
      // and the trigger finance actually specified is a RATE — «>5% over a rolling week» —
      // which is an aggregate over this column, not a per-job event.
      log.warn(
        {
          jobId,
          modelId: executionModel.id,
          soldRung,
          deliveredArea: deliveredRank.area,
          budgetArea: deliveredRank.budget,
          ratio: Number(deliveredRank.ratio.toFixed(4)),
          gateway: servingLeg.gatewayUsed,
        },
        'delivered rank below the rung sold — vendor under-delivered',
      );
    }

    const uploaded = await Promise.all(
      result.assets.map(async (asset, i) => {
        const galleryKind = galleryKinds.get(asset) ?? baseGalleryKind;
        const remuxExtension = faststartExtension(asset.bytes, asset.extension);
        let uploadBytes = asset.bytes;
        if (galleryKind === 'video' && remuxExtension) {
          try {
            uploadBytes = await remuxVideo(asset.bytes, remuxExtension);
          } catch (err) {
            log.warn(
              { jobId, assetIndex: i, err },
              'faststart remux failed — storing original video',
            );
          }
        }
        const main = await storage.put({
          userId: job.userId,
          jobId: job.id,
          index: i,
          bytes: uploadBytes,
          contentType: asset.contentType,
          extension: asset.extension,
        });
        uploadedKeys.push(main.key);
        // Best-effort poster/thumb; null on failure — never blocks the job.
        const thumb = await makeThumbnail({
          bytes: uploadBytes,
          kind: galleryKind,
          extension: asset.extension,
        });
        let thumbnailUrl: string | null = null;
        if (thumb) {
          const put = await storage
            .put({
              userId: job.userId,
              jobId: job.id,
              index: i,
              bytes: thumb.bytes,
              contentType: thumb.contentType,
              extension: `thumb.${thumb.extension}`,
            })
            .catch(() => null);
          if (put) uploadedKeys.push(put.key);
          thumbnailUrl = put?.url ?? null;
        }
        // M-1: carry the provider's per-asset NSFW self-moderation flag through
        // so the gallery row can be tagged below.
        return {
          url: main.url,
          thumbnailUrl,
          nsfw: asset.nsfw === true,
          mimeType: asset.contentType,
          sizeBytes: uploadBytes.length,
          kind: galleryKind,
        };
      }),
    );

    const assetUrls = uploaded.map((u) => u.url);
    const spentAmount = computeSpent(
      executionModel,
      uploaded.length,
      job.creditsReserved,
      job.creditUnitCost,
      executionParams,
    );
    const unspent = job.creditsReserved - spentAmount;

    // Status update + ledger enqueue + gallery_items insert land in one
    // tx via the outbox so a Redis hiccup between them can't leave a
    // 'succeeded' job without a commit ever firing.
    const settled = await db.transaction(async (tx) => {
      await lockMediaStorageUser(tx, job.userId);
      const expiresAt = mediaExpiresAt(await hasPaidMediaStorage(tx, job.userId));
      // M3: settle ONLY if the job is still running. If the reaper (or a cancel)
      // already moved it to failed/timeout and refunded creditsReserved, this
      // conditional UPDATE returns 0 rows — we must NOT resurrect the row to
      // 'succeeded', which would double-settle credits and gift a free
      // generation. Mirrors the studio render runner's guarded settle.
      const claimed = await tx
        .update(jobs)
        .set({
          status: 'succeeded',
          finishedAt: new Date(),
          creditsSpent: spentAmount,
          resultAssets: assetUrls,
          providerJobId: handle.providerJobId,
          gatewayUsed: servingLeg.gatewayUsed,
          usedFallback: servingLeg.fallbackDepth > 0,
          fallbackDepth: servingLeg.fallbackDepth,
          deliveredPixels: measuredArea,
          deliveredRankStatus: deliveredRank.status,
          // The rung as SOLD, frozen here. It is not recoverable later: a job queued at
          // '1080p' whose model has its ladder edited before the worker runs would read
          // back as a different rung entirely, and the weekly under-delivery rate has to
          // group by what the customer actually bought.
          deliveredRankSold: soldRung,
        })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
        .returning({ id: jobs.id });

      // Finance's 2026-08-02 cap on the chain's third leg (Ask 8 b). The leg
      // RESERVED each of this job's submits before it made them; this closes
      // those reservations at what they really cost and really earned. A no-op
      // for every job that did not use the leg.
      //
      // It runs on BOTH sides of the claim, and inside this transaction either
      // way. A lost claim means the reaper (or a cancel) already terminated and
      // refunded the job while the provider was still paid — the leg's worst
      // outcome, zero credits and full cost. Settling that from a SEPARATE
      // transaction after the fact was the one settlement with nothing behind
      // it: if it failed, the job was already terminal, so the redelivered
      // `runJob` skipped it and the reservation was never finalized.
      await settleOfficialLegJob(
        {
          jobId,
          creditsSpent: claimed.length === 0 ? 0 : spentAmount,
          ...officialLegInvoiceOf(result.meta),
        },
        tx,
        log,
      );
      if (claimed.length === 0) return false;

      // The API validated ownership when it persisted projectId. Re-lock the
      // same live, user-scoped project here because soft-delete is an UPDATE
      // (so an FK cascade cannot protect completion from racing deletion).
      let liveProjectId: string | null = null;
      if (job.projectId) {
        const [project] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, job.projectId),
              eq(projects.userId, job.userId),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1)
          .for('update');
        liveProjectId = project?.id ?? null;
      }

      // One gallery_items row per produced asset. `kind` follows the asset
      // media type so mixed video + extracted-still results render correctly.
      // M-1: tag provider-flagged NSFW assets so curation never features them
      // to the public /showcase (items are private by default; featuring is the
      // gate). We tag rather than block — soft NSFW is left to the model's own
      // judgement, only the prompt pre-screen hard-blocks (CSAE).
      for (const [assetIndex, asset] of uploaded.entries()) {
        const assetId = nid();
        await tx.insert(galleryItems).values({
          id: assetId,
          userId: job.userId,
          originProjectId: liveProjectId,
          jobId: job.id,
          assetUrl: asset.url,
          thumbnailUrl: asset.thumbnailUrl,
          kind: asset.kind,
          title: generatedMediaTitle({
            prompt: spec.prompt,
            kind: asset.kind,
            outputIndex: assetIndex + 1,
            outputCount: uploaded.length,
          }),
          sourceKind: 'generation',
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          tags: asset.nsfw ? ['nsfw'] : [],
          expiresAt,
        });
        if (liveProjectId) {
          await tx
            .insert(projectAssets)
            .values({ projectId: liveProjectId, assetId, userId: job.userId })
            .onConflictDoNothing();
        }
      }

      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_COMMIT_QUEUE,
        jobId: `commit-${job.id}`,
        payload: {
          userId: job.userId,
          jobId: job.id,
          amount: spentAmount,
          idempotencyKey: `job:${job.id}:commit`,
          reason: 'job.commit',
          ...(reqId ? { _reqId: reqId } : {}),
        },
      });
      if (unspent > 0) {
        await enqueueViaOutbox({
          tx,
          queueName: CREDIT_REFUND_QUEUE,
          jobId: `refund-partial-${job.id}`,
          payload: {
            userId: job.userId,
            jobId: job.id,
            amount: unspent,
            reason: 'partial.unused',
            idempotencyKey: `job:${job.id}:refund-partial`,
            ...(reqId ? { _reqId: reqId } : {}),
          },
        });
      }
      return true;
    });
    if (attemptId && attemptJournal.recordOutcome) {
      const invoice = providerInvoiceRub(result.meta, attemptContext, servingLeg.gatewayUsed);
      await attemptJournal
        .recordOutcome({
          attemptId,
          outcome: settled ? 'succeeded' : 'failed',
          revenueRub: settled ? spentAmount * creditFloorRub : 0,
          ...(invoice
            ? { vendorReportedCostRub: invoice.rub, costSource: 'invoiced' as const }
            : {
                costSource: 'configured' as const,
                costNote: settled ? 'no_invoice' : 'job_terminal_before_settle',
              }),
        })
        .catch((journalErr: unknown) => {
          // The job is already terminal here. Do not reverse a customer
          // settlement because an observation write is temporarily unavailable;
          // the accepted row remains visible for a later forensic repair.
          log.error({ jobId, err: journalErr }, 'route attempt outcome could not be recorded');
        });
      providerOutcomeRecorded = true;
    }
    if (!settled) {
      // The reaper/cancel already terminated + refunded this job. Drop the
      // objects we just uploaded so they don't dangle, and skip the commit and
      // gallery insert — settling now would double-pay.
      await storage.removeObjects(uploadedKeys).catch(() => {});
      log.info({ jobId }, 'job finished after terminal state changed, suppressing output');
      return 'skipped';
    }
    // meta carries gateway-reported real cost (OpenRouter usage.cost in USD) —
    // greppable margin signal vs the credits we charged.
    log.info({ jobId, assets: assetUrls.length, providerMeta: result.meta }, 'job succeeded');
    publishJobEvent({ userId: job.userId, jobId, status: 'succeeded', source: 'generation' });
    return 'succeeded';
  } catch (err) {
    if (attemptId && providerAccepted && !providerOutcomeRecorded && attemptJournal.recordOutcome) {
      await attemptJournal
        .recordOutcome({
          attemptId,
          outcome: 'failed',
          revenueRub: 0,
          costSource: 'configured',
          costNote: 'provider_accepted_job_processing_failed',
        })
        .catch((journalErr: unknown) => {
          log.error(
            { jobId, err: journalErr },
            'route attempt failure outcome could not be recorded',
          );
        });
    }
    const code = err instanceof ProviderError ? err.code : 'INTERNAL';
    const message = (err as Error).message ?? 'unknown error';
    const providerRetryable = err instanceof ProviderError && err.retryable;
    // Only retry while BullMQ attempts remain; on the final attempt fall through
    // to the failed+refund path so the user isn't left with a stuck job.
    const attemptsLeft = (input.maxAttempts ?? 1) - (input.attempt ?? 0) - 1 > 0;
    const retryable = providerRetryable && attemptsLeft;
    log.error(
      { jobId, err, retryable, attempt: input.attempt, max: input.maxAttempts },
      'job errored',
    );

    if (retryable) {
      // Hand back to BullMQ for retry. Reset status to 'queued' so the next
      // runJob attempt doesn't skip-as-already-running, and DO NOT enqueue a
      // refund — we still owe the user a real result. Uploaded keys are
      // deterministic (`user/job/index.ext`), so the retry overwrites them in
      // place — nothing to clean up here.
      //
      // GUARDED ON `running`, and that guard is the whole point. The reaper flips a
      // stuck job to failed and enqueues a refund in one transaction (`reaper.ts`).
      // Without the predicate this update would move that already-refunded job back to
      // `queued`, the claim at the top of runJob would succeed because it requires
      // exactly `queued`, and the vendor would be paid a second time for a generation
      // the customer has already been refunded for. The claim site 400 lines above
      // carries this same guard and says so in its own comment; this site did not.
      const revived = await db
        .update(jobs)
        .set({ status: 'queued', startedAt: null, requeuedAt: new Date() })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
        .returning({ id: jobs.id });
      if (revived.length === 0) {
        log.warn({ jobId }, 'job no longer running (reaped/refunded) — not requeueing');
        throw err;
      }
      publishJobEvent({ userId: job.userId, jobId, status: 'queued', source: 'generation' });
      throw err;
    }

    // Terminal failure: delete any objects this attempt already uploaded so a
    // mid-stream upload failure doesn't orphan them. Best-effort — a cleanup
    // failure is logged but must NOT mask the original error or block the
    // refund (the user is still made whole via the refund below).
    if (uploadedKeys.length > 0) {
      await storage.removeObjects(uploadedKeys).catch((cleanupErr: unknown) => {
        log.error(
          { jobId, keys: uploadedKeys, err: cleanupErr },
          'partial-upload cleanup failed (objects may leak)',
        );
      });
    }

    await db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorCode: code,
          errorMessage: message.slice(0, 1000),
        })
        .where(eq(jobs.id, jobId));

      // If the official-OpenRouter leg reserved for this job, the money is gone
      // and the customer is being refunded below — a 100% loss, and the single
      // largest class the old counter missed. It covers everything that lands
      // here: a response with no usable asset, a fan-out that failed after its
      // siblings were billed, a watermark/upload/thumbnail crash after
      // generation. Zero credits, and no invoice figure to correct the reserved
      // cost with (`result` never came back), so the reservation stands as the
      // cost. A no-op for every job that did not use the leg.
      await settleOfficialLegJob({ jobId, creditsSpent: 0, costNote: 'no_invoice' }, tx, log);

      await enqueueViaOutbox({
        tx,
        queueName: CREDIT_REFUND_QUEUE,
        jobId: `refund-${job.id}`,
        payload: {
          userId: job.userId,
          jobId: job.id,
          amount: job.creditsReserved,
          reason: `provider.failed:${code}`,
          idempotencyKey: `job:${job.id}:refund`,
          ...(reqId ? { _reqId: reqId } : {}),
        },
      });
    });

    publishJobEvent({ userId: job.userId, jobId, status: 'failed', source: 'generation' });
    return 'failed';
  }
}
