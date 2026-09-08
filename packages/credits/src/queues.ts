/**
 * Queue name constants. Single source of truth so api+worker agree.
 *
 * `credits.commit`/`refund` are the ledger-side queues owned by @seed/credits.
 * `jobs.run` and `auth.email` live here too for now until/unless we split
 * dedicated packages — colocating the constants keeps API and worker aligned.
 */

import type { SupportAttachmentRef } from '@seed/shared/support-attachments';

export const CREDIT_COMMIT_QUEUE = 'credits.commit' as const;
export const CREDIT_REFUND_QUEUE = 'credits.refund' as const;
export const JOB_RUN_QUEUE = 'jobs.run' as const;
/** Studio: server-side ffmpeg timeline render. */
export const STUDIO_RENDER_QUEUE = 'studio.render' as const;
/** Transactional auth email delivery (OTP, magic link, and account notices). */
export const AUTH_EMAIL_QUEUE = 'auth.email' as const;

/**
 * The queues that carry money.
 *
 * A settlement is NEVER abandoned by a retry counter. Dropping one leaves the
 * customer's credits debited from `available` and stranded in `pending` with
 * nothing left to recover them: the claim that scheduled it is already terminal,
 * and the reaper only ever inspects `in_progress` claims. So these rows are
 * exempt from the outbox dead-letter ceiling and their BullMQ jobs retry
 * effectively forever — patiently (capped backoff), but without giving up.
 */
export const SETTLEMENT_QUEUES: readonly string[] = [CREDIT_COMMIT_QUEUE, CREDIT_REFUND_QUEUE];

export function isSettlementQueue(queueName: string): boolean {
  return SETTLEMENT_QUEUES.includes(queueName);
}

/** Base/cap of the settlement retry backoff. */
export const SETTLEMENT_RETRY_BASE_MS = 5_000;
export const SETTLEMENT_RETRY_CAP_MS = 5 * 60_000;

/**
 * Capped exponential backoff for a settlement retry. Capped in BOTH directions
 * that matter: it never hammers a struggling ledger every drain tick, and it
 * never grows into an effective "never" (plain exponential backoff reaches
 * centuries after ~40 attempts, which abandons the money just as surely as a
 * counter does).
 */
export function settlementBackoffMs(
  attemptsMade: number,
  baseMs: number = SETTLEMENT_RETRY_BASE_MS,
): number {
  const exponent = Math.min(Math.max(Math.trunc(attemptsMade), 0), 16);
  return Math.min(SETTLEMENT_RETRY_CAP_MS, baseMs * 2 ** exponent);
}

/**
 * BullMQ options for a settlement job. BullMQ's default is `attempts: 1`, so a
 * single transient ledger blip would permanently fail a charge or a refund whose
 * outbox row is already marked processed. `attempts` here is effectively
 * unbounded (≈9 years at the capped delay), and `removeOnFail: false` keeps a
 * job that somehow exhausts even that visible in the failed set rather than
 * evicting the only remaining record of the debt.
 */
export const SETTLEMENT_ATTEMPTS = 1_000_000;
export const SETTLEMENT_JOB_OPTIONS = {
  attempts: SETTLEMENT_ATTEMPTS,
  backoff: { type: 'custom' },
  removeOnComplete: 100,
  removeOnFail: false,
} as const;

/**
 * Worker settings that back `SETTLEMENT_JOB_OPTIONS.backoff.type = 'custom'`.
 * MUST be passed to the credits commit/refund workers — without it BullMQ has no
 * strategy for a custom backoff and retries with no delay at all.
 */
export const SETTLEMENT_WORKER_SETTINGS = {
  backoffStrategy: (attemptsMade: number): number => settlementBackoffMs(attemptsMade),
};

/**
 * `refund-partial` is the second leg of a reserve-ceiling/settle-actual op (the
 * shot planner): it returns the UNSPENT remainder alongside a commit of the spent
 * part. It MUST stay distinct from `refund` — the reaper and the failure path use
 * `refund` for the WHOLE hold, and one key for both would make a partial return
 * and a full one settle as the same leg.
 */
export type PaidScriptLeg = 'reserve' | 'commit' | 'refund' | 'refund-partial';
/**
 * Canonical credit-settlement idempotency key for a paid Scenario request
 * (assist / structurize). The API route, its lazy stale-reclaim, AND the worker
 * reaper must all compute the SAME key for a given (op, jobId) — a second
 * settlement leg with a different key would hit the ledger's reservation-cover
 * guard (SF-10) and dead-letter forever. `jobId` is the credit reservation id;
 * `op` namespaces it so assist and structurize never collide.
 */
export function paidScriptClaimKey(op: string, jobId: string, leg: PaidScriptLeg): string {
  return `${op}:${jobId}:${leg}`;
}

export interface CreditCommitJob {
  userId: string;
  jobId: string;
  amount: number;
  idempotencyKey: string;
  reason?: string;
  /** Correlation id propagated from the API request. */
  _reqId?: string;
}

export interface CreditRefundJob {
  userId: string;
  jobId: string;
  amount: number;
  reason: string;
  idempotencyKey: string;
  /** Correlation id propagated from the API request. */
  _reqId?: string;
}

export interface JobRunPayload {
  jobId: string;
  /** Correlation id propagated from the API request. */
  _reqId?: string;
}

export interface StudioRenderPayload {
  renderId: string;
  /** Correlation id propagated from the API request. */
  _reqId?: string;
}

export type AuthEmailAttachment = SupportAttachmentRef;

/**
 * The worker receives the already-rendered message so the API request only
 * needs to persist an outbox row.  This payload intentionally contains no
 * auth/session metadata beyond the destination and message itself.
 */
export interface AuthEmailJob {
  to: string;
  subject: string;
  text: string;
  /** Private object-store references for support email attachments. */
  attachments?: SupportAttachmentRef[];
  /** Correlation id propagated from the API request. */
  _reqId?: string;
}
