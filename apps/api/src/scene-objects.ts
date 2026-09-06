import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { and, eq, isNull } from 'drizzle-orm';
import { boards, db } from '@seed/db';
import { parseOpenAiUsage, type AiCallAttempt, type AiUsage } from '@seed/shared';
import { safeParseBoardDocument } from '@seed/shared/board-contract';
import {
  SCENE_OBJECTS_CEILING_CREDITS,
  SCENE_OBJECTS_INPUT_MAX_BYTES,
  SCENE_OBJECTS_MODEL,
  SCENE_OBJECTS_OUTPUT_MAX_TOKENS,
  SCENE_OBJECTS_VERSION,
  sceneObjectsModelResultSchema,
  sceneObjectsResponseSchema,
  validateSceneObjects,
  type SceneObjectsResponse,
} from '@seed/shared/scene-objects';
import { egressFetch } from './egress-fetch';
import { checkPerUserRateLimit } from './prompt-enhancer';
import {
  dailySpendCap,
  generationKilled,
  releaseDailyBudget,
  reserveDailyBudget,
  sceneObjectsDailySpendCap,
} from './spend-guard';
import { buildSceneObjectsPrompt } from './scene-objects-prompt';
import { recordAiUsage } from './ai-usage-store';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface SceneObjectsOptions {
  /** Injectable for tests — the gateway is never called by tests. */
  fetchImpl?: typeof fetch;
  /** Redis is used for the per-user wall, both daily caps, and replay store. */
  spend?: { redis: IORedis; cap?: number; extractionCap?: number };
  deadlineMs?: number;
  /** Injectable lease override for Redis lifecycle tests. */
  pendingLeaseSeconds?: number;
}

const OPENROUTER_URL =
  process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
const SCENE_OBJECTS_RATE_LIMIT_BUCKET = 'scene-objects';
const SCENE_OBJECTS_RATE_LIMIT_MAX = 6;
const SCENE_OBJECTS_DAILY_BUCKET = 'scene-objects';
const SCENE_OBJECTS_DAILY_WARNING_THRESHOLD = 200;
const SCENE_OBJECTS_IDEMPOTENCY_TTL_SECONDS = 30 * 24 * 60 * 60;
const SCENE_OBJECTS_DEADLINE_MS = 120_000;
const SCENE_OBJECTS_PENDING_LEASE_BUFFER_MS = 30_000;
const SCENE_OBJECTS_FAILURE_COOLDOWN_SECONDS = 30;
const SCENE_OBJECTS_IDEMPOTENCY_WAIT_MS = 10_000;
const SCENE_OBJECTS_IDEMPOTENCY_POLL_MS = 25;

type IdempotencyPending = { status: 'pending'; token: string };
type IdempotencyCooldown = { status: 'cooldown' };
type IdempotencyComplete = { status: 'complete'; result: SceneObjectsResponse };

function sourceHash(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

function promptInputHash(title: string, sourceText: string): string {
  const canonicalInput = JSON.stringify({ title, sourceText });
  return createHash('sha256').update(canonicalInput, 'utf8').digest('hex');
}

function idempotencyKey(
  userId: string,
  boardId: string,
  nodeId: string,
  canonicalPromptHash: string,
): string {
  const identity = JSON.stringify({
    userId,
    boardId,
    nodeId,
    canonicalPromptHash,
    contractVersion: SCENE_OBJECTS_VERSION,
  });
  return `seed:scene-objects:idempotency:${createHash('sha256').update(identity).digest('hex')}`;
}

function parseIdempotencyValue(
  raw: string | null,
): IdempotencyPending | IdempotencyCooldown | IdempotencyComplete | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { status?: unknown; token?: unknown; result?: unknown };
    if (value.status === 'pending' && typeof value.token === 'string') {
      return { status: 'pending', token: value.token };
    }
    if (value.status === 'cooldown') return { status: 'cooldown' };
    if (value.status === 'complete') {
      const result = sceneObjectsResponseSchema.safeParse(value.result);
      return result.success ? { status: 'complete', result: result.data } : null;
    }
  } catch {
    // A malformed replay value is not a result we can safely return.
  }
  return null;
}

