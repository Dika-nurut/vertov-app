import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type IORedis from 'ioredis';
import { z } from 'zod';
import {
  createPromptEnhancerAdapter,
  type PromptEnhancerAdapter,
} from '@seed/provider-prompt-enhancer';
import { type AiCallAttempt } from '@seed/shared';
import type { db } from '@seed/db';
import { checkRateLimit } from './rate-limit';
import { egressFetch } from './egress-fetch';
import { recordAiUsage } from './ai-usage-store';

// Lazy-load the credits module so importing this file does not pull in the
// database pool (which requires DATABASE_URL at module load time). The flag
// reader is only invoked inside the request handler.
const PROMPT_ENHANCER_ENABLED_KEY = 'prompt_enhancer_enabled';

const enhanceSchema = z.object({
  promptRu: z.string().min(1, 'prompt_required').max(4000, 'prompt_too_long'),
});

type DbLike = typeof db;

let adapter: PromptEnhancerAdapter | null = null;
function getAdapter(): PromptEnhancerAdapter {
  if (!adapter) {
    adapter = createPromptEnhancerAdapter(undefined, { fetch: egressFetch });
  }
  return adapter;
}

type RequireSession = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Per-user rate-limit, keyed `seed:<bucket>:<userId>` over a fixed window.
 *
 * Rationale: @fastify/rate-limit's keyGenerator runs in onRequest, before the
 * handler sets session info, so it always falls back to req.ip and multiple
 * users behind one NAT share a bucket. Doing the check manually inside the
 * handler (after auth) gives true per-user isolation regardless of IP.
 *
 * SF-6: delegates to the atomic `checkRateLimit` (one Lua INCR + PEXPIRE-on-
 * first) — the old INCR-then-EXPIRE could crash between the two calls and leave
 * a key with no TTL, permanently locking the user out.
 */
export async function checkPerUserRateLimit(
  redis: IORedis,
  userId: string,
  bucket = 'enhancer',
  max = RATE_LIMIT_MAX,
): Promise<{ allowed: boolean; count: number; remaining: number }> {
  return checkRateLimit(redis, `seed:${bucket}:${userId}`, max, RATE_LIMIT_WINDOW_SECONDS);
}

/**
 * POST /v1/prompt-enhancer/enhance
 *
 * Accepts { promptRu } and returns { enhancedEn, backTranslationRu, mode }.
 * Rate-limited to 30 requests per minute per user (Redis INCR — per-user,
 * not per-IP, so NAT-sharing and IP-switching don't bypass the limit).
 * Input capped at 4 000 chars (budget guardrail).
 */
export function setupPromptEnhancerRoutes(
  app: FastifyInstance,
  requireSession: RequireSession,
  redis: IORedis,
  deps: { db?: DbLike; isEnabled?: () => Promise<boolean> } = {},
): void {
  const isEnabled =
    deps.isEnabled ??
    (async () => {
      const { readBoolFlag } = await import('@seed/credits');
      return readBoolFlag(PROMPT_ENHANCER_ENABLED_KEY, false, deps.db);
    });

  app.post('/v1/prompt-enhancer/enhance', async (req, reply) => {
    if (!(await isEnabled())) {
      return reply.status(503).send({ error: 'feature_disabled' });
    }

    const session = await requireSession(req, reply);
    if (!session) return;

    const userId = session.user.id;

    // Per-user rate limit check (Redis-backed, not IP-based).
    const rl = await checkPerUserRateLimit(redis, userId);
    if (!rl.allowed) {
      reply.header('x-ratelimit-limit', String(RATE_LIMIT_MAX));
      reply.header('x-ratelimit-remaining', '0');
      return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }
    reply.header('x-ratelimit-limit', String(RATE_LIMIT_MAX));
    reply.header('x-ratelimit-remaining', String(rl.remaining));

    const parsed = enhanceSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return reply.status(400).send({
        error: first?.message === 'prompt_required' ? 'prompt_required' : 'prompt_too_long',
        issues: parsed.error.issues,
      });
    }

    const attempts: AiCallAttempt[] = [];
    try {
      const enhancer = getAdapter();
      const { enhancedEn, backTranslationRu } = await enhancer.enhance(
        {
          promptRu: parsed.data.promptRu,
        },
        attempts,
      );
      await recordAiUsage(attempts, { op: 'prompt_enhancer', userId }, req.log);
      return { enhancedEn, backTranslationRu, mode: enhancer.mode };
    } catch (err) {
      await recordAiUsage(attempts, { op: 'prompt_enhancer', userId }, req.log);
      req.log.error({ err }, 'enhancer_failed');
      // Degrade gracefully: return the original prompt as-is so the user's
      // generation still proceeds. mode='stub-fallback' lets the UI inform
      // the user the enhancer is temporarily unavailable.
      return reply.status(200).send({
        enhancedEn: parsed.data.promptRu,
        backTranslationRu: parsed.data.promptRu,
        mode: 'stub-fallback',
      });
    }
  });
}
