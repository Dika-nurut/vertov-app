import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, nid, scriptAssistRequests } from '@seed/db';
import {
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_RESULT_CHAR_LIMIT,
  type AiCallAttempt,
  type PromptStudioModel,
} from '@seed/shared';
import {
  creditService,
  CreditService,
  InsufficientCreditsError,
  enqueueViaOutbox,
  paidScriptClaimKey,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
} from '@seed/credits';
import {
  createPromptStudioAdapter,
  PROMPT_STUDIO_REF_TOKEN_RE,
  promptStudioProviderInput,
  sanitizeSceneContext,
  type PromptStudioInput,
  type PromptStudioAdapter,
} from '@seed/provider-prompt-enhancer';
import { checkPerUserRateLimit } from './prompt-enhancer';
import { egressFetch } from './egress-fetch';
import { dailySpendCap, releaseDailyBudget, reserveDailyBudget } from './spend-guard';
import { recordAiUsage } from './ai-usage-store';

const draftSchema = z.object({
  brief: z
    .string()
    .trim()
    .min(1, 'brief_required')
    .max(PROMPT_STUDIO_BRIEF_CHAR_LIMIT, 'brief_too_long'),
  kind: z.enum(['video', 'image']).default('video'),
  model: z.enum(['claude', 'gpt', 'gemini']).default('claude'),
  idempotencyKey: z.string().min(8).max(128),
  refMentions: z
    .array(
      z.object({
        token: z.string().regex(PROMPT_STUDIO_REF_TOKEN_RE),
        kind: z.enum(['image', 'video']),
        label: z.string().trim().max(120),
      }),
    )
    .max(12)
    .default([]),
  sceneContext: z.string().trim().max(400).default(''),
});

type RequireSession = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

const RATE_LIMIT_MAX = 20;
export { PROMPT_STUDIO_INPUT_TOKEN_LIMIT };

/**
 * A fail-closed upper bound for this short multilingual prompt surface. A BPE
 * token is at least one UTF-8 byte, so byte length is a safe upper bound even
 * for dense Cyrillic, emoji, or adversarial Unicode. It counts the exact
 * provider input: system instruction, user idea, references, and fitted scene
 * context — never only the visible idea field.
 */
export function estimatePromptStudioInputTokens(input: PromptStudioInput): number {
  return Buffer.byteLength(promptStudioProviderInput(input), 'utf8');
}

/**
 * Bind a durable paid claim to the exact normalized request we sent to the
 * provider. The idempotency key alone only proves the caller chose the same
 * retry slot; this fingerprint prevents that slot from replaying a different
 * brief, model, reference set, or fitted scene context.
 */
export function promptStudioRequestHash(input: PromptStudioInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        brief: input.brief,
        kind: input.kind,
        model: input.model,
        refMentions: (input.refMentions ?? []).map(({ token, kind, label }) => ({
          token,
          kind,
          label,
        })),
        sceneContext: input.sceneContext ?? '',
      }),
    )
    .digest('hex');
}

function truncateSceneContext(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  const codePoints = Array.from(value);
  const content = codePoints.slice(0, Math.max(0, limit - 1)).join('');
  const boundary = content.search(/\s[^\s]*$/u);
  return `${(boundary > 0 ? content.slice(0, boundary) : content).trimEnd()}…`;
}

/** Fit only our scene data into the existing priced envelope. */
export function fitSceneContext(input: PromptStudioInput, limit: number): PromptStudioInput {
  if (!(input.sceneContext ?? '')) return input;
  if (estimatePromptStudioInputTokens(input) <= limit) return input;
  const codePoints = Array.from(input.sceneContext ?? '');
  for (let length = codePoints.length; length >= 0; length -= 1) {
    const sceneContext = truncateSceneContext(input.sceneContext ?? '', length);
    const candidate = { ...input, sceneContext };
    if (estimatePromptStudioInputTokens(candidate) <= limit) return candidate;
  }
  // The explicit drop is the termination escape and leaves the author's brief
  // and refs untouched when they already consume the whole envelope.
  return { ...input, sceneContext: '' };
}