async function waitForIdempotentResult(
  redis: IORedis,
  key: string,
): Promise<SceneObjectsResponse | null> {
  const deadline = Date.now() + SCENE_OBJECTS_IDEMPOTENCY_WAIT_MS;
  while (Date.now() < deadline) {
    const stored = parseIdempotencyValue(await redis.get(key));
    if (stored?.status === 'complete') return stored.result;
    if (stored?.status !== 'pending') return null;
    await new Promise((resolve) => setTimeout(resolve, SCENE_OBJECTS_IDEMPOTENCY_POLL_MS));
  }
  return null;
}

async function claimOrReplay(
  redis: IORedis,
  key: string,
  pendingLeaseSeconds: number,
): Promise<
  | { kind: 'replay'; result: SceneObjectsResponse }
  | { kind: 'claimed'; token: string }
  | { kind: 'in_progress' }
> {
  const token = randomUUID();
  const first = parseIdempotencyValue(await redis.get(key));
  if (first?.status === 'complete') return { kind: 'replay', result: first.result };
  if (first?.status === 'pending') {
    const result = await waitForIdempotentResult(redis, key);
    if (result) return { kind: 'replay', result };
    // A follower that saw a live claim may wait for its result, but it must
    // never inherit the claim after a failure or expired lease.
    return { kind: 'in_progress' };
  }
  if (first?.status === 'cooldown') return { kind: 'in_progress' };

  const acquired = await redis.set(
    key,
    JSON.stringify({ status: 'pending', token } satisfies IdempotencyPending),
    'EX',
    pendingLeaseSeconds,
    'NX',
  );
  if (acquired) return { kind: 'claimed', token };

  const result = await waitForIdempotentResult(redis, key);
  return result ? { kind: 'replay', result } : { kind: 'in_progress' };
}

const COMPARE_AND_DELETE_PENDING = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or current.status ~= 'pending' or current.token ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const COMPARE_AND_SET_PENDING = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, current = pcall(cjson.decode, raw)
if not ok or current.status ~= 'pending' or current.token ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

async function clearPending(redis: IORedis, key: string, token: string): Promise<void> {
  await redis.eval(COMPARE_AND_DELETE_PENDING, 1, key, token);
}

async function storeResult(
  redis: IORedis,
  key: string,
  token: string,
  result: SceneObjectsResponse,
): Promise<boolean> {
  const stored = await redis.eval(
    COMPARE_AND_SET_PENDING,
    1,
    key,
    token,
    JSON.stringify({ status: 'complete', result } satisfies IdempotencyComplete),
    String(SCENE_OBJECTS_IDEMPOTENCY_TTL_SECONDS),
  );
  return Number(stored) === 1;
}

async function storeCooldown(redis: IORedis, key: string, token: string): Promise<boolean> {
  const stored = await redis.eval(
    COMPARE_AND_SET_PENDING,
    1,
    key,
    token,
    JSON.stringify({ status: 'cooldown' } satisfies IdempotencyCooldown),
    String(SCENE_OBJECTS_FAILURE_COOLDOWN_SECONDS),
  );
  return Number(stored) === 1;
}

function pendingLeaseSeconds(deadlineMs: number): number {
  return Math.max(1, Math.ceil((deadlineMs + SCENE_OBJECTS_PENDING_LEASE_BUFFER_MS) / 1000));
}

function promptBytes(prompt: { system: string; user: string }): number {
  return Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(prompt.user, 'utf8');
}

