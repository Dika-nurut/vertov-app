import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, desc, eq, isNull, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  galleryItems,
  nid,
  projectAssets,
  scriptAssistRequests,
  scriptSceneTimings,
  scriptShotPlans,
  scripts,
  type ScriptBible,
} from '@seed/db';
import {
  creditService,
  enqueueViaOutbox,
  InsufficientCreditsError,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  paidScriptClaimKey,
} from '@seed/credits';
import {
  parseOpenAiUsage,
  type AiCallAttempt,
  type AiUsage,
  scenarioFormatSchema,
  scenarioOutlineV1Schema,
} from '@seed/shared';
import {
  SCENARIO_SHOT_PLAN_BUDGET,
  SCENARIO_SHOT_PLAN_CREDITS,
  SCENARIO_SHOT_PLAN_DEADLINE_MS,
  SCENARIO_SHOT_PLAN_MAX_ATTEMPTS,
  SCENARIO_SHOT_PLAN_MAX_INPUT_BYTES,
  SCENARIO_SHOT_PLAN_MODEL,
  SCENARIO_SHOT_PLAN_SOURCE_MAX_BYTES,
  SCENARIO_SHOT_PLAN_VERSION,
  ScenarioShotPlanDurationError,
  normalizeScenarioShotPlan,
  scenarioShotPlanSchema,
  type ScenarioShotPlan,
} from '@seed/shared/scenario-shot-plan';
import { extractScenarioHandoffSources } from './scenario-board-handoff';
import { egressFetch } from './egress-fetch';
import { dailySpendCap, releaseDailyBudget, reserveDailyBudget } from './spend-guard';
import { checkRateLimit } from './rate-limit';
import { reclaimStaleClaim } from './paid-claim';
import { recordAiUsage } from './ai-usage-store';
import { scenarioShotPlanAttempts, scenarioShotPlanRequestsTotal } from './metrics';
import {
  buildScenarioShotPlanPrompt,
  parseScenarioShotPlanOutput,
  ScenarioShotPlanSchemaError,
  type ScenarioShotPlanLock,
  type ScenarioShotPlanMediaRef,
} from './scenario-shot-planner';
import { scenarioTimingSourceRevisionId, scenarioTimingSourceUnitId } from './scenario-timing';
import { availableOwnedAssetCondition } from './asset-references';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface ScriptShotPlanOptions {
  /** Injectable for tests — the gateway is never called live by the eval suite. */
  fetchImpl?: typeof fetch;
  credits?: Pick<typeof creditService, 'reserve' | 'commit' | 'refund'>;
  spend?: { redis: IORedis; cap?: number };
  rateLimit?: { redis: IORedis; max?: number; windowSeconds?: number };
  deadlineMs?: number;
  maxAttempts?: number;
  enqueueRefund?: typeof enqueueDurableRefund;
}

const OPENROUTER_URL =
  process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
const OP = 'scenario_shot_plan';
const RATE_MAX = 12;
const RATE_WINDOW_SECONDS = 10 * 60;
const DAILY_PLAN_MAX = 24;
const DAILY_PLAN_WINDOW_SECONDS = 24 * 60 * 60;
const SETTLE_ATTEMPTS = 3;

const bodySchema = z.object({}).strict();

class OwnershipLost extends Error {
  constructor() {
    super('scenario shot plan claim reclaimed by another request');
    this.name = 'OwnershipLost';
  }
}

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
        reason: 'scenario.shot_plan.refund',
        idempotencyKey: paidScriptClaimKey(OP, jobId, 'refund'),
        _reqId: reqId,
      },
      jobId: `${OP}-refund-${jobId}`,
    });
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function boundedText(value: unknown, max = 8_000): string {
  if (typeof value !== 'string') return '';
  if (Buffer.byteLength(value, 'utf8') <= max) return value;
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > max) end -= 1;
  return value.slice(0, end);
}

function scriptSources(script: typeof scripts.$inferSelect) {
  return extractScenarioHandoffSources({
    format: scenarioFormatSchema.parse(script.format),
    outline: scenarioOutlineV1Schema.parse(script.outline),
    fountain: script.fountain,
  });
}

