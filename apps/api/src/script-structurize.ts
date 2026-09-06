import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, nid, scripts, scriptAssistRequests } from '@seed/db';
import {
  creditService,
  enqueueViaOutbox,
  InsufficientCreditsError,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  paidScriptClaimKey,
} from '@seed/credits';
import {
  STRUCTURIZE_MODEL,
  STRUCTURIZE_CREDITS,
  STRUCTURIZE_MAX_ATTEMPTS,
  STRUCTURIZE_TOKEN_BUDGET,
  STRUCTURIZE_SOURCE_MAX_CHARS,
  STRUCTURIZE_SOURCE_MAX_BYTES,
  parseOpenAiUsage,
  type AiCallAttempt,
  type AiUsage,
  type ScenarioStructurizeResult,
} from '@seed/shared';
import { egressFetch } from './egress-fetch';
import { dailySpendCap, releaseDailyBudget, reserveDailyBudget } from './spend-guard';
import { checkRateLimit } from './rate-limit';
import { reclaimStaleClaim } from './paid-claim';
import {
  buildStructurizePrompt,
  parseStructurizeOutput,
  StructurizeSchemaError,
  type StructurizeSourceKind,
} from './scenario-structurize';
import { scenarioStructurizeAttempts, scenarioStructurizeRequestsTotal } from './metrics';
import { recordAiUsage } from './ai-usage-store';
import { resolveDeviceCluster } from './device-cluster';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface ScriptStructurizeOptions {
  /** Injectable for tests — MUST mock the gateway, never loop live calls. */
  fetchImpl?: typeof fetch;
  credits?: Pick<typeof creditService, 'reserve' | 'commit' | 'refund'>;
  /** Platform-wide daily provider-spend guard, shared with assist + generation. */
  spend?: { redis: IORedis; cap?: number };
  rateLimit?: { redis: IORedis; max?: number; windowSeconds?: number };
  deadlineMs?: number;
  /** How many times to re-ask the model when its output fails the schema. */
  maxAttempts?: number;
  /** Injectable for tests — simulate an outbox/DB outage on the durable refund. */
  enqueueRefund?: typeof enqueueDurableRefund;
}

const OPENROUTER_URL =
  process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
/** Hard deadline for one structurization (no-infinite-loading doctrine). */
const STRUCTURIZE_DEADLINE_MS = 120_000;
/** Idempotent settlement (commit/refund) retry budget before recording a stuck hold. */
const SETTLE_ATTEMPTS = 3;
/** A crashed free claim may be retried after the bounded provider deadline plus slack. */
const FREE_CLAIM_STALE_MS = 15 * 60 * 1000;

/** Enqueue a durable refund for a reclaimed stale reservation (worker settles it). */
async function enqueueDurableRefund(
  userId: string,
  jobId: string,
  amount: number,
  reqId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await enqueueViaOutbox({
      tx,
      queueName: CREDIT_REFUND_QUEUE,
      payload: {
        userId,
        jobId,
        amount,
        reason: 'script.structurize.stale_reclaim',
        idempotencyKey: paidScriptClaimKey('structurize', jobId, 'refund'),
        _reqId: reqId,
      },
      jobId: `structurize-refund-${jobId}`,
    });
  });
}

/**
 * Thrown when a money transition finds its claim row is no longer ours — it was
 * reclaimed as stale while this handler was delayed. The row's continued
 * existence as `in_progress` IS the lease: a conditional update on it affects
 * zero rows once a reclaimer deletes it, so we abort (rolling back the enclosing
 * transaction) rather than charge without a persisted, replayable result.
 */
class OwnershipLost extends Error {
  constructor() {
    super('structurize claim reclaimed by another request');
    this.name = 'OwnershipLost';
  }
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without splitting a codepoint (the
 * longest char-prefix that fits). Since a BPE token is ≥1 byte, bounding bytes
 * bounds tokens — this is what makes the priced budget fail-closed for dense
 * Cyrillic / emoji / adversarial input, where a chars/token guess would not.
 * Exported for the shot planner, which bounds each scene the same way.
 */
export function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return str.slice(0, lo);
}

/** Fingerprint the structurize source so a reused key can't replay a different input. */
function sourceFingerprint(kind: StructurizeSourceKind, source: string): string {
  return createHash('sha256').update(`${kind}\x00${source}`).digest('hex');
}

const structurizeSourceSchema = z.object({
  idea: z.string().trim().max(STRUCTURIZE_SOURCE_MAX_CHARS).optional(),
});

