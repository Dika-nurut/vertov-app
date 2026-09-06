import {
  db,
  nid,
  routeAttemptJournal,
  routeLegHealth,
  jobs,
  models,
  workflows,
  usersApp,
  studioRenders,
  outboxJobs,
  type StudioRenderSpec,
} from '@seed/db';
import type { ExecutionSnapshot } from '@seed/shared/execution-snapshot';
import { like } from 'drizzle-orm';

/**
 * Seed helpers for the integration harness (T3). Everything inserted here is
 * tagged with the `it-` id prefix so {@link cleanupIntegrationData} can wipe a
 * run's rows from the ephemeral DB without a full re-migrate between specs.
 */

const PREFIX = 'it-';
export const itId = (label: string) => `${PREFIX}${label}-${nid()}`;

export interface SeedUserOpts {
  tier?: 'free' | 'start' | 'creator' | 'studio' | 'plus' | 'pro' | 'max';
}

export async function seedUser(opts: SeedUserOpts = {}): Promise<string> {
  const id = itId('user');
  await db.insert(usersApp).values({ id, tier: opts.tier ?? 'studio', status: 'active' });
  return id;
}

export interface SeedModelOpts {
  kind: 'image' | 'video';
  maxDurationSeconds?: number | null;
  /** Model-row capability bag — e.g. the official leg's opt-in slug + rung costs. */
  capabilities?: Record<string, unknown>;
}

export async function seedModel(opts: SeedModelOpts): Promise<string> {
  const id = itId(`model-${opts.kind}`);
  await db.insert(models).values({
    id,
    provider: 'byteplus',
    family: opts.kind === 'video' ? 'seedance' : 'seedream',
    variant: 'test',
    kind: opts.kind,
    isActive: true,
    tierMin: 'free',
    unitKind: opts.kind === 'video' ? 'second' : 'image',
    expectedLatencyMsP50: 1000,
    expectedLatencyMsP95: 5000,
    maxDurationSeconds: opts.maxDurationSeconds ?? (opts.kind === 'video' ? 5 : null),
    maxResolution: '1080p',
    providerModelId: opts.kind === 'video' ? 'seedance-1-0' : 'seedream-4-5',
    providerEndpoint:
      opts.kind === 'video' ? '/api/v3/videos/generations' : '/api/v3/images/generations',
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
  });
  return id;
}

export interface SeedJobOpts {
  userId: string;
  modelId: string;
  /** Mock directive object placed on workflow.params.__mock. */
  mock?: Record<string, unknown> | string;
  /** Extra workflow params (prompt, n, gateway override, etc.). */
  params?: Record<string, unknown>;
  creditsReserved?: number;
  creditUnitCost?: number | null;
  executionSnapshot?: ExecutionSnapshot | null;
  projectId?: string | null;
}

/** Seed a workflow + a queued job ready for runJob. Returns the job id. */
export async function seedJob(opts: SeedJobOpts): Promise<{ jobId: string; workflowId: string }> {
  const workflowId = itId('wf');
  await db.insert(workflows).values({
    id: workflowId,
    userId: opts.userId,
    modelId: opts.modelId,
    params: {
      prompt: 'тестовый кадр',
      __gateway: 'mock',
      ...(opts.mock !== undefined ? { __mock: opts.mock } : {}),
      ...(opts.params ?? {}),
    },
    referenceAssets: [],
  });
  const jobId = itId('job');
  await db.insert(jobs).values({
    id: jobId,
    userId: opts.userId,
    workflowId,
    modelId: opts.modelId,
    projectId: opts.projectId ?? null,
    status: 'queued',
    creditsReserved: opts.creditsReserved ?? 50,
    creditUnitCost: opts.creditUnitCost ?? null,
    executionSnapshot: opts.executionSnapshot ?? null,
    idempotencyKey: jobId,
  });
  return { jobId, workflowId };
}

/** Seed a queued studio render over the given spec. Returns the render id. */
export async function seedStudioRender(
  userId: string,
  spec: StudioRenderSpec,
  projectId: string | null = null,
): Promise<string> {
  const id = itId('render');
  await db.insert(studioRenders).values({ id, userId, projectId, status: 'queued', spec });
  return id;
}

/** All outbox rows enqueued for a job (credit commit/refund assertions). */
export async function outboxFor(jobId: string) {
  const rows = await db
    .select()
    .from(outboxJobs)
    .where(like(outboxJobs.jobId, `%${jobId}%`));
  return rows;
}

/** Remove every row this harness created (id prefix `it-`). */
export async function cleanupIntegrationData(): Promise<void> {
  // Children first (FK order): jobs/renders → workflows → users; outbox by job.
  await db.delete(routeAttemptJournal).where(like(routeAttemptJournal.jobId, `${PREFIX}%`));
  await db.delete(routeLegHealth).where(like(routeLegHealth.legIdentity, `${PREFIX}%`));
  await db.delete(jobs).where(like(jobs.id, `${PREFIX}%`));
  await db.delete(studioRenders).where(like(studioRenders.id, `${PREFIX}%`));
  await db.delete(workflows).where(like(workflows.id, `${PREFIX}%`));
  await db.delete(models).where(like(models.id, `${PREFIX}%`));
  await db.delete(usersApp).where(like(usersApp.id, `${PREFIX}%`));
  await db.delete(outboxJobs).where(like(outboxJobs.jobId, `%${PREFIX}%`));
}
