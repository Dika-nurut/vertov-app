import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { boards, db, nid, scripts, scriptAssistRequests } from '@seed/db';
import {
  creditService,
  enqueueViaOutbox,
  InsufficientCreditsError,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  paidScriptClaimKey,
} from '@seed/credits';
import { parseOpenAiUsage, type AiCallAttempt, type AiUsage } from '@seed/shared';
import { safeParseBoardDocument } from '@seed/shared/board-contract';
import {
  computeShotPlanSettlement,
  packShotPlanBatch,
  shotPlanCapacity,
  shotPlanResultSchema,
  shotPlanSourceHash,
  shotPlanStoredResultSchema,
  validateShotPlanScene,
  SHOT_PLAN_BUDGET,
  SHOT_PLAN_CEILING_CREDITS,
  SHOT_PLAN_DEADLINE_MS,
  SHOT_PLAN_INPUT_CHARS,
  SHOT_PLAN_MAX_ATTEMPTS,
  SHOT_PLAN_MAX_SCENES,
  SHOT_PLAN_MAX_SHOTS,
  SHOT_PLAN_MODEL,
  SHOT_PLAN_PRICE,
  SHOT_PLAN_SCENE_MAX_CHARS,
  SHOT_PLAN_VERSION,
  type ShotPlanScene,
} from '@seed/shared/shot-plan';
import { egressFetch } from './egress-fetch';
import { dailySpendCap, releaseDailyBudget, reserveDailyBudget } from './spend-guard';
import { checkRateLimit } from './rate-limit';
import { reclaimStaleClaim } from './paid-claim';
import { bibleBlock } from './assist-context';
import { extractJson } from './scenario-structurize';
import { truncateToBytes } from './script-structurize';
import {
  buildShotPlanPrompt,
  type ShotPlanPromptCastEntry,
  type ShotPlanPromptScene,
} from './shot-plan-prompt';
import {
  shotPlanAttempts,
  shotPlanBudgetOverrun,
  shotPlanInputTokensPerChar,
  shotPlanRequestsTotal,
} from './metrics';

/**
 * POST /v1/boards/:id/shot-plan — «Разложить на кадры» (contract §3, §4, §6).
 *
 * Structurally the sibling of `script-structurize.ts` (same claim table, same
 * reserve→settle discipline, same stale recovery), with two differences the
 * contract is built around:
 *
 * 1. The server reads EVERYTHING content-bearing off the stored board itself —
 *    scene texts, the cast dictionary, the project memory. The client sends only
 *    which scenes and how many shots, so it can neither name a module it doesn't
 *    own nor inflate what we pay to send.
 * 2. Money is reserve-CEILING / settle-ACTUAL (§4): we hold the priced worst
 *    case, then commit what the provider actually reported and return the rest.
 */

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface ShotPlanOptions {
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
/** Which paid operation owns the claim row (`script_assist_requests.op`). */
const OP = 'shot_plan';
/** Idempotent settlement (commit/refund) retry budget before recording a stuck hold. */
const SETTLE_ATTEMPTS = 3;
const RATE_MAX = 10;
const RATE_WINDOW_SECONDS = 600;

/** Enqueue a durable refund of the WHOLE hold when the inline refund is exhausted. */
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
        reason: 'shot.plan.refund',
        idempotencyKey: paidScriptClaimKey(OP, jobId, 'refund'),
        _reqId: reqId,
      },
      jobId: `${OP}-refund-${jobId}`,
    });
  });
}

/** Thrown when a money transition finds its claim row is no longer ours. */
class OwnershipLost extends Error {
  constructor() {
    super('shot plan claim reclaimed by another request');
    this.name = 'OwnershipLost';
  }
}

/** Thrown when model output cannot be coerced into a valid shot plan. */
class ShotPlanSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShotPlanSchemaError';
  }
}