export interface PromptStudioRouteOptions {
  credits?: Pick<CreditService, 'reserve' | 'commit' | 'refund'>;
  adapter?: PromptStudioAdapter;
  spend?: { redis: IORedis; cap?: number };
}

/**
 * POST /v1/prompt-studio/draft
 *
 * «AI-промпт» — accepts { brief, kind, model } and returns { prompt, mode }:
 * one ready-to-generate prompt drafted by the chosen text model
 * (Claude Sonnet 5 / GPT-5.6 Terra / Gemini 3 Flash via Kie with OpenRouter fallback). 20 req/min per user. Errors degrade
 * to 503 so the node keeps its brief and the user can retry.
 */
export function setupPromptStudioRoutes(
  app: FastifyInstance,
  requireSession: RequireSession,
  redis: IORedis,
  options: PromptStudioRouteOptions = {},
): void {
  const credits = options.credits ?? creditService;
  const adapter = options.adapter ?? createPromptStudioAdapter(undefined, { fetch: egressFetch });
  app.post('/v1/prompt-studio/draft', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const rl = await checkPerUserRateLimit(redis, session.user.id, 'prompt-studio', RATE_LIMIT_MAX);
    reply.header('x-ratelimit-limit', String(RATE_LIMIT_MAX));
    reply.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) {
      return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }

    const parsed = draftSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply.status(400).send({
        error:
          first?.message === 'brief_required' || first?.message === 'brief_too_long'
            ? first.message
            : 'invalid_body',
        issues: parsed.error.issues,
      });
    }

    const input: PromptStudioInput = {
      brief: parsed.data.brief,
      kind: parsed.data.kind,
      model: parsed.data.model,
      refMentions: parsed.data.refMentions,
      // The API is the authority for the exact context measured, sent, returned,
      // and stored. The provider repeats this strip defensively at its boundary.
      sceneContext: sanitizeSceneContext(parsed.data.sceneContext),
    };
    const fittedInput = fitSceneContext(input, PROMPT_STUDIO_INPUT_TOKEN_LIMIT);
    const inputTokens = estimatePromptStudioInputTokens(fittedInput);
    if (inputTokens > PROMPT_STUDIO_INPUT_TOKEN_LIMIT) {
      return reply.status(400).send({
        error: 'prompt_studio_input_too_long',
        limit: PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
        estimated: inputTokens,
      });
    }
    const requestHash = promptStudioRequestHash(fittedInput);

    const cost = PROMPT_STUDIO_CREDITS[parsed.data.model as PromptStudioModel];
    // Persist the paid claim before reserving credit or calling a provider. This
    // makes an uncertain browser retry replay the paid output rather than making
    // a second provider call or a second debit.
    const claimId = nid();
    const [claim] = await db
      .insert(scriptAssistRequests)
      .values({
        id: claimId,
        userId: session.user.id,
        idempotencyKey: parsed.data.idempotencyKey,
        sourceHash: requestHash,
        op: 'prompt_studio',
        jobId: claimId,
        amount: cost,
      })
      .onConflictDoNothing()
      .returning();
    if (!claim) {
      const [existing] = await db
        .select({
          status: scriptAssistRequests.status,
          result: scriptAssistRequests.result,
          amount: scriptAssistRequests.amount,
          sourceHash: scriptAssistRequests.sourceHash,
        })
        .from(scriptAssistRequests)
        .where(
          and(
            eq(scriptAssistRequests.userId, session.user.id),
            eq(scriptAssistRequests.op, 'prompt_studio'),
            eq(scriptAssistRequests.idempotencyKey, parsed.data.idempotencyKey),
          ),
        )
        .limit(1);
      // A key is a retry identity, not a license to replay a different paid
      // request. Legacy rows have no fingerprint; retain their replay behavior
      // for compatibility, while every new claim is strictly bound.
      if (existing?.sourceHash && existing.sourceHash !== requestHash) {
        return reply.status(409).send({ error: 'prompt_studio_idempotency_key_reused' });
      }
      if (existing?.status === 'completed') {
        const result = existing.result as {
          prompt?: unknown;
          mode?: unknown;
          sceneContext?: unknown;
        } | null;
        if (typeof result?.prompt === 'string' && typeof result.mode === 'string') {
          return {
            prompt: result.prompt,
            mode: result.mode,
            creditsSpent: existing.amount ?? cost,
            sceneContext: typeof result.sceneContext === 'string' ? result.sceneContext : '',
            idempotent: true,
          };
        }
      }
      return reply.status(409).send({
        error:
          existing?.status === 'failed'
            ? 'prompt_studio_retry_with_new_key'
            : 'prompt_studio_in_progress',
      });
    }
    const markClaim = async (
      status: 'completed' | 'failed',
      values: { failure?: string; result?: Record<string, unknown> } = {},
    ) => {
      await db
        .update(scriptAssistRequests)
        .set({ status, ...values, updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, claim.id));
    };
    const spendRedis = options.spend?.redis ?? redis;
    const spendCap = options.spend?.cap ?? dailySpendCap();
    const dailyBudget = await reserveDailyBudget(spendRedis, cost, spendCap);
    if (!dailyBudget.allowed) {
      await markClaim('failed', { failure: 'daily_spend_cap_exceeded' });
      return reply.status(503).send({
        error: 'daily_spend_cap_exceeded',
        cap: spendCap,
      });
    }
    let holdReserved = false;
    let committed = false;
    const attempts: AiCallAttempt[] = [];
    // The canonical settlement keys for this claim — the SAME ones the worker
    // reaper computes from the persisted row (`paidScriptClaimKey(op, jobId, leg)`),
    // so a refund issued here and a refund issued by the reaper dedupe in the
    // ledger instead of colliding on its reservation-cover guard.
    const refundKey = paidScriptClaimKey('prompt_studio', claim.id, 'refund');

    /**
     * Refund the hold AND mark the claim terminal — durably. Inline first, so the
     * user's balance comes back immediately; if the inline refund fails, mark
     * terminal and enqueue the refund through the outbox in ONE transaction, so a
     * failed refund is never swallowed into a terminal claim the reaper will
     * never revisit. If even that transaction fails, this throws: the caller then
     * leaves the claim `in_progress` + `reserved`, which is what the reaper sweeps.
     */
    /**
     * Ask the DATABASE whether the completion transaction actually committed.
     * A client-side error does not mean the transaction rolled back — Postgres
     * can commit and then lose the connection before we see the acknowledgement.
     * The stored `completed` row (written in the same transaction as the queued
     * charge) is the only authority on that, and an in-process flag is not.
     * Returns the paid draft when the charge landed, else null.
     */
    const completionLanded = async (): Promise<{
      prompt: string;
      mode: string;
      sceneContext: string;
    } | null> => {
      const [current] = await db
        .select({ status: scriptAssistRequests.status, result: scriptAssistRequests.result })
        .from(scriptAssistRequests)
        .where(eq(scriptAssistRequests.id, claim.id))
        .limit(1);
      if (current?.status !== 'completed') return null;
      const stored = current.result as {
        prompt?: unknown;
        mode?: unknown;
        sceneContext?: unknown;
      } | null;
      return typeof stored?.prompt === 'string' && typeof stored.mode === 'string'
        ? {
            prompt: stored.prompt,
            mode: stored.mode,
            sceneContext: typeof stored.sceneContext === 'string' ? stored.sceneContext : '',
          }
        : null;
    };

    const settleRefund = async (failure: string): Promise<void> => {
      try {
        await credits.refund({
          userId: session.user.id,
          jobId: claim.id,
          amount: cost,
          reason: 'prompt.studio.refund',
          idempotencyKey: refundKey,
        });
        await markClaim('failed', { failure });
      } catch (refundErr) {
        req.log.warn(
          { err: refundErr, jobId: claim.id },
          'prompt_studio inline refund failed — deferring to durable outbox',
        );
        await db.transaction(async (tx) => {
          // Fenced like every other money transition here. Zero rows means the
          // reaper already took this claim — it deleted the row AND queued the
          // refund itself, under the same canonical key — so there is nothing
          // left to owe and a second durable intent would be noise.
          const owned = await tx
            .update(scriptAssistRequests)
            .set({ status: 'failed', failure, updatedAt: new Date() })
            .where(
              and(
                eq(scriptAssistRequests.id, claim.id),
                eq(scriptAssistRequests.status, 'in_progress'),
              ),
            )
            .returning({ id: scriptAssistRequests.id });
          if (owned.length === 0) {
            req.log.warn(
              { jobId: claim.id },
              'prompt_studio refund: claim already settled by the reaper',
            );
            return;
          }
          await enqueueViaOutbox({
            tx,
            queueName: CREDIT_REFUND_QUEUE,
            jobId: `prompt_studio-refund-${claim.id}`,
            payload: {
              userId: session.user.id,
              jobId: claim.id,
              amount: cost,
              reason: 'prompt.studio.refund',
              idempotencyKey: refundKey,
              _reqId: req.id,
            },
          });
        });
      }
    };

    try {
      // Reserve the hold AND flag the claim `reserved` in ONE transaction: a crash
      // between the two writes used to leave a hold on an unflagged claim, which
      // the reaper deliberately skips (it settles only confirmed holds), stranding
      // the user's credits with nothing left to release them. The flag update is
      // FENCED on the claim still being ours (`in_progress`) — if the reaper swept
      // it while pre-provider work was slow, the update hits zero rows and we throw,
      // rolling the reserve back rather than orphaning a hold whose claim is gone.
      await db.transaction(async (tx) => {
        await credits.reserve({
          userId: session.user.id,
          jobId: claim.id,
          amount: cost,
          reason: 'prompt.studio.draft',
          idempotencyKey: paidScriptClaimKey('prompt_studio', claim.id, 'reserve'),
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
        if (owned.length === 0) throw new Error('prompt_studio claim no longer in progress');
      });
      holdReserved = true;
      // Refresh the claim's lease immediately before the bounded provider call,
      // exactly as the assist/structurize paths do. The reaper expires claims on
      // `updatedAt`, and the work before this point (spend guard, the reserve's
      // row lock) is NOT bounded by the provider's own timeout — a slow start
      // could otherwise let the reaper delete and refund a live request, and the
      // completion fence below would then throw away a draft the customer paid
      // for. Margin: ≤2 provider calls at 30s each (primary + fallback) against
      // a 10-minute stale-claim threshold.
      await db
        .update(scriptAssistRequests)
        .set({ updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, claim.id));
      const { prompt: rawPrompt } = await adapter.draft(fittedInput, attempts);
      const prompt = rawPrompt.trim().slice(0, PROMPT_STUDIO_RESULT_CHAR_LIMIT);
      if (!prompt) throw new Error('prompt_studio_empty_result');
      const result = { prompt, mode: adapter.mode, sceneContext: fittedInput.sceneContext ?? '' };
      // Persist the paid draft AND schedule its charge in ONE transaction: the
      // charge used to commit BEFORE the prompt was stored, so a crash in between
      // charged the user and lost the output they paid for. Both land or neither
      // does. The credits worker performs the commit — the user's available
      // balance was already debited at reserve, so this only finalizes the ledger.
      // Fenced on the claim, so a reaped claim rolls the charge back with it.
      try {
        await db.transaction(async (tx) => {
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
          if (owned.length === 0) throw new Error('prompt_studio claim no longer in progress');
          await enqueueViaOutbox({
            tx,
            queueName: CREDIT_COMMIT_QUEUE,
            jobId: `prompt_studio-commit-${claim.id}`,
            payload: {
              userId: session.user.id,
              jobId: claim.id,
              amount: cost,
              reason: 'prompt.studio.commit',
              idempotencyKey: paidScriptClaimKey('prompt_studio', claim.id, 'commit'),
              _reqId: req.id,
            },
          });
        });
      } catch (completionErr) {
        // An error here does NOT prove the transaction rolled back. Ask the
        // database before deciding: refunding a charge that actually committed
        // would put contradictory settlement intent on one hold and poison the
        // queued commit forever (settlement jobs now retry indefinitely).
        if (!(await completionLanded())) throw completionErr;
        req.log.warn(
          { err: completionErr, jobId: claim.id },
          'prompt_studio completion ambiguous but committed — stored result is authoritative',
        );
      }
      committed = true;
      try {
        await recordAiUsage(
          attempts,
          {
            op: 'prompt_studio',
            userId: session.user.id,
            claimId: claim.id,
            creditsCharged: cost,
          },
          req.log,
        );
      } catch (postCommitErr) {
        // The charge is scheduled and the paid draft is stored; a usage-log failure
        // must not turn a paid, delivered draft into a 503 — log it and return.
        req.log.error(
          { err: postCommitErr, jobId: claim.id },
          'prompt_studio_post_commit_bookkeeping_failed',
        );
      }
      return { ...result, creditsSpent: cost };
    } catch (err) {
      // Who owns the claim's terminal state now:
      //  'settled'     — settleRefund already marked it terminal alongside the refund;
      //  'unconfirmed' — the refund could not be made durable, so the claim MUST stay
      //                  in_progress + reserved for the reaper to settle later;
      //  'none'        — no hold was taken (or it is already charged), so the normal
      //                  markClaim below applies.
      // Last line of defence for the same ambiguity: never settle against a hold
      // whose charge is durably stored. If the completion landed, the customer
      // owns that draft — return it rather than refunding it away.
      const landed = committed ? null : await completionLanded().catch(() => null);
      if (landed) {
        req.log.warn(
          { err, jobId: claim.id },
          'prompt_studio failed after the charge landed — replaying the stored draft',
        );
        await recordAiUsage(
          attempts,
          { op: 'prompt_studio', userId: session.user.id, claimId: claim.id, creditsCharged: cost },
          req.log,
        );
        return { ...landed, creditsSpent: cost };
      }
      let hold: 'none' | 'settled' | 'unconfirmed' = 'none';
      if (holdReserved && !committed) {
        hold = 'settled';
        try {
          await settleRefund('provider_or_validation_failed');
        } catch (refundErr) {
          // Total settlement outage. Marking the claim terminal here would hide a
          // debt we could not pay — the exact defect this path exists to prevent.
          hold = 'unconfirmed';
          req.log.error({ err: refundErr, jobId: claim.id }, 'prompt_studio_refund_unconfirmed');
        }
      }
      // Only released when nothing was charged — a completed draft consumed its
      // share of the platform's daily provider budget.
      if (!committed) await releaseDailyBudget(spendRedis, cost);
      if (err instanceof InsufficientCreditsError) {
        // Thrown inside the reserve transaction, so no hold was taken.
        if (hold === 'none') await markClaim('failed', { failure: 'insufficient_credits' });
        return reply.status(402).send({ error: 'insufficient_credits', required: cost });
      }
      // Never downgrade a claim that is already settled, already charged (its
      // stored result is the user's replayable receipt), or still owed a refund.
      if (hold === 'none' && !committed) {
        await markClaim('failed', { failure: 'provider_or_validation_failed' });
      }
      req.log.error({ err }, 'prompt_studio_failed');
      await recordAiUsage(
        attempts,
        {
          op: 'prompt_studio',
          userId: session.user.id,
          claimId: claim.id,
          ...(committed ? { creditsCharged: cost } : {}),
        },
        req.log,
      );
      return reply.status(503).send({ error: 'prompt_studio_unavailable' });
    }
  });
}