function fitSceneObjectsPromptToBudget(
  title: string,
  sourceText: string,
  fullPrompt: { system: string; user: string },
): { system: string; user: string; sourceText: string; sourceTruncated: boolean } {
  if (promptBytes(fullPrompt) <= SCENE_OBJECTS_INPUT_MAX_BYTES) {
    return { ...fullPrompt, sourceText, sourceTruncated: false };
  }

  // Search by Unicode code point, not UTF-16 code unit, so the cut cannot split
  // a surrogate pair. The resulting prompt remains inside the priced UTF-8
  // envelope even when the board text uses three- or four-byte characters.
  const codePoints = Array.from(sourceText);
  let low = 0;
  let high = codePoints.length;
  let bestSource = '';
  let bestPrompt = buildSceneObjectsPrompt({ title, sourceText: bestSource });

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateSource = codePoints.slice(0, middle).join('');
    const candidatePrompt = buildSceneObjectsPrompt({ title, sourceText: candidateSource });
    if (promptBytes(candidatePrompt) <= SCENE_OBJECTS_INPUT_MAX_BYTES) {
      bestSource = candidateSource;
      bestPrompt = candidatePrompt;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (promptBytes(bestPrompt) > SCENE_OBJECTS_INPUT_MAX_BYTES) {
    throw new Error('scene objects fixed prompt exceeds priced input budget');
  }
  return { ...bestPrompt, sourceText: bestSource, sourceTruncated: true };
}

async function recordDailyWarning(
  redis: IORedis,
  userId: string,
  req: FastifyRequest,
): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `seed:scene-objects:daily:${day}:${userId}`;
  try {
    const count = Number(await redis.incr(key));
    if (count === 1) await redis.expire(key, 48 * 60 * 60);
    if (count === SCENE_OBJECTS_DAILY_WARNING_THRESHOLD + 1) {
      req.log.warn(
        { userId, count },
        'scene objects extraction count passed the daily monitoring threshold',
      );
    }
  } catch (err) {
    // Monitoring must never become a wall or prevent a free extraction.
    req.log.warn({ err, userId }, 'scene objects daily monitoring counter failed');
  }
}