/** Parse one completion into the §1 shape, or throw so the route can re-ask. */
function parseShotPlanOutput(raw: string): { scenes: ShotPlanScene[] } {
  let json: unknown;
  try {
    json = extractJson(raw);
  } catch (err) {
    throw new ShotPlanSchemaError((err as Error).message);
  }
  const result = shotPlanResultSchema.safeParse(json);
  if (!result.success) {
    throw new ShotPlanSchemaError(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return { scenes: [...result.data.scenes] };
}

const shotPlanSchema = z
  .object({
    /** The revision the author is looking at — a stale plan would wire dead ids. */
    boardRev: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    /**
     * ONE batch (§3/§5): the client chunks a long run itself and sends the
     * batches sequentially — each batch is separately quoted, claimed and priced.
     */
    sceneNodeIds: z.array(z.string().trim().min(1).max(128)).min(1).max(SHOT_PLAN_MAX_SCENES),
    /** Author's choice, 1…8 (§5) — bounds capacity, price and the model's intent. */
    maxShotsPerScene: z.number().int().min(1).max(SHOT_PLAN_MAX_SHOTS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.sceneNodeIds).size !== value.sceneNodeIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sceneNodeIds'],
        message: 'duplicate sceneNodeId',
      });
    }
  });

export function setupShotPlanRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: ShotPlanOptions = {},
): void {
  // Route OpenRouter through the egress proxy (the raw prod IP is CF-blocked);
  // tests inject their own fetchImpl. Egress is a no-op when EGRESS_PROXY_URL unset.
  const fetchImpl = options.fetchImpl ?? egressFetch;
  const credits = options.credits ?? creditService;
  const enqueueRefund = options.enqueueRefund ?? enqueueDurableRefund;
  // Never make more gateway calls than the ceiling was priced to cover — the
  // ceiling is SHOT_PLAN_MAX_ATTEMPTS full-budget calls.
  const maxAttempts = Math.min(
    SHOT_PLAN_MAX_ATTEMPTS,
    Math.max(1, options.maxAttempts ?? SHOT_PLAN_MAX_ATTEMPTS),
  );

  app.post<{ Params: { id: string } }>('/v1/boards/:id/shot-plan', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    // Planning is a paid AI call — same hard wall as assist/structurize.
    if (session.user.isAnonymous) {
      return reply.status(403).send({ error: 'signup_required' });
    }
    const parsed = shotPlanSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { boardRev, sceneNodeIds, maxShotsPerScene } = parsed.data;

    // ---- §3 access checks: all of them BEFORE a single credit ----
    const [board] = await db
      .select({
        id: boards.id,
        projectId: boards.projectId,
        state: boards.state,
      })
      .from(boards)
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .limit(1);
    if (!board) return reply.status(404).send({ error: 'not_found' });

    const document = safeParseBoardDocument(board.state);
    if (!document.success) {
      req.log.error(
        { boardId: board.id, issues: document.error.issues },
        'stored board document failed validation',
      );
      return reply.status(500).send({ error: 'invalid_board_state' });
    }
    const nodes = document.data.nodes;
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    /** Live scene text, for the verbatim dialogue/cue check on fresh AND replayed plans. */
    const sceneTextById = new Map(
      nodes.flatMap((node) =>
        node.type === 'scene' ? [[node.id, node.data.sourceText] as const] : [],
      ),
    );
    const liveRev = typeof document.data.__rev === 'number' ? document.data.__rev : 0;

    const sceneNodes: { id: string; title: string; sourceText: string; sourceHash: string }[] = [];
    let scriptId: string | null = null;
    for (const sceneNodeId of sceneNodeIds) {
      const node = nodesById.get(sceneNodeId);
      if (!node || node.type !== 'scene') {
        return reply.status(400).send({ error: 'unknown_scene', sceneNodeId });
      }
      // A hand-made scene has neither a script nor a hash: it cannot be keyed for
      // idempotency nor marked stale later, so it is refused explicitly (§3).
      if (!node.data.sourceScriptId || !node.data.sourceHash) {
        return reply.status(400).send({ error: 'scene_not_linked', sceneNodeId });
      }
      if (scriptId !== null && node.data.sourceScriptId !== scriptId) {
        return reply.status(400).send({ error: 'mixed_scripts' });
      }
      scriptId = node.data.sourceScriptId;
      sceneNodes.push({
        id: node.id,
        title: node.data.title,
        sourceText: node.data.sourceText,
        sourceHash: node.data.sourceHash,
      });
    }

    const [script] = await db
      .select({ id: scripts.id, projectId: scripts.projectId, bible: scripts.bible })
      .from(scripts)
      .where(and(eq(scripts.id, scriptId!), eq(scripts.userId, session.user.id)))
      .limit(1);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    // Same precedent as the Scenario→Board handoff (scripts.ts): a script that
    // belongs to a project may only plan onto a board of that same project.
    if (script.projectId && board.projectId !== script.projectId) {
      shotPlanRequestsTotal.labels('project_mismatch').inc();
      return reply.status(409).send({
        error: 'project_mismatch',
        scriptProjectId: script.projectId,
        boardProjectId: board.projectId,
      });
    }
    if (liveRev !== boardRev) {
      return reply.status(409).send({ error: 'board_revision_conflict', rev: liveRev });
    }

    // ---- §5 capacity, measured on the LIVE document, before the quote ----
    const capacity = shotPlanCapacity({
      currentNodes: nodes.length,
      currentEdges: document.data.edges.length,
      currentBytes: Buffer.byteLength(JSON.stringify(board.state), 'utf8'),
      sceneCount: sceneNodes.length,
      maxShotsPerScene,
    });
    if (!capacity.nodes || !capacity.edges || !capacity.bytes) {
      shotPlanRequestsTotal.labels('board_full').inc();
      return reply
        .status(409)
        .send({ error: 'board_capacity_exceeded', scenesWouldFit: capacity.scenesWouldFit });
    }

    // ---- §3 what the server reads off the board (never off the request) ----
    const dictionary = new Map<
      string,
      { castKind: 'character' | 'location' | 'product'; name: string }
    >();
    const dictionaryEntries: ShotPlanPromptCastEntry[] = [];
    for (const node of nodes) {
      if (node.type !== 'cast') continue;
      const entry = { castKind: node.data.castKind, name: node.data.name };
      dictionary.set(node.id, entry);
      dictionaryEntries.push({ id: node.id, ...entry });
    }
    const memory = bibleBlock(script.bible);
    // Bound each scene in BYTES: on Cyrillic a character cap would send twice the
    // bytes the token budget was priced for.
    const promptScenes: ShotPlanPromptScene[] = sceneNodes.map((scene) => ({
      sceneNodeId: scene.id,
      title: scene.title,
      sourceText: truncateToBytes(scene.sourceText, SHOT_PLAN_SCENE_MAX_CHARS),
    }));

    // ---- §3 batch packing + the enforced input ceiling ----
    const emptyPrompt = buildShotPlanPrompt({
      memory,
      dictionary: dictionaryEntries,
      scenes: [],
      maxShotsPerScene,
    });
    const overheadChars = emptyPrompt.system.length + emptyPrompt.user.length;
    const batches = packShotPlanBatch(promptScenes, overheadChars);
    const batch = batches[0] ?? [];
    if (batches.length > 1) {
      // One request is one batch (one claim, one ceiling): tell the client how
      // many of its scenes fit so it can send the rest as the next batch.
      shotPlanRequestsTotal.labels('input_too_large').inc();
      return reply
        .status(413)
        .send({ error: 'shot_plan_input_too_large', scenesWouldFit: batch.length });
    }
    const basePrompt = buildShotPlanPrompt({
      memory,
      dictionary: dictionaryEntries,
      scenes: batch,
      maxShotsPerScene,
    });
    const promptChars = basePrompt.system.length + basePrompt.user.length;
    if (promptChars > SHOT_PLAN_INPUT_CHARS) {
      req.log.error({ promptChars }, 'shot plan prompt exceeds the priced input budget');
      shotPlanRequestsTotal.labels('input_too_large').inc();
      return reply.status(413).send({ error: 'shot_plan_input_too_large', scenesWouldFit: 0 });
    }

    // ---- §4.4 rate limit: twice as strict as structurize (a batch costs more) ----
    const rateRedis = options.rateLimit?.redis ?? options.spend?.redis;
    if (rateRedis) {
      const rateMax = options.rateLimit?.max ?? RATE_MAX;
      const rateWindowSeconds = options.rateLimit?.windowSeconds ?? RATE_WINDOW_SECONDS;
      const rate = await checkRateLimit(
        rateRedis,
        `scenario:shotplan:rate:${session.user.id}`,
        rateMax,
        rateWindowSeconds,
      );
      if (!rate.allowed) {
        reply.header('retry-after', String(rateWindowSeconds));
        shotPlanRequestsTotal.labels('rate_limited').inc();
        return reply.status(429).send({ error: 'shot_plan_rate_limited' });
      }
    }

    // ---- §6 the idempotency key is DERIVED from the content, never supplied ----
    const sourceHash = shotPlanSourceHash({
      version: SHOT_PLAN_VERSION,
      boardId: board.id,
      scriptId: script.id,
      maxShotsPerScene,
      scenes: sceneNodes.map((scene) => ({ id: scene.id, hash: scene.sourceHash })),
    });
    const idempotencyKey = `${OP}:${sourceHash}`;
    const cost = SHOT_PLAN_CEILING_CREDITS;
    const jobId = nid();

    /**
     * Re-validate a stored plan against the CURRENT board before handing it back
     * (§6): its castNodeIds/locationNodeId point at modules that may have been
     * deleted — or that changed role, which would wire an identity pack where a
     * location pack belongs. Scenes whose node is gone are dropped.
     */
    const revalidate = (scenes: readonly ShotPlanScene[]): ShotPlanScene[] => {
      const survivors: ShotPlanScene[] = [];
      for (const scene of scenes) {
        const sourceText = sceneTextById.get(scene.sceneNodeId);
        if (sourceText === undefined) continue;
        survivors.push(validateShotPlanScene(scene, dictionary, sourceText));
      }
      return survivors;
    };

    const claimValues = {
      scriptId: script.id,
      userId: session.user.id,
      idempotencyKey,
      jobId,
      sourceHash,
      op: OP,
      amount: cost,
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
      shotPlanRequestsTotal.labels('conflict').inc();
      return reply.status(409).send({ error: 'shot_plan_in_progress' });
    };
    const reclaimStale = async (blocker: { id: string; updatedAt: Date }): Promise<boolean> => {
      const reclaimed = await reclaimStaleClaim({
        op: OP,
        blocker,
        userId: session.user.id,
        reason: 'shot.plan.stale_reclaim',
        fallbackAmount: cost,
        reqId: req.id,
      });
      if (reclaimed) shotPlanRequestsTotal.labels('stale_reclaimed').inc();
      return reclaimed;
    };

    let requestClaim = await tryClaim();
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
            eq(scriptAssistRequests.op, OP),
            eq(scriptAssistRequests.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        const sameInput = existing.scriptId === script.id && existing.sourceHash === sourceHash;
        if (existing.status === 'completed') {
          if (!sameInput) {
            // With a derived key this is a sha256 collision, i.e. never.
            shotPlanRequestsTotal.labels('key_reused').inc();
            return reply.status(409).send({ error: 'idempotency_key_reused' });
          }
          const stored = shotPlanStoredResultSchema.safeParse(existing.result);
          if (!stored.success || stored.data.creditsSpent > (existing.amount ?? 0)) {
            // The settlement for this row already ran, and we cannot tell what it
            // charged. Quarantine: never delete, never replay, never re-charge —
            // the same choice the reaper makes for unreconcilable rows.
            req.log.error(
              { claimId: existing.id },
              'shot plan claim completed without a reconcilable result — quarantined',
            );
            shotPlanRequestsTotal.labels('unreconcilable').inc();
            return reply.status(409).send({ error: 'shot_plan_unreconcilable' });
          }
          const scenes = revalidate(stored.data.scenes);
          if (scenes.length > 0) {
            shotPlanRequestsTotal.labels('replayed').inc();
            return reply.status(200).send({
              version: SHOT_PLAN_VERSION,
              boardRev: liveRev,
              credits: stored.data.creditsSpent,
              scenes,
            });
          }
          // Nothing of the paid plan survives on today's board (§6) — it is worth
          // nothing to the author, so this counts as a new request. The old row's
          // settlement is already durable; free its key and re-run.
          await db
            .delete(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.id, existing.id),
                eq(scriptAssistRequests.status, 'completed'),
                eq(scriptAssistRequests.op, OP),
              ),
            );
          shotPlanRequestsTotal.labels('replay_empty').inc();
          requestClaim = await tryClaim();
          if (!requestClaim) return conflict();
        } else if (existing.status === 'failed' || existing.status === 'aborted') {
          if (!sameInput) {
            shotPlanRequestsTotal.labels('key_reused').inc();
            return reply.status(409).send({ error: 'idempotency_key_reused' });
          }
          // A terminal row already refunded its hold; free the slot (race-safe,
          // op-gated) and re-run instead of poisoning the derived key forever.
          await db
            .delete(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.id, existing.id),
                inArray(scriptAssistRequests.status, ['failed', 'aborted']),
                eq(scriptAssistRequests.op, OP),
              ),
            );
          requestClaim = await tryClaim();
          if (!requestClaim) return conflict();
        } else {
          // in_progress with the same key: a second tab, or our own crash.
          if (!(await reclaimStale(existing))) return conflict();
          requestClaim = await tryClaim();
          if (!requestClaim) return conflict();
        }
      } else {
        // Blocked by a DIFFERENT in-flight batch of this user (§6: batches are
        // sequential). Reclaim it if it crashed, else it is genuinely running.
        const [inflight] = await db
          .select({ id: scriptAssistRequests.id, updatedAt: scriptAssistRequests.updatedAt })
          .from(scriptAssistRequests)
          .where(
            and(
              eq(scriptAssistRequests.userId, session.user.id),
              eq(scriptAssistRequests.status, 'in_progress'),
              eq(scriptAssistRequests.op, OP),
            ),
          )
          .limit(1);
        if (!inflight || !(await reclaimStale(inflight))) return conflict();
        requestClaim = await tryClaim();
        if (!requestClaim) return conflict();
      }
    }
    const claim = requestClaim;
    const markRequest = async (status: 'completed' | 'failed' | 'aborted', failure?: string) => {
      await db
        .update(scriptAssistRequests)
        .set({ status, ...(failure ? { failure } : {}), updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, claim.id));
    };

    // ---- §4.6 daily platform budget, then §4.7 the hold ----
    const cap = options.spend?.cap ?? dailySpendCap();
    let dailyBudgetReserved = false;
    if (options.spend && cap > 0) {
      const budget = await reserveDailyBudget(options.spend.redis, cost, cap);
      if (!budget.allowed) {
        await markRequest('failed', 'daily_spend_cap_exceeded');
        shotPlanRequestsTotal.labels('daily_cap').inc();
        return reply.status(503).send({
          error: 'daily_spend_cap_exceeded',
          cap,
          message: 'Платформа достигла дневного лимита запросов к редактору. Попробуйте позже.',
        });
      }
      dailyBudgetReserved = true;
    }
    try {
      // Reserve the CEILING and flag the claim `reserved` in ONE transaction,
      // fenced on the row still being ours: if a reclaimer deleted it while we
      // were delayed the update hits zero rows and the whole tx (including the
      // reserve) rolls back, so we never charge a claim we no longer own.
      await db.transaction(async (tx) => {
        await credits.reserve({
          userId: session.user.id,
          jobId,
          amount: cost,
          reason: 'shot.plan',
          idempotencyKey: paidScriptClaimKey(OP, jobId, 'reserve'),
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
    } catch (err) {
      if (dailyBudgetReserved) await releaseDailyBudget(options.spend!.redis, cost);
      if (err instanceof OwnershipLost) {
        shotPlanRequestsTotal.labels('ownership_lost').inc();
        return reply.status(409).send({ error: 'shot_plan_in_progress' });
      }
      if (err instanceof InsufficientCreditsError) {
        await markRequest('failed', 'insufficient_credits');
        shotPlanRequestsTotal.labels('insufficient_credits').inc();
        return reply.status(402).send({ error: 'insufficient_credits', required: cost });
      }
      await markRequest('failed', 'reserve_failed');
      throw err;
    }

    // Refund the WHOLE hold with a guarantee, so the request can be marked
    // terminal safely: bounded inline retries first (refund is idempotent by
    // key), then a durable outbox entry the credits worker drives to completion.
    // Throws ONLY if even the durable enqueue fails (a full DB outage).
    const refundLeg = async (): Promise<void> => {
      for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
        try {
          await credits.refund({
            userId: session.user.id,
            jobId,
            amount: cost,
            reason: 'shot.plan.refund',
            idempotencyKey: paidScriptClaimKey(OP, jobId, 'refund'),
          });
          return;
        } catch (err) {
          req.log.warn({ err, jobId, attempt }, 'shot plan refund attempt failed');
        }
      }
      await enqueueRefund(session.user.id, jobId, cost, req.id);
      req.log.warn({ jobId }, 'shot plan refund deferred to durable outbox');
      shotPlanRequestsTotal.labels('settle_deferred').inc();
    };

    // The settlement direction latches: after a commit we never refund. Whether
    // the refund LANDED is tracked separately, so a failed refund can be retried
    // and the row is never marked terminal while the hold is unsettled.
    const settleState: { decision: 'none' | 'commit' | 'refund'; refundConfirmed: boolean } = {
      decision: 'none',
      refundConfirmed: false,
    };
    /**
     * §4 success: ONE transaction writes the completed result, the commit of what
     * we actually spent, and (when the ceiling was not fully used) the return of
     * the remainder. `amount` keeps the RESERVED figure — recovery must return
     * what was really held — so what we charged lives in `result.creditsSpent`.
     */
    const commitAtomic = async (scenes: ShotPlanScene[], spent: number, unspent: number) => {
      await db.transaction(async (tx) => {
        const owned = await tx
          .update(scriptAssistRequests)
          .set({
            status: 'completed',
            result: { version: SHOT_PLAN_VERSION, creditsSpent: spent, scenes },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(scriptAssistRequests.id, claim.id),
              eq(scriptAssistRequests.status, 'in_progress'),
            ),
          )
          .returning({ id: scriptAssistRequests.id });
        if (owned.length === 0) throw new OwnershipLost();
        await enqueueViaOutbox({
          tx,
          queueName: CREDIT_COMMIT_QUEUE,
          payload: {
            userId: session.user.id,
            jobId,
            amount: spent,
            reason: 'shot.plan.commit',
            idempotencyKey: paidScriptClaimKey(OP, jobId, 'commit'),
            _reqId: req.id,
          },
          jobId: `${OP}-commit-${jobId}`,
        });
        if (unspent > 0) {
          await enqueueViaOutbox({
            tx,
            queueName: CREDIT_REFUND_QUEUE,
            payload: {
              userId: session.user.id,
              jobId,
              amount: unspent,
              reason: 'shot.plan.unused',
              idempotencyKey: paidScriptClaimKey(OP, jobId, 'refund-partial'),
              _reqId: req.id,
            },
            jobId: `${OP}-refund-partial-${jobId}`,
          });
        }
      });
      settleState.decision = 'commit';
    };
    const settleRefund = async () => {
      if (settleState.decision === 'commit' || settleState.refundConfirmed) return;
      settleState.decision = 'refund';
      await refundLeg(); // throws only if BOTH inline retries AND the outbox fail
      settleState.refundConfirmed = true; // reached only when the refund is durable
    };

    const abort = new AbortController();
    const attempts: AiCallAttempt[] = [];
    // Bound the call by the deadline only (a buffered request's 'close' fires
    // when the body is consumed and would spuriously abort a healthy call).
    const deadline = setTimeout(() => abort.abort(), options.deadlineMs ?? SHOT_PLAN_DEADLINE_MS);

    // Refresh the claim's lease right before the provider loop so the reaper —
    // which expires on updatedAt — never reaps this live request.
    await db
      .update(scriptAssistRequests)
      .set({ updatedAt: new Date() })
      .where(eq(scriptAssistRequests.id, claim.id));

    const requestedIds = new Set(batch.map((scene) => scene.sceneNodeId));
    try {
      let schemaError: string | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // The repair hint is added only on the retry: the first attempt must not
        // pay for a correction it did not need.
        const prompt = schemaError
          ? buildShotPlanPrompt({
              memory,
              dictionary: dictionaryEntries,
              scenes: batch,
              maxShotsPerScene,
              schemaError,
            })
          : basePrompt;
        let content: string;
        try {
          ({ content } = await callGatewayForShotPlan({
            fetchImpl,
            signal: abort.signal,
            system: prompt.system,
            user: prompt.user,
            attempts,
          }));
          const usage = attempts[attempts.length - 1]?.usage;
          const chars = prompt.system.length + prompt.user.length;
          if (usage?.inputTokens != null && chars > 0) {
            shotPlanInputTokensPerChar.observe(usage.inputTokens / chars);
            if (usage.inputTokens > SHOT_PLAN_BUDGET.input) shotPlanBudgetOverrun.inc();
          }
        } catch {
          shotPlanAttempts.labels('provider_fail').inc();
          // Refund the USER but KEEP the daily-budget reservation: the attempt
          // counted against the platform cap regardless of the user's refund.
          await settleRefund();
          const aborted = abort.signal.aborted;
          await markRequest(
            aborted ? 'aborted' : 'failed',
            aborted ? 'aborted' : 'provider_failed',
          );
          shotPlanRequestsTotal.labels(aborted ? 'aborted' : 'provider_failed').inc();
          return reply
            .status(aborted ? 504 : 502)
            .send({ error: aborted ? 'shot_plan_timeout' : 'shot_plan_failed' });
        }
        let scenes: ShotPlanScene[];
        try {
          scenes = parseShotPlanOutput(content).scenes;
        } catch (err) {
          if (!(err instanceof ShotPlanSchemaError)) throw err;
          shotPlanAttempts.labels('schema_fail').inc();
          req.log.warn({ jobId, attempt, err: err.message }, 'shot plan schema miss');
          schemaError = err.message;
          continue; // §1: re-ask, up to SHOT_PLAN_MAX_ATTEMPTS
        }
        shotPlanAttempts.labels('parsed').inc();
        // §1: a scene we did not ask about is dropped, the batch continues; a
        // scene left with no shots did not succeed.
        const planned = scenes
          .filter((scene) => requestedIds.has(scene.sceneNodeId))
          .map((scene) =>
            validateShotPlanScene(scene, dictionary, sceneTextById.get(scene.sceneNodeId) ?? ''),
          )
          .filter((scene) => scene.shots.length > 0);
        if (planned.length === 0) {
          // §4: zero usable scenes is a full refund, not a partial result.
          await settleRefund();
          await markRequest('failed', 'no_valid_scenes');
          shotPlanRequestsTotal.labels('unusable').inc();
          return reply.status(422).send({ error: 'shot_plan_unusable' });
        }
        // EVERY attempt counts, including the schema misses: their tokens burned.
        const { spent, unspent } = computeShotPlanSettlement({
          reserved: cost,
          attempts: attempts.map((attempt) => ({
            usage: attempt.usage ? { ...attempt.usage } : attempt.usage,
          })),
          price: SHOT_PLAN_PRICE,
        });
        await commitAtomic(planned, spent, unspent);
        shotPlanRequestsTotal.labels('completed').inc();
        return reply
          .status(200)
          .send({ version: SHOT_PLAN_VERSION, boardRev: liveRev, credits: spent, scenes: planned });
      }
      // Retries exhausted without usable output — refund the user, keep the daily
      // reservation (those attempts burned real tokens).
      await settleRefund();
      await markRequest('failed', 'unusable_output');
      shotPlanRequestsTotal.labels('unusable').inc();
      return reply.status(422).send({ error: 'shot_plan_unusable' });
    } catch (err) {
      if (err instanceof OwnershipLost) {
        // Reclaimed mid-flight: the reclaimer settled the hold and a replacement
        // request owns the key. The commit rolled back, so we never charged.
        shotPlanRequestsTotal.labels('ownership_lost').inc();
        return reply.status(409).send({ error: 'shot_plan_in_progress' });
      }
      req.log.error({ err, jobId }, 'shot plan unexpected failure');
      if (settleState.decision === 'commit') {
        // Already committed: the plan is persisted and replayable — never refund
        // it or downgrade the terminal state because a later step threw.
        shotPlanRequestsTotal.labels('error_post_commit').inc();
        return reply.status(500).send({ error: 'shot_plan_failed' });
      }
      try {
        await settleRefund();
      } catch (refundErr) {
        req.log.error({ err: refundErr, jobId }, 'shot plan refund could not be confirmed');
      }
      if (settleState.refundConfirmed) {
        await markRequest('failed', 'unexpected_error');
        shotPlanRequestsTotal.labels('error').inc();
      } else {
        // Total settlement outage: leave the claim IN_PROGRESS so its jobId
        // survives — the reaper sweeps only in_progress, and a terminal row could
        // be deleted by a later retry, losing the only record of the hold.
        shotPlanRequestsTotal.labels('settle_unconfirmed').inc();
      }
      return reply.status(500).send({ error: 'shot_plan_failed' });
    } finally {
      clearTimeout(deadline);
    }
  });
}

/**
 * One non-streaming planner completion, straight to OpenRouter — deliberately
 * NOT the assist router, which tries kie first: `usage.cost` (the settle-actual
 * input) is an OpenRouter field, and kie's behaviour on a large input is marked
 * unverified in this repo. Billing does not get built on an unverified route.
 */
async function callGatewayForShotPlan(args: {
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
        model: SHOT_PLAN_MODEL,
        max_tokens: SHOT_PLAN_BUDGET.output,
        // Hidden reasoning is billed as output and would eat the whole priced
        // output budget before the plan is written.
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
      model: SHOT_PLAN_MODEL,
      attempt: args.attempts.length + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}
