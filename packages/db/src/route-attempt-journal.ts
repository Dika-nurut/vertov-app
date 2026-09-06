import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { routeAttemptJournal, routeLegHealth } from '../schema/index';
import { db as defaultDb } from './index';
import { nid } from './id';
import { OFFICIAL_LEG_RESERVATION_LOCK } from './official-leg-ledger';
import type { DbRunner } from './credit-floor';

export const ROUTE_HEALTH_FAILURE_THRESHOLD = 3;
export const ROUTE_HEALTH_TTL_MS = 15 * 60 * 1000;

type DbLike = typeof defaultDb;

export interface BeginRouteAttemptInput {
  jobId: string;
  modelId: string;
  rung?: string;
  role?: 'primary' | 'fallback';
  legIdentity: string;
  gateway: string;
  units?: number;
  configuredExpectedCostRub?: number;
  revenueRub?: number;
  submittedAt?: Date;
}

/**
 * Allocate the sibling journal's sequence under the same global advisory lock
 * as official-leg reservations. `max + 1` is therefore safe during retries and
 * a rolling deployment; the unique constraint remains the final backstop.
 */
export async function beginRouteAttempt(
  input: BeginRouteAttemptInput,
  runner: DbLike = defaultDb,
): Promise<{ attemptId: string; attemptSeq: number }> {
  if (!input.legIdentity) throw new Error('route attempt requires executable leg identity');
  const submittedAt = input.submittedAt ?? new Date();
  return runner.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${OFFICIAL_LEG_RESERVATION_LOCK})`);
    const [latest] = await tx
      .select({ maxAttemptSeq: sql<string>`coalesce(max(${routeAttemptJournal.attemptSeq}), 0)` })
      .from(routeAttemptJournal)
      .where(eq(routeAttemptJournal.jobId, input.jobId));
    const attemptSeq = Number(latest?.maxAttemptSeq ?? 0) + 1;
    const attemptId = nid();
    await tx.insert(routeAttemptJournal).values({
      id: attemptId,
      jobId: input.jobId,
      attemptSeq,
      modelId: input.modelId,
      rung: input.rung ?? 'unknown',
      role: input.role ?? 'primary',
      legIdentity: input.legIdentity,
      gateway: input.gateway,
      outcome: 'intent',
      ambiguous: false,
      units: input.units === undefined ? undefined : input.units.toFixed(4),
      configuredExpectedCostRub:
        input.configuredExpectedCostRub === undefined
          ? undefined
          : input.configuredExpectedCostRub.toFixed(4),
      revenueRub: input.revenueRub === undefined ? undefined : input.revenueRub.toFixed(4),
      costSource: 'configured',
      submittedAt,
    });
    return { attemptId, attemptSeq };
  });
}

export async function recordRouteAttemptAccepted(
  attemptId: string,
  providerJobId: string,
  gateway?: string,
  runner: DbRunner = defaultDb,
): Promise<void> {
  await runner
    .update(routeAttemptJournal)
    .set({
      outcome: 'accepted',
      providerJobId,
      ambiguous: false,
      ...(gateway ? { gateway } : {}),
    })
    .where(eq(routeAttemptJournal.id, attemptId));
}

export async function recordRouteAttemptDefinitiveFailure(
  attemptId: string,
  error: unknown,
  runner: DbRunner = defaultDb,
): Promise<void> {
  await runner
    .update(routeAttemptJournal)
    .set({
      outcome: 'definitive_rejection',
      ambiguous: false,
      revenueRub: '0.0000',
      costNote: errorNote(error),
      resolvedAt: new Date(),
    })
    .where(eq(routeAttemptJournal.id, attemptId));
}

export async function recordRouteAttemptAmbiguous(
  attemptId: string,
  error: unknown,
  runner: DbRunner = defaultDb,
): Promise<void> {
  await runner
    .update(routeAttemptJournal)
    .set({
      outcome: 'ambiguous',
      ambiguous: true,
      revenueRub: '0.0000',
      costNote: errorNote(error),
      resolvedAt: new Date(),
    })
    .where(eq(routeAttemptJournal.id, attemptId));
}

export async function recordRouteAttemptOutcome(
  input: {
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    vendorReportedCostRub?: number | null;
    revenueRub?: number | null;
    costSource?: 'invoiced' | 'configured';
    costNote?: string | null;
    resolvedAt?: Date;
  },
  runner: DbRunner = defaultDb,
): Promise<void> {
  await runner
    .update(routeAttemptJournal)
    .set({
      outcome: input.outcome,
      ambiguous: false,
      vendorReportedCostRub:
        input.vendorReportedCostRub === undefined || input.vendorReportedCostRub === null
          ? undefined
          : input.vendorReportedCostRub.toFixed(4),
      revenueRub:
        input.revenueRub === undefined || input.revenueRub === null
          ? undefined
          : input.revenueRub.toFixed(4),
      costSource: input.costSource ?? 'configured',
      costNote: input.costNote ?? null,
      resolvedAt: input.resolvedAt ?? new Date(),
    })
    .where(
      and(eq(routeAttemptJournal.id, input.attemptId), eq(routeAttemptJournal.ambiguous, false)),
    );
}

export interface RouteAttemptObservation {
  id: string;
  jobId: string;
  attemptSeq: number;
  modelId: string;
  rung: string;
  role: string;
  legIdentity: string;
  gateway: string;
  outcome: string;
  ambiguous: boolean;
  configuredExpectedCostRub: number | null;
  vendorReportedCostRub: number | null;
  revenueRub: number | null;
  costSource: string;
  costNote: string | null;
  submittedAt: Date;
  resolvedAt: Date | null;
}

/**
 * `since` is not an optimisation the caller may skip. The journal gains a row per
 * provider submit and is never pruned, and the margin alarm reads it on a timer for
 * the life of the deployment — unbounded, this is a full table scan that grows with
 * every job ever run. The alarm's own 24h window makes the bound free: it discards
 * anything older in memory anyway, so the results are identical.
 *
 * The bound limits the RESULT SET; it needs migration 0082's index to also limit the
 * scan. `route_attempt_journal_leg_rung_submitted_idx` cannot serve a bare
 * `submitted_at` predicate — its two leading columns are unconstrained here.
 */
export async function readRouteAttemptObservations(
  runner: DbRunner = defaultDb,
  since?: Date,
): Promise<RouteAttemptObservation[]> {
  const rows = await (since
    ? runner.select().from(routeAttemptJournal).where(gte(routeAttemptJournal.submittedAt, since))
    : runner.select().from(routeAttemptJournal));
  return rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    attemptSeq: row.attemptSeq,
    modelId: row.modelId,
    rung: row.rung,
    role: row.role,
    legIdentity: row.legIdentity,
    gateway: row.gateway,
    outcome: row.outcome,
    ambiguous: row.ambiguous,
    configuredExpectedCostRub: numberOrNull(row.configuredExpectedCostRub),
    vendorReportedCostRub: numberOrNull(row.vendorReportedCostRub),
    revenueRub: numberOrNull(row.revenueRub),
    costSource: row.costSource,
    costNote: row.costNote,
    submittedAt: row.submittedAt,
    resolvedAt: row.resolvedAt,
  }));
}

export async function readRouteAttemptByProvider(
  jobId: string,
  providerJobId: string,
  runner: DbRunner = defaultDb,
): Promise<{ id: string; legIdentity: string; gateway: string } | null> {
  const [row] = await runner
    .select({
      id: routeAttemptJournal.id,
      legIdentity: routeAttemptJournal.legIdentity,
      gateway: routeAttemptJournal.gateway,
    })
    .from(routeAttemptJournal)
    .where(
      and(
        eq(routeAttemptJournal.jobId, jobId),
        eq(routeAttemptJournal.providerJobId, providerJobId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export interface RouteAttemptRecovery {
  id: string;
  gateway: string;
  legIdentity: string;
  outcome: 'intent' | 'accepted' | 'ambiguous';
  providerJobId: string | null;
}

/** Latest pre-terminal row used only for crash-after-accept/refusal recovery. */
export async function readRouteAttemptRecovery(
  jobId: string,
  runner: DbRunner = defaultDb,
): Promise<RouteAttemptRecovery | null> {
  const [row] = await runner
    .select({
      id: routeAttemptJournal.id,
      gateway: routeAttemptJournal.gateway,
      legIdentity: routeAttemptJournal.legIdentity,
      outcome: routeAttemptJournal.outcome,
      providerJobId: routeAttemptJournal.providerJobId,
    })
    .from(routeAttemptJournal)
    .where(
      and(
        eq(routeAttemptJournal.jobId, jobId),
        inArray(routeAttemptJournal.outcome, ['intent', 'accepted', 'ambiguous']),
      ),
    )
    .orderBy(desc(routeAttemptJournal.attemptSeq))
    .limit(1);
  if (!row) return null;
  if (row.outcome !== 'intent' && row.outcome !== 'accepted' && row.outcome !== 'ambiguous') {
    return null;
  }
  return {
    ...row,
    outcome: row.outcome as RouteAttemptRecovery['outcome'],
  };
}

export interface RouteLegHealthSnapshot {
  legIdentity: string;
  consecutiveSubmitFailures: number;
  lastSubmitFailureAt: Date | null;
  lastSubmitSuccessAt: Date | null;
}

/** The Phase 2 health seam's pure decision, shared by the persisted feed and tests. */
export function routeLegHealthIsHealthy(
  snapshot:
    | Pick<RouteLegHealthSnapshot, 'consecutiveSubmitFailures' | 'lastSubmitFailureAt'>
    | undefined,
  now = new Date(),
): boolean {
  if (!snapshot || snapshot.consecutiveSubmitFailures < ROUTE_HEALTH_FAILURE_THRESHOLD) {
    return true;
  }
  if (!snapshot.lastSubmitFailureAt) return true;
  return now.getTime() - snapshot.lastSubmitFailureAt.getTime() >= ROUTE_HEALTH_TTL_MS;
}

export async function recordRouteLegSubmitFailure(
  legIdentity: string,
  now = new Date(),
  runner: DbRunner = defaultDb,
): Promise<void> {
  const staleBefore = new Date(now.getTime() - ROUTE_HEALTH_TTL_MS);
  await runner.execute(sql`
    INSERT INTO route_leg_health (
      leg_identity, consecutive_submit_failures, last_submit_failure_at,
      last_submit_success_at, updated_at
    ) VALUES (${legIdentity}, 1, ${now}, NULL, ${now})
    ON CONFLICT (leg_identity) DO UPDATE SET
      consecutive_submit_failures = CASE
        WHEN route_leg_health.last_submit_failure_at IS NULL
          OR route_leg_health.last_submit_failure_at <= ${staleBefore}
        THEN 1
        ELSE route_leg_health.consecutive_submit_failures + 1
      END,
      last_submit_failure_at = ${now},
      updated_at = ${now}
  `);
}

export async function recordRouteLegSubmitSuccess(
  legIdentity: string,
  now = new Date(),
  runner: DbRunner = defaultDb,
): Promise<void> {
  await runner.execute(sql`
    INSERT INTO route_leg_health (
      leg_identity, consecutive_submit_failures, last_submit_failure_at,
      last_submit_success_at, updated_at
    ) VALUES (${legIdentity}, 0, NULL, ${now}, ${now})
    ON CONFLICT (leg_identity) DO UPDATE SET
      consecutive_submit_failures = 0,
      last_submit_success_at = ${now},
      updated_at = ${now}
  `);
}

export async function readRouteLegHealth(
  runner: DbRunner = defaultDb,
): Promise<RouteLegHealthSnapshot[]> {
  const rows = await runner.select().from(routeLegHealth);
  return rows.map((row) => ({
    legIdentity: row.legIdentity,
    consecutiveSubmitFailures: row.consecutiveSubmitFailures,
    lastSubmitFailureAt: row.lastSubmitFailureAt,
    lastSubmitSuccessAt: row.lastSubmitSuccessAt,
  }));
}

function errorNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000);
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