function buildLocks(bible: ScriptBible): ScenarioShotPlanLock[] {
  const characters = Array.isArray(bible.characters) ? bible.characters : [];
  return characters.slice(0, 32).flatMap((character, index) => {
    const name = typeof character.name === 'string' ? character.name.trim() : '';
    if (!name) return [];
    return [
      {
        id: `canon:character:${index + 1}`,
        kind: 'character' as const,
        name: name.slice(0, 160),
        description:
          typeof character.description === 'string'
            ? character.description.trim().slice(0, 300)
            : undefined,
      },
    ];
  });
}

async function approvedMediaRefs(
  script: typeof scripts.$inferSelect,
  userId: string,
): Promise<ScenarioShotPlanMediaRef[]> {
  if (!script.projectId) return [];
  const rows = await db
    .select({ id: projectAssets.assetId, kind: galleryItems.kind, label: galleryItems.assetUrl })
    .from(projectAssets)
    .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
    .where(
      and(
        eq(projectAssets.projectId, script.projectId),
        eq(projectAssets.userId, userId),
        availableOwnedAssetCondition(userId, new Date()),
      ),
    )
    .limit(32);
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    // URLs are not needed to plan; exposing an opaque approved-ref label keeps
    // the provider prompt useful without turning it into a media launcher.
    label: row.label ? 'approved project media' : 'approved project media',
  }));
}

function planFromRow(row: { plan: unknown; policyVersion: string }): ScenarioShotPlan | null {
  if (row.policyVersion !== SCENARIO_SHOT_PLAN_VERSION) return null;
  const parsed = scenarioShotPlanSchema.safeParse(row.plan);
  return parsed.success ? parsed.data : null;
}

function responseForPlan(
  plan: ScenarioShotPlan,
  input: { credits: number; cacheHit: boolean; cachedCredits?: number },
) {
  return {
    plan,
    credits: input.credits,
    cacheHit: input.cacheHit,
    ...(input.cachedCredits !== undefined ? { cachedCredits: input.cachedCredits } : {}),
  };
}

