/**
 * Pure decision logic for consuming the shared job-event bus on the Generate
 * screen (B-6). JobsTray owns the single EventSource and rebroadcasts every
 * terminal/progress event as a `seed:job-event` CustomEvent; Generate listens
 * to that instead of running its own per-job poll loop, keeping polling only as
 * a slow fallback for dropped events.
 *
 * Kept side-effect-free (no fetch, no React) so the routing is unit-testable;
 * the client maps the returned action onto fetch + setState.
 */

export interface JobBusEvent {
  jobId: string;
  status: string;
  source: string;
  /** Optional render-stage hint (studio only); ignored by Generate. */
  stage?: string;
}

/** Statuses that mean the job is finished and its full row should be fetched. */
export const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'refunded']);

export type JobEventAction =
  | { kind: 'ignore' }
  /** Terminal: fetch the full /v1/jobs/:id row and apply assets/error. */
  | { kind: 'resolve' }
  /** In-progress update for the on-stage job: reflect the new status only. */
  | { kind: 'progress'; status: string };

export interface JobEventContext {
  /** Jobs this screen submitted and is still tracking (membership test only). */
  tracked: { has(jobId: string): boolean };
  /** The job currently driving the on-stage `phase`, if any. */
  displayedJobId: string | null;
}

/**
 * Decide how Generate should react to a bus event:
 *  - foreign source (studio) or an untracked job → ignore (the tray handles
 *    the global view; Generate only cares about jobs it launched),
 *  - terminal status → resolve (fetch the row; SSE terminal events carry no
 *    assets), for ANY tracked job so background results still land,
 *  - non-terminal status → progress, but only for the on-stage job (background
 *    jobs need no intermediate UI update).
 */
export function jobEventAction(evt: JobBusEvent, ctx: JobEventContext): JobEventAction {
  if (evt.source !== 'generation') return { kind: 'ignore' };
  if (!ctx.tracked.has(evt.jobId)) return { kind: 'ignore' };
  if (TERMINAL_JOB_STATUSES.has(evt.status)) return { kind: 'resolve' };
  if (evt.jobId === ctx.displayedJobId) return { kind: 'progress', status: evt.status };
  return { kind: 'ignore' };
}