export function setupSceneObjectsRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: SceneObjectsOptions = {},
): void {
  const fetchImpl = options.fetchImpl ?? egressFetch;

  app.post<{ Params: { boardId: string; nodeId: string } }>(
    '/v1/boards/:boardId/scenes/:nodeId/objects',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (session.user.isAnonymous) {
        return reply.status(403).send({ error: 'signup_required' });
      }
      if (generationKilled()) {
        req.log.warn(
          { userId: session.user.id },
          'scene objects rejected: generation kill-switch on',
        );
        return reply.status(503).send({ error: 'generation_disabled' });
      }

      const [board] = await db
        .select({ id: boards.id, state: boards.state })
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.boardId),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1);
      if (!board) return reply.status(404).send({ error: 'not_found' });

      const redis = options.spend?.redis;
      if (!redis) {
        req.log.error({ userId: session.user.id }, 'scene objects Redis is not configured');
        return reply.status(503).send({ error: 'scene_objects_unavailable' });
      }
      const rate = await checkPerUserRateLimit(
        redis,
        session.user.id,
        SCENE_OBJECTS_RATE_LIMIT_BUCKET,
        SCENE_OBJECTS_RATE_LIMIT_MAX,
      );
      reply.header('x-ratelimit-limit', String(SCENE_OBJECTS_RATE_LIMIT_MAX));
      reply.header('x-ratelimit-remaining', String(rate.remaining));
      if (!rate.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });

      const document = safeParseBoardDocument(board.state);
      if (!document.success) {
        req.log.error(
          { boardId: board.id, issues: document.error.issues },
          'stored board document failed validation',
        );
        return reply.status(500).send({ error: 'invalid_board_state' });
      }
      const node = document.data.nodes.find((candidate) => candidate.id === req.params.nodeId);
      if (!node || node.type !== 'scene') return reply.status(404).send({ error: 'not_found' });
      if (!node.data.sourceText.trim()) {
        return reply.status(422).send({ error: 'scene_source_empty' });
      }
      if (node.data.sourceStatus === 'removed') {
        return reply.status(409).send({ error: 'scene_removed' });
      }

      const computedHash = sourceHash(node.data.sourceText);
      const canonicalPromptHash = promptInputHash(node.data.title, node.data.sourceText);
      const key = idempotencyKey(
        session.user.id,
        req.params.boardId,
        req.params.nodeId,
        canonicalPromptHash,
      );
      const deadlineMs = options.deadlineMs ?? SCENE_OBJECTS_DEADLINE_MS;
      const leaseSeconds = options.pendingLeaseSeconds ?? pendingLeaseSeconds(deadlineMs);
      const claim = await claimOrReplay(redis, key, leaseSeconds);
      if (claim.kind === 'replay') return reply.status(200).send(claim.result);
      if (claim.kind === 'in_progress') {
        return reply.status(409).send({ error: 'scene_objects_in_progress' });
      }

      const { token } = claim;
      let globalBudgetReserved = false;
      let extractionBudgetReserved = false;
      let providerCalled = false;
      let resultStored = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const budgetDate = new Date();
      const attempts: AiCallAttempt[] = [];

      try {
        const cap = options.spend?.cap ?? dailySpendCap();
        const extractionCap = options.spend?.extractionCap ?? sceneObjectsDailySpendCap();
        // Both caps fail closed. The global bucket is the platform-wide total;
        // the extraction bucket is deliberately configured separately and lower
        // so a free extraction feature cannot consume all paid-generation room.
        if (cap <= 0) {
          return reply.status(503).send({ error: 'daily_spend_cap_unconfigured' });
        }
        if (extractionCap <= 0) {
          return reply.status(503).send({ error: 'scene_objects_daily_cap_unconfigured' });
        }

        let globalBudget: Awaited<ReturnType<typeof reserveDailyBudget>>;
        try {
          globalBudget = await reserveDailyBudget(
            redis,
            SCENE_OBJECTS_CEILING_CREDITS,
            cap,
            budgetDate,
          );
        } catch (err) {
          req.log.error(
            { err, userId: session.user.id },
            'scene objects global daily budget unavailable',
          );
          return reply.status(503).send({ error: 'daily_spend_unavailable' });
        }
        if (!globalBudget.allowed) {
          req.log.warn(
            { userId: session.user.id, current: globalBudget.current, cap },
            'scene objects rejected: global daily spend cap reached',
          );
          return reply.status(503).send({
            error: 'daily_spend_cap_exceeded',
            cap,
          });
        }
        globalBudgetReserved = true;

        let extractionBudget: Awaited<ReturnType<typeof reserveDailyBudget>>;
        try {
          extractionBudget = await reserveDailyBudget(
            redis,
            SCENE_OBJECTS_CEILING_CREDITS,
            extractionCap,
            budgetDate,
            SCENE_OBJECTS_DAILY_BUCKET,
          );
        } catch (err) {
          req.log.error(
            { err, userId: session.user.id },
            'scene objects extraction daily budget unavailable',
          );
          return reply.status(503).send({ error: 'scene_objects_daily_unavailable' });
        }
        if (!extractionBudget.allowed) {
          req.log.warn(
            { userId: session.user.id, current: extractionBudget.current, cap: extractionCap },
            'scene objects rejected: extraction daily spend cap reached',
          );
          return reply.status(503).send({
            error: 'scene_objects_daily_cap_exceeded',
            cap: extractionCap,
          });
        }
        extractionBudgetReserved = true;

        const fullPrompt = buildSceneObjectsPrompt({
          title: node.data.title,
          sourceText: node.data.sourceText,
        });
        const prompt = fitSceneObjectsPromptToBudget(
          node.data.title,
          node.data.sourceText,
          fullPrompt,
        );

        await recordDailyWarning(redis, session.user.id, req);
        const abort = new AbortController();
        deadline = setTimeout(() => abort.abort(), deadlineMs);
        providerCalled = true;
        let content: string;
        try {
          ({ content } = await callGatewayForSceneObjects({
            fetchImpl,
            signal: abort.signal,
            system: prompt.system,
            user: prompt.user,
            attempts,
          }));
        } catch (err) {
          await recordAiUsage(attempts, { op: 'scene_objects', userId: session.user.id }, req.log);
          const aborted = abort.signal.aborted;
          req.log.warn({ err, userId: session.user.id }, 'scene objects gateway failed');
          return reply
            .status(aborted ? 504 : 502)
            .send({ error: aborted ? 'scene_objects_timeout' : 'scene_objects_failed' });
        }

        let parsed: ReturnType<typeof sceneObjectsModelResultSchema.parse>;
        try {
          const json = JSON.parse(content) as unknown;
          const checked = sceneObjectsModelResultSchema.safeParse(json);
          if (!checked.success) {
            throw new Error(
              checked.error.issues
                .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
                .join('; '),
            );
          }
          parsed = checked.data;
        } catch (err) {
          await recordAiUsage(attempts, { op: 'scene_objects', userId: session.user.id }, req.log);
          req.log.warn(
            { err, userId: session.user.id },
            'scene objects response failed schema validation',
          );
          return reply.status(422).send({ error: 'scene_objects_unusable' });
        }

        const validated = validateSceneObjects(parsed, prompt.sourceText);
        if (validated.dropped > 0) {
          req.log.warn(
            {
              userId: session.user.id,
              boardId: board.id,
              nodeId: node.id,
              dropped: validated.dropped,
            },
            'scene objects response contained unsupported source text',
          );
        }
        const response: SceneObjectsResponse = {
          objects: validated.objects,
          sourceHash: computedHash,
          sourceTruncated: prompt.sourceTruncated,
        };
        await recordAiUsage(attempts, { op: 'scene_objects', userId: session.user.id }, req.log);
        if (!(await storeResult(redis, key, token, response))) {
          throw new Error('scene objects replay claim was lost before completion');
        }
        resultStored = true;
        return reply.status(200).send(response);
      } catch (err) {
        req.log.error({ err, userId: session.user.id }, 'scene objects request failed');
        // A provider-started failure is cooled down in finally, so a follower
        // cannot inherit this claim and start another paid attempt.
        return reply.status(500).send({ error: 'scene_objects_failed' });
      } finally {
        if (deadline) clearTimeout(deadline);
        if (!resultStored && providerCalled) {
          try {
            const cooledDown = await storeCooldown(redis, key, token);
            if (!cooledDown) {
              req.log.warn(
                { userId: session.user.id },
                'scene objects could not write provider failure cooldown',
              );
            }
          } catch (err) {
            req.log.warn(
              { err, userId: session.user.id },
              'scene objects provider failure cooldown write failed',
            );
          }
        }
        if (!resultStored && !providerCalled) {
          if (extractionBudgetReserved) {
            try {
              await releaseDailyBudget(
                redis,
                SCENE_OBJECTS_CEILING_CREDITS,
                budgetDate,
                SCENE_OBJECTS_DAILY_BUCKET,
              );
            } catch (err) {
              req.log.error(
                { err, userId: session.user.id },
                'scene objects extraction daily budget release failed',
              );
            }
          }
          if (globalBudgetReserved) {
            try {
              await releaseDailyBudget(redis, SCENE_OBJECTS_CEILING_CREDITS, budgetDate);
            } catch (err) {
              req.log.error(
                { err, userId: session.user.id },
                'scene objects global daily budget release failed',
              );
            }
          }
          try {
            await clearPending(redis, key, token);
          } catch (err) {
            req.log.warn(
              { err, userId: session.user.id },
              'scene objects replay key cleanup failed',
            );
          }
        }
      }
    },
  );
}

async function callGatewayForSceneObjects(args: {
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
    const response = await args.fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Seed',
      },
      body: JSON.stringify({
        model: SCENE_OBJECTS_MODEL,
        max_tokens: SCENE_OBJECTS_OUTPUT_MAX_TOKENS,
        reasoning: { enabled: false },
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
      }),
      signal: args.signal,
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
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    args.attempts.push({
      route: 'openrouter',
      model: SCENE_OBJECTS_MODEL,
      attempt: args.attempts.length + 1,
      outcome,
      usage,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }
}