const structurizeSchema = structurizeSourceSchema.extend({
  /**
   * REQUIRED for this paid endpoint: the client must own a stable key so a
   * response lost after the charge commits is replayable (a server-generated key
   * the client never sees would make the paid output unrecoverable and a retry
   * would double-charge). New endpoint, no legacy clients — required from day one.
   */
  idempotencyKey: z.string().trim().min(8).max(128),
  /** A raw idea to structurize. Omitted → structurize the script's pasted text. */
  expectedCredits: z.number().int().nonnegative().optional(),
  quoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

function structurizeQuoteFingerprint(input: {
  scriptId: string;
  scriptRev: number;
  kind: StructurizeSourceKind;
  sourceHash: string;
  inputBytes: number;
  credits?: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...input,
        credits: input.credits ?? STRUCTURIZE_CREDITS,
        maxInputBytes: STRUCTURIZE_TOKEN_BUDGET.input,
        maxOutputTokens: STRUCTURIZE_TOKEN_BUDGET.output,
      }),
    )
    .digest('hex');
}

export function setupScriptStructurizeRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: ScriptStructurizeOptions = {},
): void {
  // Route OpenRouter through the egress proxy (the raw prod IP is CF-blocked);
  // tests inject their own fetchImpl. Egress is a no-op when EGRESS_PROXY_URL unset.
  const fetchImpl = options.fetchImpl ?? egressFetch;
  const credits = options.credits ?? creditService;
  const enqueueRefund = options.enqueueRefund ?? enqueueDurableRefund;
  // Never make more gateway calls than STRUCTURIZE_CREDITS was priced to cover —
  // the price is derived from STRUCTURIZE_MAX_ATTEMPTS full calls, so exceeding
  // it would break the fail-closed margin and undercount the daily spend cap.
  const maxAttempts = Math.min(
    STRUCTURIZE_MAX_ATTEMPTS,
    Math.max(1, options.maxAttempts ?? STRUCTURIZE_MAX_ATTEMPTS),
  );

  /** Read-only S1 quote; it performs no claim, reserve, provider call, or write. */
  app.post<{ Params: { id: string } }>('/v1/scripts/:id/structurize/quote', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const isAnonymous = Boolean(session.user.isAnonymous);
    const quoteCredits = isAnonymous ? 0 : STRUCTURIZE_CREDITS;
    const parsed = structurizeSourceSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const rows = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, req.params.id), eq(scripts.userId, session.user.id)))
      .limit(1);
    if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });
    const script = rows[0]!;
    const idea = parsed.data.idea?.trim();
    const kind: StructurizeSourceKind = idea ? 'idea' : 'fountain';
    const fullSource = idea ?? script.fountain.trim();
    if (!fullSource) return reply.status(400).send({ error: 'nothing_to_structurize' });
    const sourceBytes = Buffer.byteLength(fullSource, 'utf8');
    if (sourceBytes > STRUCTURIZE_SOURCE_MAX_BYTES) {
      return reply.status(413).send({
        error: 'structurize_source_too_large',
        inputBytes: sourceBytes,
        maxInputBytes: STRUCTURIZE_SOURCE_MAX_BYTES,
      });
    }
    const { system, user } = buildStructurizePrompt({ source: fullSource, kind });
    const promptBytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8');
    if (promptBytes > STRUCTURIZE_TOKEN_BUDGET.input) {
      return reply.status(413).send({
        error: 'structurize_input_too_large',
        inputBytes: promptBytes,
        maxInputBytes: STRUCTURIZE_TOKEN_BUDGET.input,
      });
    }
    const sourceHash = sourceFingerprint(kind, fullSource);
    return {
      credits: quoteCredits,
      model: STRUCTURIZE_MODEL,
      inputBytes: promptBytes,
      maxInputBytes: STRUCTURIZE_TOKEN_BUDGET.input,
      maxOutputTokens: STRUCTURIZE_TOKEN_BUDGET.output,
      sourceKind: kind,
      sourceTruncated: false,
      quoteFingerprint: structurizeQuoteFingerprint({
        scriptId: script.id,
        scriptRev: script.rev,
        kind,
        sourceHash,
        inputBytes: promptBytes,
        credits: quoteCredits,
      }),
      scriptRev: script.rev,
      free: isAnonymous,
    };
  });

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/structurize', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    // Anonymous browsing remains free. The owner-approved acquisition path gives
    // one cluster-fenced structurization; Assist and shot planning stay behind
    // signup, while registered structurization remains credit-metered.
    const isAnonymous = Boolean(session.user.isAnonymous);
    const quotedCredits = isAnonymous ? 0 : STRUCTURIZE_CREDITS;
    const parsed = structurizeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });

    const scriptRows = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, req.params.id), eq(scripts.userId, session.user.id)))
      .limit(1);
    if (scriptRows.length === 0) return reply.status(404).send({ error: 'not_found' });
    const script = scriptRows[0]!;

    // Source: an explicit idea wins; otherwise the script's own pasted/imported
    // fountain. Import/parse is pure code — the model only ever sees text.
    // `fullSource` is the COMPLETE input used for both the idempotency fingerprint
    // and the provider prompt. The byte cap below refuses an oversized source, so
    // a reused key can never replay a silently clipped revision's output.
    const idea = parsed.data.idea?.trim();
    let fullSource: string;
    let kind: StructurizeSourceKind;
    if (idea) {
      fullSource = idea; // already ≤ STRUCTURIZE_SOURCE_MAX_CHARS (schema)
      kind = 'idea';
    } else {
      fullSource = script.fountain.trim();
      kind = 'fountain';
    }
    if (!fullSource) {
      return reply.status(400).send({ error: 'nothing_to_structurize' });
    }
    // Do not silently discard the tail of a screenplay.  The old route passed a
    // byte-truncated prefix to the provider while charging as if the complete
    // source had been considered.  Refuse before the claim instead; callers can
    // explicitly shorten the source and quote the resulting request again.
    if (Buffer.byteLength(fullSource, 'utf8') > STRUCTURIZE_SOURCE_MAX_BYTES) {
      return reply.status(413).send({
        error: 'structurize_source_too_large',
        inputBytes: Buffer.byteLength(fullSource, 'utf8'),
        maxInputBytes: STRUCTURIZE_SOURCE_MAX_BYTES,
      });
    }
    const source = fullSource;

    // Assemble the prompt now and enforce the fail-closed byte ceiling BEFORE any
    // charge: the assembled prompt's UTF-8 byte length is an upper bound on its
    // token count (a BPE token is ≥1 byte), so it must not exceed the priced input
    // budget. Guaranteed by the source byte-cap; asserted so a future prompt/cap
    // change that breaks the invariant fails loudly instead of under-charging.
    const { system, user } = buildStructurizePrompt({ source, kind });
    const promptBytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8');
    if (promptBytes > STRUCTURIZE_TOKEN_BUDGET.input) {
      req.log.error({ promptBytes }, 'structurize prompt exceeds priced input budget');
      return reply.status(413).send({ error: 'structurize_input_too_large' });
    }
    const sourceHash = sourceFingerprint(kind, fullSource);
    const quoteFingerprint = structurizeQuoteFingerprint({
      scriptId: script.id,
      scriptRev: script.rev,
      kind,
      sourceHash,
      inputBytes: promptBytes,
      credits: quotedCredits,
    });
    if (
      (parsed.data.expectedCredits !== undefined &&
        parsed.data.expectedCredits !== quotedCredits) ||
      (parsed.data.quoteFingerprint !== undefined &&
        parsed.data.quoteFingerprint !== quoteFingerprint)
    ) {
      return reply.status(409).send({
        error: 'quote_stale',
        credits: quotedCredits,
        inputBytes: promptBytes,
        maxInputBytes: STRUCTURIZE_TOKEN_BUDGET.input,
        maxOutputTokens: STRUCTURIZE_TOKEN_BUDGET.output,
        quoteFingerprint,
        scriptRev: script.rev,
      });
    }

    const freeClusterKey = isAnonymous ? resolveDeviceCluster(req, reply) : undefined;
    const rateRedis = options.rateLimit?.redis ?? options.spend?.redis;
    if (rateRedis) {
      const rateMax = options.rateLimit?.max ?? (isAnonymous ? 3 : 20);
      const rateWindowSeconds = options.rateLimit?.windowSeconds ?? 10 * 60;
      const rate = await checkRateLimit(
        rateRedis,
        `scenario:structurize:rate:${freeClusterKey ?? session.user.id}`,
        rateMax,
        rateWindowSeconds,
      );
      if (!rate.allowed) {
        reply.header('retry-after', String(rateWindowSeconds));
        return reply.status(429).send({ error: 'structurize_rate_limited' });
      }
    }

    // Claim before touching the provider. Registered calls use the existing
    // paid request/idempotency path; anonymous calls use the same durable ledger
    // with op='structurize_free' and one unique claim per anti-farm cluster.
    const idempotencyKey = parsed.data.idempotencyKey;
    const cost = isAnonymous ? 0 : STRUCTURIZE_CREDITS;
    const providerCost = STRUCTURIZE_CREDITS;
    const jobId = nid();
    const claimOp = isAnonymous ? 'structurize_free' : 'structurize';
    const claimValues = {
      scriptId: script.id,
      userId: session.user.id,
      idempotencyKey,
      jobId: isAnonymous ? null : jobId,
      sourceHash,
      op: claimOp,
      amount: cost,
      ...(freeClusterKey ? { freeClusterKey } : {}),
    };
    const tryClaim = async () =>
      (
        await db
          .insert(scriptAssistRequests)
          .values({ id: nid(), ...claimValues })
          .onConflictDoNothing()
          .returning()
      )[0];
    const conflict = () => {
      scenarioStructurizeRequestsTotal.labels(kind, 'conflict').inc();
      return reply.status(409).send({ error: 'structurize_in_progress' });
    };
    let requestClaim: typeof scriptAssistRequests.$inferSelect | undefined;

    if (isAnonymous) {
      // The unique cluster index fences the lifetime claim. A failed/aborted row
      // is reusable; an in-flight row is leased for 15 minutes so a process crash
      // cannot burn the acquisition slot forever.
      requestClaim = await tryClaim();
      if (!requestClaim) {
        const [existing] = await db
          .select({
            id: scriptAssistRequests.id,
            userId: scriptAssistRequests.userId,
            idempotencyKey: scriptAssistRequests.idempotencyKey,
            status: scriptAssistRequests.status,
            result: scriptAssistRequests.result,
            scriptId: scriptAssistRequests.scriptId,
            sourceHash: scriptAssistRequests.sourceHash,
            updatedAt: scriptAssistRequests.updatedAt,
          })
          .from(scriptAssistRequests)
          .where(
            and(
              eq(scriptAssistRequests.freeClusterKey, freeClusterKey!),
              eq(scriptAssistRequests.op, 'structurize_free'),
            ),
          )
          .limit(1);
        if (!existing) return conflict();
        const sameRequest =
          existing.userId === session.user.id &&
          existing.idempotencyKey === idempotencyKey &&
          existing.scriptId === script.id &&
          existing.sourceHash === sourceHash;
        if (existing.status === 'completed' && existing.result) {
          if (sameRequest) {
            scenarioStructurizeRequestsTotal.labels(kind, 'replayed').inc();
            return reply.status(200).send({ ...existing.result, credits: 0, free: true });
          }
          if (existing.userId === session.user.id && existing.idempotencyKey === idempotencyKey) {
            scenarioStructurizeRequestsTotal.labels(kind, 'key_reused').inc();
            return reply.status(409).send({ error: 'idempotency_key_reused' });
          }
          return reply
            .status(403)
            .send({ error: 'signup_required', reason: 'free_structurize_used' });
        }
        if (existing.status === 'in_progress') {
          if (existing.userId !== session.user.id) {
            return reply
              .status(403)
              .send({ error: 'signup_required', reason: 'free_structurize_in_progress' });
          }
          const stale = existing.updatedAt.getTime() < Date.now() - FREE_CLAIM_STALE_MS;
          if (!stale) return conflict();
          const removed = await db
            .delete(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.id, existing.id),
                eq(scriptAssistRequests.status, 'in_progress'),
                eq(scriptAssistRequests.op, 'structurize_free'),
              ),
            )
            .returning({ id: scriptAssistRequests.id });
          if (removed.length === 0) return conflict();
        } else if (existing.status === 'failed' || existing.status === 'aborted') {
          if (
            existing.userId === session.user.id &&
            existing.idempotencyKey === idempotencyKey &&
            !sameRequest
          ) {
            scenarioStructurizeRequestsTotal.labels(kind, 'key_reused').inc();
            return reply.status(409).send({ error: 'idempotency_key_reused' });
          }
          await db
            .delete(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.id, existing.id),
                inArray(scriptAssistRequests.status, ['failed', 'aborted']),
                eq(scriptAssistRequests.op, 'structurize_free'),
              ),
            );
        }
        requestClaim = await tryClaim();
        if (!requestClaim) return conflict();
      }
    } else {
      const tryPaidClaim = tryClaim;
      requestClaim = await tryPaidClaim();
      if (!requestClaim) {
        const [existing] = await db
          .select({
            id: scriptAssistRequests.id,
            status: scriptAssistRequests.status,
            result: scriptAssistRequests.result,
            scriptId: scriptAssistRequests.scriptId,
            sourceHash: scriptAssistRequests.sourceHash,
            amount: scriptAssistRequests.amount,
            updatedAt: scriptAssistRequests.updatedAt,
          })
          .from(scriptAssistRequests)
          .where(
            and(
              eq(scriptAssistRequests.userId, session.user.id),
              eq(scriptAssistRequests.op, 'structurize'),
              eq(scriptAssistRequests.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1);
        // A same-key STRUCTURIZE row exists (a colliding assist key can't reach
        // here — uniqueness is op-scoped). Its input must match — a reused key
        // must never act on another project's or a changed idea's request.
        if (existing) {
          const sameInput = existing.scriptId === script.id && existing.sourceHash === sourceHash;
          if (existing.status === 'completed' && existing.result) {
            if (!sameInput) {
              scenarioStructurizeRequestsTotal.labels(kind, 'key_reused').inc();
              return reply.status(409).send({ error: 'idempotency_key_reused' });
            }
            scenarioStructurizeRequestsTotal.labels(kind, 'replayed').inc();
            return reply.status(200).send({ ...existing.result, credits: existing.amount ?? cost });
          }
          if (existing.status === 'failed' || existing.status === 'aborted') {
            if (!sameInput) {
              scenarioStructurizeRequestsTotal.labels(kind, 'key_reused').inc();
              return reply.status(409).send({ error: 'idempotency_key_reused' });
            }
            await db
              .delete(scriptAssistRequests)
              .where(
                and(
                  eq(scriptAssistRequests.id, existing.id),
                  inArray(scriptAssistRequests.status, ['failed', 'aborted']),
                  eq(scriptAssistRequests.op, 'structurize'),
                ),
              );
            requestClaim = await tryPaidClaim();
            if (!requestClaim) return conflict();
          } else {
            const reclaimed = await reclaimStaleClaim({
              op: 'structurize',
              blocker: existing,
              userId: session.user.id,
              reason: 'script.structurize.stale_reclaim',
              fallbackAmount: cost,
              reqId: req.id,
            });
            if (reclaimed) scenarioStructurizeRequestsTotal.labels(kind, 'stale_reclaimed').inc();
            if (!reclaimed) return conflict();
            requestClaim = await tryPaidClaim();
            if (!requestClaim) return conflict();
          }
        } else {
          const [inflight] = await db
            .select({ id: scriptAssistRequests.id, updatedAt: scriptAssistRequests.updatedAt })
            .from(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.userId, session.user.id),
                eq(scriptAssistRequests.status, 'in_progress'),
                eq(scriptAssistRequests.op, 'structurize'),
              ),
            )
            .limit(1);
          const reclaimed = inflight
            ? await reclaimStaleClaim({
                op: 'structurize',
                blocker: inflight,
                userId: session.user.id,
                reason: 'script.structurize.stale_reclaim',
                fallbackAmount: cost,
                reqId: req.id,
              })
            : false;
          if (reclaimed) scenarioStructurizeRequestsTotal.labels(kind, 'stale_reclaimed').inc();
          if (!reclaimed) return conflict();
          requestClaim = await tryPaidClaim();
          if (!requestClaim) return conflict();
        }
      }
    }
    if (!requestClaim) return conflict();
    const claim = requestClaim;
    const markRequest = async (status: 'completed' | 'failed' | 'aborted', failure?: string) => {
      await db
        .update(scriptAssistRequests)
        .set({ status, ...(failure ? { failure } : {}), updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, claim.id));
    };

    // ---- charge: fixed economy price, reserve → commit/refund (like assist) ----
    // (cost, jobId, sourceHash were fixed at claim time above.)
    const cap = options.spend?.cap ?? dailySpendCap();
    let dailyBudgetReserved = false;
    if (options.spend && cap > 0) {
      // The guest call is free to the user, but it still consumes the same
      // provider-budget unit as a registered structurization.
      const budget = await reserveDailyBudget(options.spend.redis, providerCost, cap);
      if (!budget.allowed) {
        await markRequest('failed', 'daily_spend_cap_exceeded');
        scenarioStructurizeRequestsTotal.labels(kind, 'daily_cap').inc();
        return reply.status(503).send({
          error: 'daily_spend_cap_exceeded',
          cap,
          message: 'Платформа достигла дневного лимита запросов к редактору. Попробуйте позже.',
        });
      }
      dailyBudgetReserved = true;
    }
    try {
      // Reserve the hold AND flag the claim `reserved` in ONE transaction, so a
      // crash can never leave an in_progress claim whose reservation state is
      // ambiguous: stale recovery refunds only confirmed (reserved) holds, and a
      // claim inserted-but-never-reserved is deleted without a doomed refund.
      // The flag update is FENCED on the row still being ours (in_progress): if a
      // reclaimer deleted it while we were delayed, the update hits zero rows and
      // we throw → the whole tx (including the reserve) rolls back, so we never
      // charge a claim we no longer own.
      if (!isAnonymous) {
        await db.transaction(async (tx) => {
          await credits.reserve({
            userId: session.user.id,
            jobId,
            amount: cost,
            reason: 'script.structurize',
            idempotencyKey: paidScriptClaimKey('structurize', jobId, 'reserve'),
            tx,
          });
          const owned = await tx
            .update(scriptAssistRequests)
            .set({ reserved: true, updatedAt: new Date() })
            .where(
              and(
                eq(scriptAssistRequests.id, claim.id),
                eq(scriptAssistRequests.status, 'in_progress'),
              ),
            )
            .returning({ id: scriptAssistRequests.id });
          if (owned.length === 0) throw new OwnershipLost();
        });
      }
    } catch (err) {
      if (dailyBudgetReserved) await releaseDailyBudget(options.spend!.redis, providerCost);
      if (err instanceof OwnershipLost) {
        // Reclaimed as stale while we were delayed; the reserve rolled back (no
        // hold). A replacement request owns this key now.
        scenarioStructurizeRequestsTotal.labels(kind, 'ownership_lost').inc();
        return reply.status(409).send({ error: 'structurize_in_progress' });
      }
      if (err instanceof InsufficientCreditsError) {
        await markRequest('failed', 'insufficient_credits');
        scenarioStructurizeRequestsTotal.labels(kind, 'insufficient_credits').inc();
        return reply.status(402).send({ error: 'insufficient_credits', required: cost });
      }
      await markRequest('failed', 'reserve_failed');
      throw err;
    }

    // Refund a leg with a GUARANTEE, so the request can be marked terminal safely.
    // First bounded inline retries (refund is idempotent by key, so a transient
    // advisory-lock/DB blip is safe to repeat); if those are exhausted, durably
    // enqueue the refund via the outbox so the credits worker drives it to
    // completion (same key → the ledger dedupes, no double refund; assist/
    // structurize holds have no reaper of their own). Throws ONLY if even the
    // durable enqueue fails (a full DB outage), leaving the caller's catch to
    // fail the request without a terminal lie. (Commit takes the atomic path in
    // commitAtomic below, so it never goes through here.)
    const refundLeg = async (): Promise<void> => {
      if (isAnonymous) return;
      for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
        try {
          await credits.refund({
            userId: session.user.id,
            jobId,
            amount: cost,
            reason: 'script.structurize.refund',
            idempotencyKey: paidScriptClaimKey('structurize', jobId, 'refund'),
          });
          return;
        } catch (err) {
          req.log.warn({ err, jobId, attempt }, 'structurize refund attempt failed');
        }
      }
      await enqueueRefund(session.user.id, jobId, cost, req.id);
      req.log.warn({ jobId }, 'structurize refund deferred to durable outbox');
      scenarioStructurizeRequestsTotal.labels(kind, 'settle_deferred').inc();
    };

    // The settlement decision is single-valued: once we commit (or refund) we
    // NEVER issue the opposite leg (contradictory ledger intent / poison outbox
    // jobs). `decision` latches the DIRECTION; `refundConfirmed` tracks whether the
    // refund actually landed (inline or durably enqueued) — separate, so a failed
    // refund can be re-attempted and we never mark the request terminal (which a
    // later same-key retry could delete, losing the jobId) until the hold is settled.
    const settleState: { decision: 'none' | 'commit' | 'refund'; refundConfirmed: boolean } = {
      decision: 'none',
      refundConfirmed: false,
    };
    // Commit path: persist the completed result AND enqueue the durable commit in
    // ONE transaction. There is thus no crash window where a replayable completed
    // result exists without a scheduled charge — both land or neither does. The
    // credits worker performs the actual commit (the user's available balance was
    // already debited at reserve, so this only finalizes the ledger).
    const commitAtomic = async (result: ScenarioStructurizeResult) => {
      await db.transaction(async (tx) => {
        // Fenced: complete ONLY if we still own the claim (a reclaimer may have
        // deleted it while we were delayed). Zero rows → throw → the commit outbox
        // entry rolls back, so we never charge without a persisted, replayable
        // result. The reclaimer already refunded the confirmed hold.
        const owned = await tx
          .update(scriptAssistRequests)
          .set({ status: 'completed', result, updatedAt: new Date() })
          .where(
            and(
              eq(scriptAssistRequests.id, claim.id),
              eq(scriptAssistRequests.status, 'in_progress'),
            ),
          )
          .returning({ id: scriptAssistRequests.id });
        if (owned.length === 0) throw new OwnershipLost();
        // The structurize response is the first durable project structure, not
        // merely an ephemeral chat answer. Persist it behind the same fenced
        // claim so a replay always opens the exact brief/outline that was
        // charged (or subsidised for the anonymous acquisition path). A
        // concurrent editor change aborts the whole transaction and follows
        // the existing refund path instead of overwriting newer work.
        const structureSaved = await tx
          .update(scripts)
          .set({
            format: result.format,
            brief: result.brief,
            outline: result.outline,
            rev: sql`${scripts.rev} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scripts.id, script.id),
              eq(scripts.userId, session.user.id),
              eq(scripts.rev, script.rev),
            ),
          )
          .returning({ id: scripts.id });
        if (structureSaved.length === 0) throw new OwnershipLost();
        if (isAnonymous) return;
        await enqueueViaOutbox({
          tx,
          queueName: CREDIT_COMMIT_QUEUE,
          payload: {
            userId: session.user.id,
            jobId,
            amount: cost,
            reason: 'script.structurize.commit',
            idempotencyKey: paidScriptClaimKey('structurize', jobId, 'commit'),
            _reqId: req.id,
          },
          jobId: `structurize-commit-${jobId}`,
        });
      });
      settleState.decision = 'commit';
    };
    const settleRefund = async () => {
      // Never refund after a commit, and never re-refund once confirmed — but DO
      // allow re-attempting a refund that failed (decision latched, not confirmed).
      if (settleState.decision === 'commit' || settleState.refundConfirmed) return;
      settleState.decision = 'refund';
      await refundLeg(); // throws only if BOTH inline retries AND the outbox fail
      settleState.refundConfirmed = true; // reached only when the refund is durable
    };

    const abort = new AbortController();
    const attempts: AiCallAttempt[] = [];
    let creditsCharged: number | null = null;
    const recordAttempts = () =>
      recordAiUsage(
        attempts,
        {
          op: 'structurize',
          userId: session.user.id,
          claimId: claim.id,
          scriptId: script.id,
          creditsCharged,
        },
        req.log,
      );
    // Bound the call by the deadline only. We deliberately do NOT abort on
    // `req.raw` 'close': for a buffered (non-hijacked) request that event also
    // fires once the small body is consumed, which would spuriously abort a
    // healthy in-flight gateway call and 504. The deadline is the real ceiling.
    const deadline = setTimeout(() => abort.abort(), options.deadlineMs ?? STRUCTURIZE_DEADLINE_MS);

    // Refresh the claim's lease right before the (bounded) provider call, so the
    // reaper — which expires on updatedAt — never reaps this live request even if
    // pre-provider work was slow. Best-effort: if the row is already gone the
    // commit fence catches it.
    await db
      .update(scriptAssistRequests)
      .set({ updatedAt: new Date() })
      .where(eq(scriptAssistRequests.id, claim.id));

    // Always the economy model, whatever the user's tier (decision #4). Retry on
    // schema failure; a provider failure ends the attempt loop immediately.
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let content: string;
        try {
          ({ content } = await callGatewayForJson({
            fetchImpl,
            signal: abort.signal,
            system,
            user,
            attempts,
          }));
        } catch (err) {
          scenarioStructurizeAttempts.labels('provider_fail').inc();
          // Refund the USER, but keep the daily-budget reservation: the gateway
          // attempt(s) counted against the platform spend cap regardless of the
          // user's refund, so a degraded provider can't slip unlimited retries
          // past the cap.
          await settleRefund();
          const aborted = abort.signal.aborted;
          await markRequest(
            aborted ? 'aborted' : 'failed',
            aborted ? 'aborted' : 'provider_failed',
          );
          scenarioStructurizeRequestsTotal
            .labels(kind, aborted ? 'aborted' : 'provider_failed')
            .inc();
          await recordAttempts();
          return reply
            .status(aborted ? 504 : 502)
            .send({ error: aborted ? 'structurize_timeout' : 'structurize_failed' });
        }
        try {
          const result = parseStructurizeOutput(content);
          scenarioStructurizeAttempts.labels('parsed').inc();
          // Persist the completed result AND schedule the charge atomically, then
          // return. Latching 'commit' means no later failure can refund it.
          await commitAtomic(result);
          creditsCharged = cost;
          scenarioStructurizeRequestsTotal.labels(kind, 'completed').inc();
          // Never surface raw JSON — return the validated, structured object.
          await recordAttempts();
          return reply.status(200).send({ ...result, credits: cost, free: isAnonymous });
        } catch (err) {
          if (!(err instanceof StructurizeSchemaError)) throw err;
          scenarioStructurizeAttempts.labels('schema_fail').inc();
          req.log.warn({ jobId, attempt, err: err.message }, 'structurize schema miss');
          // fall through to the next attempt
        }
      }
      // Exhausted retries without usable output — refund the user, no persisted
      // turn. Keep the daily-budget reservation: those gateway attempts consumed
      // billable tokens and must still count against the platform spend cap.
      await settleRefund();
      await markRequest('failed', 'unusable_output');
      scenarioStructurizeRequestsTotal.labels(kind, 'unusable').inc();
      await recordAttempts();
      return reply.status(422).send({ error: 'structurize_unusable' });
    } catch (err) {
      // Reclaimed mid-flight (commit fence tripped): the reclaimer already settled
      // the confirmed hold and a replacement request owns the key. Nothing to
      // refund or mark — the commit rolled back, so we never charged.
      if (err instanceof OwnershipLost) {
        scenarioStructurizeRequestsTotal.labels(kind, 'ownership_lost').inc();
        await recordAttempts();
        return reply.status(409).send({ error: 'structurize_in_progress' });
      }
      req.log.error({ err, jobId }, 'structurize unexpected failure');
      // If we already committed, the request is genuinely complete (result is
      // persisted and replayable) — NEVER refund it or downgrade the terminal
      // state, even if a post-commit step (metric/serialization) threw.
      if (settleState.decision === 'commit') {
        scenarioStructurizeRequestsTotal.labels(kind, 'error_post_commit').inc();
        await recordAttempts();
        return reply.status(500).send({ error: 'structurize_failed' });
      }
      // Otherwise refund the user's money. Retry the refund here (it may have
      // failed mid-flight above); settleRefund is a no-op once confirmed.
      try {
        await settleRefund();
      } catch (refundErr) {
        req.log.error({ err: refundErr, jobId }, 'structurize refund could not be confirmed');
      }
      if (settleState.refundConfirmed) {
        // Refund is durable → safe to free the claim so the user isn't blocked.
        await markRequest('failed', 'unexpected_error');
        scenarioStructurizeRequestsTotal.labels(kind, 'error').inc();
      } else {
        // Total settlement outage: leave the claim IN_PROGRESS so its jobId is
        // preserved (a terminal row could be deleted by a later same-key retry,
        // losing the only record of the hold). Stale-reclaim recovers + refunds it
        // later. The user is briefly blocked, which is correct during a DB outage.
        scenarioStructurizeRequestsTotal.labels(kind, 'settle_unconfirmed').inc();
      }
      await recordAttempts();
      return reply.status(500).send({ error: 'structurize_failed' });
    } finally {
      clearTimeout(deadline);
    }
  });
}

/**
 * One non-streaming economy completion that returns the model's text. Kept
 * separate from assist's streamCompletion: structurization wants the whole JSON
 * body at once, not token-by-token delivery.
 */
async function callGatewayForJson(args: {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  system: string;
  user: string;
  attempts: AiCallAttempt[];
}): Promise<{ content: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  let usage: AiUsage | null = null;
  let outcome: AiCallAttempt['outcome'] = 'error';
  let errorMessage: string | undefined;
  try {
    const res = await args.fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Seed',
      },
      body: JSON.stringify({
        model: STRUCTURIZE_MODEL,
        max_tokens: STRUCTURIZE_TOKEN_BUDGET.output,
        // Economy model reasons by default and would burn the whole budget on
        // hidden thinking — disable it (same as the economy assist tier).
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      }),
      signal: args.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    usage = parseOpenAiUsage(json);
    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content.trim()) {
      outcome = 'empty';
      throw new Error('gateway returned empty content');
    }
    outcome = 'ok';
    return { content };
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    args.attempts.push({
      route: 'openrouter',
      model: STRUCTURIZE_MODEL,
      attempt: args.attempts.length + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}