export function setupScriptShotPlanRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: ScriptShotPlanOptions = {},
): void {
  const fetchImpl = options.fetchImpl ?? egressFetch;
  const credits = options.credits ?? creditService;
  const enqueueRefund = options.enqueueRefund ?? enqueueDurableRefund;
  const maxAttempts = Math.min(
    SCENARIO_SHOT_PLAN_MAX_ATTEMPTS,
    Math.max(1, options.maxAttempts ?? SCENARIO_SHOT_PLAN_MAX_ATTEMPTS),
  );

  app.post<{ Params: { id: string; sceneId: string } }>(
    '/v1/scripts/:id/scenes/:sceneId/shot-plan',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      // The only anonymous acquisition exception is structurization. This wall
      // is before body parsing, DB context assembly, credits, and gateway calls.
      if (session.user.isAnonymous) {
        scenarioShotPlanRequestsTotal.labels('signup_required').inc();
        return reply.status(403).send({ error: 'signup_required' });
      }
      const parsedBody = bodySchema.safeParse(req.body ?? {});
      if (!parsedBody.success) return reply.status(400).send({ error: 'invalid_body' });

      const [script] = await db
        .select()
        .from(scripts)
        .where(and(eq(scripts.id, req.params.id), eq(scripts.userId, session.user.id)))
        .limit(1);
      if (!script) return reply.status(404).send({ error: 'not_found' });

      let source;
      try {
        source = scriptSources(script).find(
          (candidate) => scenarioTimingSourceUnitId(candidate) === req.params.sceneId,
        );
      } catch (error) {
        req.log.error({ error, scriptId: script.id }, 'scenario source extraction failed');
        return reply.status(500).send({ error: 'invalid_scenario_source' });
      }
      if (!source) return reply.status(404).send({ error: 'scene_not_found' });

      const sourceSceneId = scenarioTimingSourceUnitId(source);
      const sourceHash = scenarioTimingSourceRevisionId(source.sourceText);
      if (Buffer.byteLength(source.sourceText, 'utf8') > SCENARIO_SHOT_PLAN_SOURCE_MAX_BYTES) {
        return reply.status(413).send({
          error: 'shot_plan_source_too_large',
          maxInputBytes: SCENARIO_SHOT_PLAN_SOURCE_MAX_BYTES,
        });
      }

      const timingRows = await db
        .select()
        .from(scriptSceneTimings)
        .where(
          and(
            eq(scriptSceneTimings.scriptId, script.id),
            eq(scriptSceneTimings.sourceUnitId, sourceSceneId),
          ),
        )
        .orderBy(desc(scriptSceneTimings.createdAt))
        .limit(1);
      const timing = timingRows[0];
      if (
        !timing ||
        timing.owner !== 'user' ||
        timing.sourceRevisionId !== sourceHash ||
        timing.durationSeconds <= 0
      ) {
        scenarioShotPlanRequestsTotal.labels('timing_required').inc();
        return reply.status(409).send({
          error: 'scene_timing_required',
          sceneId: sourceSceneId,
          message: 'Сначала утвердите экранное время сцены после последнего изменения текста.',
        });
      }
      const targetDurationSeconds = timing.durationSeconds;

      const [cached] = await db
        .select()
        .from(scriptShotPlans)
        .where(
          and(
            eq(scriptShotPlans.scriptId, script.id),
            eq(scriptShotPlans.sourceSceneId, sourceSceneId),
            eq(scriptShotPlans.sourceHash, sourceHash),
            eq(scriptShotPlans.targetDurationSeconds, targetDurationSeconds),
          ),
        )
        .limit(1);
      if (cached) {
        const plan = planFromRow(cached);
        if (!plan) {
          req.log.error(
            { scriptId: script.id, sceneId: sourceSceneId },
            'invalid cached shot plan',
          );
          return reply.status(409).send({ error: 'shot_plan_unreconcilable' });
        }
        scenarioShotPlanRequestsTotal.labels('cache_hit').inc();
        return reply.send(
          responseForPlan(plan, {
            credits: 0,
            cacheHit: true,
            cachedCredits: cached.creditsSpent,
          }),
        );
      }

      const bible = (script.bible ?? {}) as ScriptBible;
      const locks = buildLocks(bible);
      const mediaRefs = await approvedMediaRefs(script, session.user.id);
      const format = scenarioFormatSchema.parse(script.format);
      const promptBase = buildScenarioShotPlanPrompt({
        sceneId: sourceSceneId,
        format,
        targetDurationSeconds,
        sourceText: source.sourceText,
        brief: boundedText(JSON.stringify(script.brief ?? {}), 6_000),
        canon: boundedText(JSON.stringify(bible), 8_000),
        locks,
        approvedMediaRefs: mediaRefs,
      });
      const promptBytes =
        Buffer.byteLength(promptBase.system, 'utf8') + Buffer.byteLength(promptBase.user, 'utf8');
      if (promptBytes > SCENARIO_SHOT_PLAN_MAX_INPUT_BYTES) {
        return reply.status(413).send({
          error: 'shot_plan_input_too_large',
          inputBytes: promptBytes,
          maxInputBytes: SCENARIO_SHOT_PLAN_MAX_INPUT_BYTES,
        });
      }
      if (promptBytes > SCENARIO_SHOT_PLAN_BUDGET.input) {
        return reply.status(413).send({ error: 'shot_plan_input_too_large' });
      }

      const rateRedis = options.rateLimit?.redis ?? options.spend?.redis;
      if (rateRedis) {
        const rate = await checkRateLimit(
          rateRedis,
          `scenario:shotplan:rate:${session.user.id}`,
          options.rateLimit?.max ?? RATE_MAX,
          options.rateLimit?.windowSeconds ?? RATE_WINDOW_SECONDS,
        );
        if (!rate.allowed) {
          scenarioShotPlanRequestsTotal.labels('rate_limited').inc();
          reply.header(
            'retry-after',
            String(options.rateLimit?.windowSeconds ?? RATE_WINDOW_SECONDS),
          );
          return reply.status(429).send({ error: 'shot_plan_rate_limited' });
        }
        const daily = await checkRateLimit(
          rateRedis,
          `scenario:shotplan:daily:${session.user.id}`,
          DAILY_PLAN_MAX,
          DAILY_PLAN_WINDOW_SECONDS,
        );
        if (!daily.allowed) {
          scenarioShotPlanRequestsTotal.labels('daily_quota').inc();
          reply.header('retry-after', String(DAILY_PLAN_WINDOW_SECONDS));
          return reply.status(429).send({ error: 'shot_plan_daily_quota' });
        }
      }

      const idempotencyKey = `scenario_shot_plan:${digest({
        scriptId: script.id,
        sourceSceneId,
        sourceHash,
        targetDurationSeconds,
      })}`;
      const jobId = nid();
      const amount = SCENARIO_SHOT_PLAN_CREDITS;
      const claimValues = {
        scriptId: script.id,
        userId: session.user.id,
        idempotencyKey,
        jobId,
        sourceHash,
        op: OP,
        amount,
      };
      const tryClaim = async () =>
        (
          await db
            .insert(scriptAssistRequests)
            .values({ id: nid(), ...claimValues })
            .onConflictDoNothing()
            .returning()
        )[0];
      const conflict = () => reply.status(409).send({ error: 'shot_plan_in_progress' });
      const reclaimStale = async (blocker: { id: string; updatedAt: Date }) =>
        reclaimStaleClaim({
          op: OP,
          blocker,
          userId: session.user.id,
          reason: 'scenario.shot_plan.stale_reclaim',
          fallbackAmount: amount,
          reqId: req.id,
        });

      let claim = await tryClaim();
      if (!claim) {
        const [existing] = await db
          .select({
            id: scriptAssistRequests.id,
            status: scriptAssistRequests.status,
            result: scriptAssistRequests.result,
            scriptId: scriptAssistRequests.scriptId,
            sourceHash: scriptAssistRequests.sourceHash,
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
        if (existing?.status === 'completed') {
          const result = existing.result as { plan?: unknown } | null;
          const plan = result?.plan ? scenarioShotPlanSchema.safeParse(result.plan) : null;
          if (!plan?.success) return reply.status(409).send({ error: 'shot_plan_unreconcilable' });
          return reply.send(responseForPlan(plan.data, { credits: 0, cacheHit: true }));
        }
        if (existing && (existing.status === 'failed' || existing.status === 'aborted')) {
          await db
            .delete(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.id, existing.id),
                inArray(scriptAssistRequests.status, ['failed', 'aborted']),
                eq(scriptAssistRequests.op, OP),
              ),
            );
          claim = await tryClaim();
        } else if (existing?.status === 'in_progress') {
          if (!(await reclaimStale(existing))) return conflict();
          claim = await tryClaim();
        } else {
          const [inflight] = await db
            .select({ id: scriptAssistRequests.id, updatedAt: scriptAssistRequests.updatedAt })
            .from(scriptAssistRequests)
            .where(
              and(
                eq(scriptAssistRequests.userId, session.user.id),
                eq(scriptAssistRequests.op, OP),
                eq(scriptAssistRequests.status, 'in_progress'),
              ),
            )
            .limit(1);
          if (inflight && !(await reclaimStale(inflight))) return conflict();
          claim = await tryClaim();
        }
      }
      if (!claim) return conflict();

      const markRequest = async (status: 'completed' | 'failed' | 'aborted', failure?: string) => {
        await db
          .update(scriptAssistRequests)
          .set({ status, ...(failure ? { failure } : {}), updatedAt: new Date() })
          .where(eq(scriptAssistRequests.id, claim!.id));
      };

      const cap = options.spend?.cap ?? dailySpendCap();
      let dailyBudgetReserved = false;
      if (options.spend && cap > 0) {
        const budget = await reserveDailyBudget(options.spend.redis, amount, cap);
        if (!budget.allowed) {
          await markRequest('failed', 'daily_spend_cap_exceeded');
          scenarioShotPlanRequestsTotal.labels('daily_cap').inc();
          return reply.status(503).send({ error: 'daily_spend_cap_exceeded', cap });
        }
        dailyBudgetReserved = true;
      }

      try {
        await db.transaction(async (tx) => {
          await credits.reserve({
            userId: session.user.id,
            jobId,
            amount,
            reason: 'scenario.shot_plan',
            idempotencyKey: paidScriptClaimKey(OP, jobId, 'reserve'),
            tx,
          });
          const owned = await tx
            .update(scriptAssistRequests)
            .set({ reserved: true, updatedAt: new Date() })
            .where(
              and(
                eq(scriptAssistRequests.id, claim!.id),
                eq(scriptAssistRequests.status, 'in_progress'),
              ),
            )
            .returning({ id: scriptAssistRequests.id });
          if (owned.length === 0) throw new OwnershipLost();
        });
      } catch (error) {
        if (dailyBudgetReserved) await releaseDailyBudget(options.spend!.redis, amount);
        if (error instanceof OwnershipLost) return conflict();
        if (error instanceof InsufficientCreditsError) {
          await markRequest('failed', 'insufficient_credits');
          scenarioShotPlanRequestsTotal.labels('insufficient_credits').inc();
          return reply.status(402).send({ error: 'insufficient_credits', required: amount });
        }
        await markRequest('failed', 'reserve_failed');
        throw error;
      }

      // A nested async transaction changes this value; keep it wide enough for
      // TypeScript not to assume the catch block can only see the initializer.
      let settlement: string = 'none';
      let refundConfirmed = false;
      const refundHold = async () => {
        if (settlement === 'commit' || refundConfirmed) return;
        settlement = 'refund';
        for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt += 1) {
          try {
            await credits.refund({
              userId: session.user.id,
              jobId,
              amount,
              reason: 'scenario.shot_plan.refund',
              idempotencyKey: paidScriptClaimKey(OP, jobId, 'refund'),
            });
            refundConfirmed = true;
            return;
          } catch (error) {
            req.log.warn({ error, jobId, attempt }, 'scenario shot plan refund attempt failed');
          }
        }
        await enqueueRefund(session.user.id, jobId, amount, req.id);
        refundConfirmed = true;
      };

      const commitAtomic = async (plan: ScenarioShotPlan) => {
        await db.transaction(async (tx) => {
          await tx.insert(scriptShotPlans).values({
            id: nid(),
            scriptId: script.id,
            sourceSceneId,
            sourceHash,
            targetDurationSeconds,
            policyVersion: SCENARIO_SHOT_PLAN_VERSION,
            modelId: SCENARIO_SHOT_PLAN_MODEL,
            plan: plan as unknown as Record<string, unknown>,
            creditsSpent: amount,
          });
          const owned = await tx
            .update(scriptAssistRequests)
            .set({
              status: 'completed',
              result: { plan } as Record<string, unknown>,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(scriptAssistRequests.id, claim!.id),
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
              amount,
              reason: 'scenario.shot_plan.commit',
              idempotencyKey: paidScriptClaimKey(OP, jobId, 'commit'),
              _reqId: req.id,
            },
            jobId: `${OP}-commit-${jobId}`,
          });
        });
        settlement = 'commit';
      };

      const abort = new AbortController();
      const attempts: AiCallAttempt[] = [];
      const deadline = setTimeout(
        () => abort.abort(),
        options.deadlineMs ?? SCENARIO_SHOT_PLAN_DEADLINE_MS,
      );
      await db
        .update(scriptAssistRequests)
        .set({ updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, claim.id));

      const allowedLockIds = new Set(locks.map((lock) => lock.id));
      let schemaError: string | undefined;
      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const prompt = buildScenarioShotPlanPrompt({
            sceneId: sourceSceneId,
            format,
            targetDurationSeconds,
            sourceText: source.sourceText,
            brief: boundedText(JSON.stringify(script.brief ?? {}), 6_000),
            canon: boundedText(JSON.stringify(bible), 8_000),
            locks,
            approvedMediaRefs: mediaRefs,
            schemaError,
          });
          let content: string;
          try {
            ({ content } = await callScenarioShotPlanGateway({
              fetchImpl,
              signal: abort.signal,
              system: prompt.system,
              user: prompt.user,
              attempts,
            }));
          } catch (error) {
            scenarioShotPlanAttempts.labels('provider_fail').inc();
            await recordAiUsage(attempts, {
              op: 'scenario_shot_plan',
              userId: session.user.id,
              claimId: claim.id,
              scriptId: script.id,
            });
            await refundHold();
            await markRequest('aborted', abort.signal.aborted ? 'aborted' : 'provider_failed');
            return reply
              .status(abort.signal.aborted ? 504 : 502)
              .send({ error: abort.signal.aborted ? 'shot_plan_timeout' : 'shot_plan_failed' });
          }

          try {
            const raw = parseScenarioShotPlanOutput(content);
            if (raw.sceneId !== sourceSceneId) {
              throw new ScenarioShotPlanSchemaError('sceneId does not match requested scene');
            }
            const plan = normalizeScenarioShotPlan({
              raw,
              targetDurationSeconds,
              allowedLockIds,
            });
            scenarioShotPlanAttempts.labels('parsed').inc();
            await commitAtomic(plan);
            scenarioShotPlanRequestsTotal.labels('completed').inc();
            await recordAiUsage(attempts, {
              op: 'scenario_shot_plan',
              userId: session.user.id,
              claimId: claim.id,
              scriptId: script.id,
              creditsCharged: amount,
            });
            return reply.send(responseForPlan(plan, { credits: amount, cacheHit: false }));
          } catch (error) {
            if (
              !(error instanceof ScenarioShotPlanSchemaError) &&
              !(error instanceof ScenarioShotPlanDurationError)
            ) {
              throw error;
            }
            scenarioShotPlanAttempts.labels('schema_fail').inc();
            schemaError = error instanceof Error ? error.message : String(error);
            if (attempt === maxAttempts) {
              await recordAiUsage(attempts, {
                op: 'scenario_shot_plan',
                userId: session.user.id,
                claimId: claim.id,
                scriptId: script.id,
              });
              await refundHold();
              await markRequest('failed', 'unusable_output');
              scenarioShotPlanRequestsTotal.labels('unusable').inc();
              return reply.status(422).send({ error: 'shot_plan_unusable' });
            }
          }
        }
        await refundHold();
        await markRequest('failed', 'unusable_output');
        return reply.status(422).send({ error: 'shot_plan_unusable' });
      } catch (error) {
        if (error instanceof OwnershipLost) return conflict();
        req.log.error({ error, jobId }, 'scenario shot plan unexpected failure');
        if (settlement !== 'commit') {
          try {
            await refundHold();
          } catch (refundError) {
            req.log.error({ refundError, jobId }, 'scenario shot plan refund unavailable');
          }
          if (refundConfirmed) await markRequest('failed', 'unexpected_error');
        }
        return reply.status(500).send({ error: 'shot_plan_failed' });
      } finally {
        clearTimeout(deadline);
      }
    },
  );
}

async function callScenarioShotPlanGateway(input: {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  system: string;
  user: string;
  attempts: AiCallAttempt[];
}): Promise<{ content: string }> {
  let usage: AiUsage | null = null;
  let outcome: AiCallAttempt['outcome'] = 'error';
  let errorMessage: string | undefined;
  try {
    const response = await input.fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
        'Content-Type': 'application/json',
        'X-Title': 'Seed Scenario shot planner',
      },
      body: JSON.stringify({
        model: SCENARIO_SHOT_PLAN_MODEL,
        max_tokens: SCENARIO_SHOT_PLAN_BUDGET.output,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: input.user },
        ],
      }),
      signal: input.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`gateway ${response.status}: ${body.slice(0, 300)}`);
    }
    const json = (await response.json()) as {
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
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    input.attempts.push({
      route: 'openrouter',
      model: SCENARIO_SHOT_PLAN_MODEL,
      attempt: input.attempts.length + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}
