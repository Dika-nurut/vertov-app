import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  nid,
  scripts,
  scriptAssistRequests,
  scriptMaterials,
  scriptSnapshots,
  scriptThreadMessages,
  scriptThreads,
} from '@seed/db';
import type { ScriptThreadMessage } from '@seed/db';
import {
  creditService,
  enqueueViaOutbox,
  InsufficientCreditsError,
  paidScriptClaimKey,
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
} from '@seed/credits';
import {
  ASSIST_TIERS,
  ASSIST_TOKEN_BUDGET,
  CONSPECT_OUTPUT_TOKEN_LIMIT,
  assistPrice,
  assistTier,
  MATERIALS_SURCHARGE,
  MATERIAL_COMPACTION_OUTPUT_TOKEN_LIMIT,
  scenarioBriefV1Schema,
  scenarioFormatSchema,
  scenarioOutlineV1Schema,
  mergeAiUsage,
  parseOpenAiUsage,
  type AiCallAttempt,
  type AiUsage,
  type AssistScope,
  planScenarioAssistPricing,
  ScenarioContextLimitError,
  SCENARIO_CONTEXT_BANDS,
  SCENARIO_OUTPUT_TOKENS,
} from '@seed/shared';
import { relocateAnchor, spanContext, sceneIndexText, sceneList } from '@seed/screenplay';
import { assistTierIsActive, assistTierStatesView } from './assist-tier-state';
import { egressFetch } from './egress-fetch';
import {
  KIE_CLAUDE_PRIMARY_MODEL,
  KIE_PRIMARY_MODEL,
  kiePrimaryEnabled,
  streamKieClaudeCompletion,
  streamKieCompletion,
  type KieLegArgs,
} from './kie-chat';
import { dailySpendCap, releaseDailyBudget, reserveDailyBudget } from './spend-guard';
import {
  assembleAssistPrompt,
  conspectPrompt,
  fitAssistPromptToInputLimit,
  materialCompactionPrompt,
  CONSPECT_MAX_CHARS,
  conspectRefreshRequired,
  materialsBlock,
  SECTION,
  selectWindow,
  utf8Bytes,
} from './assist-context';
import { MATERIAL_SUMMARY_MAX_CHARS, MATERIAL_SUMMARY_MIN_RAW_CHARS } from '@seed/shared';
import { buildProjectMap } from './scenario-context';
import { recordAiUsage } from './ai-usage-store';
import { checkRateLimit } from './rate-limit';
import {
  scenarioAssistInFlight,
  scenarioAssistLatency,
  scenarioAssistRequestsTotal,
  scenarioAssistTextRoute,
  scenarioAssistTtft,
  scenarioAssistValidationFailures,
  scenarioContextPlans,
  scenarioAssistQuotesTotal,
  scenarioCreditSettlements,
  scenarioRollingSummaries,
} from './metrics';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface ScriptAssistOptions {
  /** Injectable for tests — MUST mock the gateway, never loop live calls. */
  fetchImpl?: typeof fetch;
  credits?: Pick<typeof creditService, 'reserve' | 'commit' | 'refund'>;
  /** Platform-wide daily provider-spend guard, shared with generation jobs. */
  spend?: { redis: IORedis; cap?: number };
  rateLimit?: { redis: IORedis; max?: number; windowSeconds?: number };
  deadlineMs?: number;
}

// Overridable so an e2e stack can point the gateway at a local mock (never a
// live call in tests). Defaults to the real OpenRouter endpoint in prod.
const OPENROUTER_URL =
  process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
/** Hard deadline for one assist call (no-infinite-loading doctrine). */
const ASSIST_DEADLINE_MS = 120_000;
const MAX_SCRIPT_CONTEXT_CHARS = 200_000; // ~120 pages (55 lines/page); ≈67k tokens

/** Thrown when the claim was reaped as stale while this handler was delayed. */
class OwnershipLost extends Error {
  constructor() {
    super('assist claim reclaimed by the reaper');
    this.name = 'OwnershipLost';
  }
}

const assistSchema = z.object({
  /** Stable for one logical client attempt; prevents duplicate paid calls on retry. */
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  threadId: z.string().min(1).optional(),
  question: z.string().trim().min(1).max(8_000),
  anchor: z
    .object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      rev: z.number().int().nonnegative(),
      quote: z.string().max(4_000),
    })
    .optional(),
  tier: z.enum(['economy', 'standard', 'max']).default('standard'),
  scope: z.enum(['project', 'span', 'scene', 'script']).optional(),
  sceneOrdinal: z.number().int().positive().optional(),
  confirmFullScript: z.literal(true).optional(),
  /** Quote returned by POST /assist/quote; checked before any hold/provider work. */
  expectedCredits: z.number().int().positive().optional(),
  quoteFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

const applySchema = z.object({
  baseRev: z.number().int().nonnegative(),
  /** Index of the assistant message whose proposal to apply; default: last. */
  messageIndex: z.number().int().nonnegative().optional(),
});

type ScenarioQuoteFingerprintInput = {
  scriptId: string;
  scriptRev: number;
  tier: string;
  scope: AssistScope;
  anchor: { from: number; to: number; rev: number } | null;
  sceneOrdinal: number | null;
  threadId: string | null;
  threadUpdatedAt: string | null;
  materialRevision: string;
  question: string;
  inputBand: string;
  contextReduced: boolean;
  conspectIncluded: boolean;
  conspectRefreshRequired: boolean;
};

/** Stable, non-PII quote identity. The question itself is represented only by a hash. */
export function scenarioQuoteFingerprint(input: ScenarioQuoteFingerprintInput): string {
  const canonical = JSON.stringify({
    ...input,
    question: createHash('sha256').update(input.question).digest('hex'),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Compatibility idempotency for pre-key clients. A random fallback would turn
 * a lost response into a second paid claim; this key is deliberately derived
 * from the stable request identity instead. New clients should still send an
 * explicit key so two deliberate identical questions can be distinguished.
 */
function legacyAssistIdempotencyKey(
  scriptId: string,
  userId: string,
  body: z.infer<typeof assistSchema>,
): string {
  const canonical = JSON.stringify({
    scriptId,
    userId,
    question: body.question,
    anchor: body.anchor ?? null,
    threadId: body.threadId ?? null,
    tier: body.tier,
    scope: body.scope ?? null,
    sceneOrdinal: body.sceneOrdinal ?? null,
    confirmFullScript: body.confirmFullScript === true,
    expectedCredits: body.expectedCredits ?? null,
    quoteFingerprint: body.quoteFingerprint ?? null,
  });
  return `legacy:${createHash('sha256').update(canonical).digest('hex')}`;
}

function materialRevision(
  materials: Array<{
    id?: string;
    name: string;
    content?: string;
    summary?: string | null;
    chars?: number;
    updatedAt?: Date | string;
  }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        materials.map((m) => [
          m.id ?? '',
          m.name,
          m.chars ?? 0,
          String(m.updatedAt ?? ''),
          m.content ? createHash('sha256').update(m.content).digest('hex') : '',
          m.summary ? createHash('sha256').update(m.summary).digest('hex') : '',
        ]),
      ),
    )
    .digest('hex');
}

type QuotePreparation = {
  script: typeof scripts.$inferSelect;
  scope: AssistScope;
  tier: ReturnType<typeof assistTier> & object;
  effectiveAnchor: { from: number; to: number; rev: number; quote: string } | null;
  detached: boolean;
  spanFrom: number;
  spanTo: number;
  thread: typeof scriptThreads.$inferSelect | undefined;
  materials: Array<{
    id: string;
    name: string;
    content: string;
    summary: string | null;
    chars: number;
    updatedAt: Date;
  }>;
  withMaterials: boolean;
  system: string;
  userContent: string;
  contextReduced: boolean;
  conspectIncluded: boolean;
  plan: ReturnType<typeof planScenarioAssistPricing>;
  quoteFingerprint: string;
};

/**
 * Resolve the exact bounded prompt identity used by both quote and submit.
 * It performs no claim, reserve, provider call, or write. Keeping it pure with
 * respect to money is what makes a stale quote fail before a credit hold.
 */
async function prepareScenarioQuote(args: {
  scriptId: string;
  userId: string;
  body: z.infer<typeof assistSchema>;
}): Promise<QuotePreparation> {
  const { scriptId, userId, body } = args;
  const scriptRows = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, scriptId), eq(scripts.userId, userId)))
    .limit(1);
  if (scriptRows.length === 0) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  const script = scriptRows[0]!;
  const tier = assistTier(body.tier)!;

  const materials = await db
    .select({
      id: scriptMaterials.id,
      name: scriptMaterials.name,
      content: scriptMaterials.content,
      summary: scriptMaterials.summary,
      chars: scriptMaterials.chars,
      updatedAt: scriptMaterials.updatedAt,
    })
    .from(scriptMaterials)
    .where(and(eq(scriptMaterials.scriptId, script.id), eq(scriptMaterials.includeInAi, 1)));
  const materialsText = materialsBlock(materials);

  let thread: typeof scriptThreads.$inferSelect | undefined;
  if (body.threadId) {
    const rows = await db
      .select()
      .from(scriptThreads)
      .where(
        and(
          eq(scriptThreads.id, body.threadId),
          eq(scriptThreads.scriptId, script.id),
          eq(scriptThreads.userId, userId),
        ),
      )
      .limit(1);
    thread = rows[0];
    if (!thread) throw Object.assign(new Error('not_found'), { code: 'not_found' });
  } else if (!body.anchor) {
    const rows = await db
      .select()
      .from(scriptThreads)
      .where(
        and(
          eq(scriptThreads.scriptId, script.id),
          eq(scriptThreads.userId, userId),
          eq(scriptThreads.kind, 'chat'),
        ),
      )
      .limit(1);
    thread = rows[0];
  }

  let effectiveAnchor = body.anchor ?? thread?.anchor ?? null;
  let detached = false;
  let spanFrom = 0;
  let spanTo = 0;
  if (effectiveAnchor) {
    const relocated = relocateAnchor(effectiveAnchor, script.fountain, script.rev);
    if (relocated.status === 'detached') {
      detached = true;
    } else {
      spanFrom = relocated.from;
      spanTo = relocated.to;
      effectiveAnchor = {
        from: relocated.from,
        to: relocated.to,
        rev: script.rev,
        quote: script.fountain.slice(relocated.from, relocated.to).slice(0, 4_000),
      };
    }
  }
  const ctxMode: 'anchored' | 'detached' | 'chat' = !effectiveAnchor
    ? 'chat'
    : detached
      ? 'detached'
      : 'anchored';
  let scope: AssistScope = ctxMode === 'chat' ? (body.scope ?? 'project') : 'span';
  if (scope === 'span' && !effectiveAnchor)
    throw Object.assign(new Error('span_requires_anchor'), { code: 'span_requires_anchor' });
  if (scope === 'scene' && body.sceneOrdinal === undefined)
    throw Object.assign(new Error('scene_requires_ordinal'), { code: 'scene_requires_ordinal' });
  if (scope === 'script' && body.confirmFullScript !== true)
    throw Object.assign(new Error('full_script_confirmation_required'), {
      code: 'full_script_confirmation_required',
    });
  if (ctxMode !== 'chat') scope = 'span';

  const historyRows = thread
    ? await db
        .select({
          role: scriptThreadMessages.role,
          content: scriptThreadMessages.content,
          proposal: scriptThreadMessages.proposal,
          tier: scriptThreadMessages.tier,
          createdAt: scriptThreadMessages.createdAt,
        })
        .from(scriptThreadMessages)
        .where(eq(scriptThreadMessages.threadId, thread.id))
        .orderBy(asc(scriptThreadMessages.createdAt), asc(scriptThreadMessages.id))
        .limit(200)
    : [];
  const history: ScriptThreadMessage[] = historyRows.length
    ? historyRows.map((message) => ({
        role: message.role as ScriptThreadMessage['role'],
        content: message.content,
        ...(message.proposal ? { proposal: message.proposal } : {}),
        ...(message.tier ? { tier: message.tier } : {}),
        at: message.createdAt.toISOString(),
      }))
    : (thread?.messages ?? []);
  const { window } = selectWindow(history);
  const project = {
    format: scenarioFormatSchema.parse(script.format),
    brief: scenarioBriefV1Schema.parse(script.brief),
    outline: scenarioOutlineV1Schema.parse(script.outline),
    fountain: script.fountain,
  };
  const sceneIndex = sceneIndexText(script.fountain);
  let sceneBlock: string;
  if (ctxMode === 'anchored') {
    const ctx = spanContext(script.fountain, spanFrom, spanTo);
    sceneBlock = [
      `=== ОГЛАВЛЕНИЕ СЦЕН ===\n${ctx.sceneIndex || '(без сцен)'}`,
      `=== СЦЕНА (${ctx.sceneHeadings.join(' / ') || 'фрагмент'}) ===\n${ctx.scene}`,
      `=== ВЫДЕЛЕННЫЙ ФРАГМЕНТ ===\n${ctx.span}`,
    ].join('\n\n');
  } else if (ctxMode === 'detached') {
    sceneBlock = [
      `Фрагмент, к которому был привязан вопрос, изменился или удалён. Его прежний текст:\n${body.anchor?.quote ?? thread?.anchor?.quote ?? ''}`,
      `=== ОГЛАВЛЕНИЕ СЦЕН ===\n${sceneIndex || '(без сцен)'}`,
    ].join('\n\n');
  } else if (scope === 'script') {
    if (script.fountain.length > MAX_SCRIPT_CONTEXT_CHARS) {
      throw new ScenarioContextLimitError('script', utf8Bytes(script.fountain), 83_800);
    }
    sceneBlock = [
      `=== ОГЛАВЛЕНИЕ СЦЕН ===\n${sceneIndex || '(без сцен)'}`,
      `=== СЦЕНАРИЙ ===\n${script.fountain}`,
    ].join('\n\n');
  } else if (scope === 'scene') {
    const target = sceneList(script.fountain).find((scene) => scene.index === body.sceneOrdinal);
    if (!target) throw Object.assign(new Error('unknown_scene'), { code: 'unknown_scene' });
    const map = buildProjectMap(project);
    sceneBlock = [
      map.text,
      `=== ТЕКУЩАЯ СЦЕНА ${target.index}: ${target.heading} ===\n${script.fountain.slice(target.from, target.to)}`,
      ...(map.omitted ? ['Контекст: часть карты проекта опущена по безопасному лимиту.'] : []),
    ].join('\n\n');
  } else {
    const map = buildProjectMap(project);
    sceneBlock = [
      map.text,
      ...(map.omitted ? ['Контекст: часть карты проекта опущена по безопасному лимиту.'] : []),
    ].join('\n\n');
  }

  const conspectIncluded = Boolean(thread?.conspect?.trim());
  const conspectRefresh = conspectRefreshRequired(
    history,
    thread?.conspectUpto ?? 0,
    body.question,
    SCENARIO_OUTPUT_TOKENS[scope],
  );
  const rawPrompt = assembleAssistPrompt({
    bible: script.bible,
    materials: materialsText,
    sceneBlock,
    conspect: thread?.conspect ?? '',
    window,
    question: body.question,
  });
  let fittedPrompt = rawPrompt;
  let contextReduced = false;
  const rawBytes = utf8Bytes(rawPrompt.system) + utf8Bytes(rawPrompt.user);
  const questionBytes = utf8Bytes(`${SECTION.question}\n${body.question}`);
  const maxEnvelope = {
    project: 24_000,
    span: 22_400,
    scene: 28_000,
    script: 83_800,
  }[scope];
  if (utf8Bytes(rawPrompt.system) + questionBytes > maxEnvelope) {
    throw new ScenarioContextLimitError(
      scope,
      utf8Bytes(rawPrompt.system) + questionBytes,
      maxEnvelope,
    );
  }
  if (scope === 'script' && rawBytes > 83_800) {
    throw new ScenarioContextLimitError('script', rawBytes, 83_800);
  }
  // Project/span/scene may disclose a bounded reduction; whole-script never
  // clips silently. Fit to the largest signed envelope before selecting the
  // final smallest band.
  if (rawBytes > maxEnvelope) {
    const fitted = fitAssistPromptToInputLimit(rawPrompt, maxEnvelope);
    fittedPrompt = { system: fitted.system, user: fitted.user };
    contextReduced = fitted.truncated;
  }
  const inputBytes = utf8Bytes(fittedPrompt.system) + utf8Bytes(fittedPrompt.user);
  const plan = planScenarioAssistPricing({
    tier: tier.id,
    scope,
    inputBytes,
    conspectIncluded,
    conspectRefreshRequired: conspectRefresh,
  });
  const quoteFingerprint = scenarioQuoteFingerprint({
    scriptId: script.id,
    scriptRev: script.rev,
    tier: tier.id,
    scope,
    anchor: effectiveAnchor
      ? { from: effectiveAnchor.from, to: effectiveAnchor.to, rev: effectiveAnchor.rev }
      : null,
    sceneOrdinal: body.sceneOrdinal ?? null,
    threadId: thread?.id ?? null,
    threadUpdatedAt: thread?.updatedAt?.toISOString() ?? null,
    materialRevision: materialRevision(materials),
    question: body.question,
    inputBand: plan.inputBand,
    contextReduced,
    conspectIncluded,
    conspectRefreshRequired: conspectRefresh,
  });
  return {
    script,
    scope,
    tier,
    effectiveAnchor,
    detached,
    spanFrom,
    spanTo,
    thread,
    materials,
    withMaterials: materials.length > 0,
    system: fittedPrompt.system,
    userContent: fittedPrompt.user,
    contextReduced,
    conspectIncluded,
    plan,
    quoteFingerprint,
  };
}

export function setupScriptAssistRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: ScriptAssistOptions = {},
): void {
  // Route OpenRouter (scenario AI разбор/chat/note) through the egress proxy —
  // the raw fetch 403s from the Cloudflare-blocked prod VM IP. Tests still inject
  // their own fetchImpl; egress is a no-op when EGRESS_PROXY_URL is unset.
  const fetchImpl = options.fetchImpl ?? egressFetch;
  const credits = options.credits ?? creditService;

  app.get('/v1/assist/tiers', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    // Include the admin ON/OFF state so the picker can grey out a disabled
    // tier instead of letting the user pick it and eat a 409 tier_disabled.
    const states = await assistTierStatesView();
    return {
      items: ASSIST_TIERS.map((t) => ({
        id: t.id,
        labelRu: t.labelRu,
        /** OpenRouter model slug — the client renders a friendly name + signature. */
        model: t.model,
        creditsPerCall: t.creditsPerCall,
        /** Always 0 now — materials are baked into the base price (kept for the client contract). */
        materialsSurcharge: MATERIALS_SURCHARGE[t.id],
        quoteRequired: true,
        contextBands: SCENARIO_CONTEXT_BANDS,
        isActive: states[t.id]?.isActive ?? true,
      })),
    };
  });

  /** Quote-only: resolves the signed context band without money or provider work. */
  app.post<{ Params: { id: string } }>('/v1/scripts/:id/assist/quote', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (session.user.isAnonymous) return reply.status(403).send({ error: 'signup_required' });
    const parsed = assistSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const tier = assistTier(parsed.data.tier)!;
    if (!(await assistTierIsActive(tier.id))) {
      return reply.status(409).send({ error: 'tier_disabled' });
    }
    try {
      const prepared = await prepareScenarioQuote({
        scriptId: req.params.id,
        userId: session.user.id,
        body: parsed.data,
      });
      scenarioAssistQuotesTotal
        .labels(prepared.tier.id, prepared.scope, prepared.plan.inputBand, 'quoted')
        .inc();
      return {
        tier: prepared.tier.id,
        scope: prepared.scope,
        credits: prepared.plan.credits,
        inputBand: prepared.plan.inputBand,
        maxOutputTokens: prepared.plan.maxOutputTokens,
        contextReduced: prepared.contextReduced,
        conspectIncluded: prepared.conspectIncluded,
        conspectRefreshRequired: prepared.plan.conspectRefreshRequired,
        quoteFingerprint: prepared.quoteFingerprint,
        scriptRev: prepared.script.rev,
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (code === 'unknown_scene') return reply.status(400).send({ error: code });
      if (code === 'span_requires_anchor' || code === 'scene_requires_ordinal') {
        return reply.status(400).send({ error: code });
      }
      if (code === 'full_script_confirmation_required') {
        return reply.status(409).send({ error: code });
      }
      if (err instanceof ScenarioContextLimitError) {
        return reply.status(413).send({
          error: err.code,
          scope: err.scope,
          inputBytes: err.inputBytes,
          maxInputBytes: err.maxInputBytes,
        });
      }
      req.log.error({ err }, 'scenario assist quote failed');
      return reply.status(400).send({ error: 'quote_unavailable' });
    }
  });

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/assist', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    // Pre-paywall anonymous browsing (2026-07-07): the hard wall. Plain
    // script writing (CRUD, /apply) stays free for anonymous sessions —
    // only invoking the AI assistant itself (this route, which reserves
    // credits below) requires a real signup.
    if (session.user.isAnonymous) {
      return reply.status(403).send({ error: 'signup_required' });
    }
    const parsed = assistSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { question, anchor } = parsed.data;
    const tier = assistTier(parsed.data.tier)!;
    // Resolve the same quote identity used by /assist/quote before creating a
    // claim or touching credits. Legacy clients may omit the two fields during
    // rollout; they still receive the server-computed band price, while new
    // clients get a hard 409 on a stale/mismatched quote.
    let preparedQuote: QuotePreparation;
    try {
      preparedQuote = await prepareScenarioQuote({
        scriptId: req.params.id,
        userId: session.user.id,
        body: parsed.data,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (
        code === 'unknown_scene' ||
        code === 'span_requires_anchor' ||
        code === 'scene_requires_ordinal'
      ) {
        return reply.status(400).send({ error: code });
      }
      if (code === 'full_script_confirmation_required') {
        return reply.status(409).send({ error: code });
      }
      if (err instanceof ScenarioContextLimitError) {
        return reply.status(413).send({
          error: err.code,
          scope: err.scope,
          inputBytes: err.inputBytes,
          maxInputBytes: err.maxInputBytes,
        });
      }
      req.log.error({ err }, 'scenario assist preparation failed');
      return reply.status(400).send({ error: 'quote_unavailable' });
    }
    const hasExpectedCredits = parsed.data.expectedCredits !== undefined;
    const hasQuoteFingerprint = parsed.data.quoteFingerprint !== undefined;
    if (hasExpectedCredits !== hasQuoteFingerprint) {
      return reply.status(400).send({ error: 'quote_required' });
    }
    if (
      (hasExpectedCredits && parsed.data.expectedCredits !== preparedQuote.plan.credits) ||
      (hasQuoteFingerprint && parsed.data.quoteFingerprint !== preparedQuote.quoteFingerprint)
    ) {
      scenarioAssistQuotesTotal
        .labels(tier.id, preparedQuote.scope, preparedQuote.plan.inputBand, 'stale')
        .inc();
      return reply.status(409).send({
        error: 'quote_stale',
        credits: preparedQuote.plan.credits,
        inputBand: preparedQuote.plan.inputBand,
        maxOutputTokens: preparedQuote.plan.maxOutputTokens,
        contextReduced: preparedQuote.contextReduced,
        conspectIncluded: preparedQuote.conspectIncluded,
        conspectRefreshRequired: preparedQuote.plan.conspectRefreshRequired,
        quoteFingerprint: preparedQuote.quoteFingerprint,
        scriptRev: preparedQuote.script.rev,
      });
    }
    // Admin kill-switch (assist_tier_states, owner 2026-07-24): a tier switched
    // OFF in /admin refuses new calls BEFORE the claim row and any credit hold —
    // fail closed with a clear code. Covers every assist entry (chat, note,
    // span) since they all funnel through this route. NOT gated: the internal
    // economy-model ops (rolling conспект, material compaction) and S1
    // structurization — those are not tier-picker calls (see STRUCTURIZE_MODEL).
    if (!(await assistTierIsActive(tier.id))) {
      return reply.status(409).send({ error: 'tier_disabled' });
    }
    // The prepared planner above is now authoritative for semantic scope:
    // anchored selection → span; unanchored chat → project by default, with
    // deliberate scene/script choices carrying their own confirmation.
    const script = preparedQuote.script;

    const rateRedis = options.rateLimit?.redis ?? options.spend?.redis;
    if (rateRedis) {
      const rateMax = options.rateLimit?.max ?? 30;
      const rateWindowSeconds = options.rateLimit?.windowSeconds ?? 10 * 60;
      const rate = await checkRateLimit(
        rateRedis,
        `scenario:assist:rate:${session.user.id}`,
        rateMax,
        rateWindowSeconds,
      );
      if (!rate.allowed) {
        reply.header('retry-after', String(rateWindowSeconds));
        return reply.status(429).send({ error: 'assist_rate_limited' });
      }
    }

    // Claim this paid request before touching credits or the provider. New web
    // clients always send a stable key. The compatibility fallback is derived
    // from the stable request identity, so an old client retry after a lost
    // response cannot turn into a second paid claim. Deliberate identical new
    // requests must use an explicit key to distinguish them.
    const idempotencyKey =
      parsed.data.idempotencyKey ??
      legacyAssistIdempotencyKey(req.params.id, session.user.id, parsed.data);
    // The claim's own id doubles as the credit-reservation jobId, so a crashed
    // assist's hold is reconcilable from the persisted row (op defaults 'assist').
    const claimId = nid();
    const [requestClaim] = await db
      .insert(scriptAssistRequests)
      .values({
        id: claimId,
        scriptId: script.id,
        userId: session.user.id,
        idempotencyKey,
        jobId: claimId,
      })
      // Deliberately target every unique constraint: an identical request key
      // and a different key while this user already has an in-flight call are
      // both safe no-ops, resolved below into a truthful 409.
      .onConflictDoNothing()
      .returning();
    if (!requestClaim) {
      // Idempotency uniqueness is now op-scoped ((user, op, key)), and this row
      // is op='assist' (the insert default). Filter every conflict lookup to
      // op='assist' so a structurize row that happens to share the key can never
      // be mistaken for this assist request (wrong status/thread metadata).
      const [existing] = await db
        .select({ status: scriptAssistRequests.status, threadId: scriptAssistRequests.threadId })
        .from(scriptAssistRequests)
        .where(
          and(
            eq(scriptAssistRequests.userId, session.user.id),
            eq(scriptAssistRequests.op, 'assist'),
            eq(scriptAssistRequests.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing) {
        const [inFlight] = await db
          .select({ threadId: scriptAssistRequests.threadId })
          .from(scriptAssistRequests)
          .where(
            and(
              eq(scriptAssistRequests.userId, session.user.id),
              eq(scriptAssistRequests.op, 'assist'),
              eq(scriptAssistRequests.status, 'in_progress'),
            ),
          )
          .limit(1);
        return reply.status(409).send({
          error: 'assist_in_progress',
          ...(inFlight?.threadId ? { threadId: inFlight.threadId } : {}),
        });
      }
      return reply.status(409).send({
        error: existing?.status === 'completed' ? 'assist_already_completed' : 'assist_in_progress',
        ...(existing?.threadId ? { threadId: existing.threadId } : {}),
      });
    }
    const markRequest = async (status: 'completed' | 'failed' | 'aborted', failure?: string) => {
      await db
        .update(scriptAssistRequests)
        .set({ status, ...(failure ? { failure } : {}), updatedAt: new Date() })
        .where(eq(scriptAssistRequests.id, requestClaim.id));
    };

    // The preparation object is the single context planner for quote and
    // submit. Reusing its material/thread/anchor/prompt fields prevents a
    // second reconstruction from silently changing the priced envelope.
    const materials = preparedQuote.materials;
    const withMaterials = preparedQuote.withMaterials;
    let thread = preparedQuote.thread;
    const effectiveAnchor = preparedQuote.effectiveAnchor;
    const detached = preparedQuote.detached;
    const spanFrom = preparedQuote.spanFrom;
    const spanTo = preparedQuote.spanTo;
    const scope = preparedQuote.scope;

    // ---- charge: server-computed flat price, reserve → commit/refund ----
    const signedQuoteProvided = hasExpectedCredits && hasQuoteFingerprint;
    // Keep mixed-version clients safe during rollout. A new client always
    // sends both quote fields and is charged the signed context-band amount;
    // an old client remains on the legacy workbook row until the UI upgrades.
    const cost = signedQuoteProvided
      ? preparedQuote.plan.credits
      : assistPrice(tier, scope, withMaterials);
    // The credit reservation is keyed on the claim's own id so the reaper (and
    // lazy recovery) can settle a crashed hold from the persisted row.
    const assistId = requestClaim.id;
    const cap = options.spend?.cap ?? dailySpendCap();
    let dailyBudgetReserved = false;
    if (options.spend && cap > 0) {
      const budget = await reserveDailyBudget(options.spend.redis, cost, cap);
      if (!budget.allowed) {
        await markRequest('failed', 'daily_spend_cap_exceeded');
        return reply.status(503).send({
          error: 'daily_spend_cap_exceeded',
          cap,
          message: 'Платформа достигла дневного лимита запросов к редактору. Попробуйте позже.',
        });
      }
      dailyBudgetReserved = true;
    }
    try {
      // Reserve the hold AND persist reserved=true + the amount in ONE tx, so the
      // reaper refunds ONLY confirmed holds for the amount actually reserved. A
      // crash before this commits leaves reserved=false → no doomed refund.
      // The flag update is FENCED on the claim still being ours (in_progress):
      // pre-provider work (DB, spend-guard) is NOT bounded by the 120s deadline,
      // so the reaper could delete an aged claim mid-flight — then this update hits
      // zero rows and we throw, rolling back the reserve so no hold is stranded.
      await db.transaction(async (tx) => {
        await credits.reserve({
          userId: session.user.id,
          jobId: assistId,
          amount: cost,
          reason: 'script.assist',
          idempotencyKey: paidScriptClaimKey('assist', assistId, 'reserve'),
          tx,
        });
        const owned = await tx
          .update(scriptAssistRequests)
          .set({ reserved: true, amount: cost, updatedAt: new Date() })
          .where(
            and(
              eq(scriptAssistRequests.id, assistId),
              eq(scriptAssistRequests.status, 'in_progress'),
            ),
          )
          .returning({ id: scriptAssistRequests.id });
        if (owned.length === 0) throw new OwnershipLost();
      });
    } catch (err) {
      if (dailyBudgetReserved) await releaseDailyBudget(options.spend!.redis, cost);
      if (err instanceof OwnershipLost) {
        // The claim was reaped as stale while we were delayed; the reserve rolled
        // back (no hold). Nothing to mark — the row is already gone.
        return reply.status(409).send({ error: 'assist_in_progress' });
      }
      if (err instanceof InsufficientCreditsError) {
        await markRequest('failed', 'insufficient_credits');
        return reply.status(402).send({ error: 'insufficient_credits', required: cost });
      }
      await markRequest('failed', 'reserve_failed');
      throw err;
    }

    // ---- use the exact bounded prompt produced by the shared planner ----
    // Memory floors and context reduction were already resolved before the
    // quote/fingerprint check; submit must not reconstruct a second variant.
    const { system, userContent } = preparedQuote;
    const ctxMode: 'anchored' | 'detached' | 'chat' = !effectiveAnchor
      ? 'chat'
      : detached
        ? 'detached'
        : 'anchored';
    scenarioContextPlans.labels(scope, contextSizeBucket(userContent.length)).inc();

    // ---- persist the user message up front (a crash must not eat it) ----
    const now = new Date().toISOString();
    const userMsg: ScriptThreadMessage = { role: 'user', content: question, at: now };
    if (thread) {
      await db
        .update(scriptThreads)
        .set({
          messages: [...thread.messages, userMsg],
          ...(detached ? { status: 'detached' } : {}),
          updatedAt: new Date(),
        })
        .where(eq(scriptThreads.id, thread.id));
    } else {
      const [row] = await db
        .insert(scriptThreads)
        .values({
          id: nid(),
          scriptId: script.id,
          userId: session.user.id,
          kind: ctxMode === 'chat' ? 'chat' : 'thread',
          anchor:
            ctxMode === 'anchored'
              ? effectiveAnchor
              : ctxMode === 'detached'
                ? (anchor ?? null)
                : null,
          messages: [userMsg],
          ...(detached ? { status: 'detached' } : {}),
        })
        .returning();
      thread = row!;
    }
    await db.insert(scriptThreadMessages).values({
      id: nid(),
      threadId: thread.id,
      scriptId: script.id,
      userId: session.user.id,
      role: 'user',
      content: userMsg.content,
      createdAt: new Date(now),
    });
    await db
      .update(scriptAssistRequests)
      .set({ threadId: thread.id, updatedAt: new Date() })
      .where(eq(scriptAssistRequests.id, requestClaim.id));

    // ---- SSE out (job-events conventions) ----
    // hijack() bypasses Fastify's response pipeline, so the CORS headers
    // @fastify/cors set on `reply` would be lost — propagate them onto the raw
    // response so the browser can read the stream when the API is cross-origin.
    const acao = reply.getHeader('access-control-allow-origin');
    const acac = reply.getHeader('access-control-allow-credentials');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      vary: 'Origin',
      ...(acao ? { 'access-control-allow-origin': String(acao) } : {}),
      ...(acac ? { 'access-control-allow-credentials': String(acac) } : {}),
    });
    const send = (payload: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send({
      threadId: thread.id,
      tier: tier.id,
      credits: cost,
      scope,
      materials: withMaterials,
      detached,
      inputBand: preparedQuote.plan.inputBand,
      maxOutputTokens: preparedQuote.plan.maxOutputTokens,
      contextReduced: preparedQuote.contextReduced,
      conspectIncluded: preparedQuote.conspectIncluded,
      conspectRefreshRequired: preparedQuote.plan.conspectRefreshRequired,
      quoteFingerprint: preparedQuote.quoteFingerprint,
      scriptRev: preparedQuote.script.rev,
    });

    const abort = new AbortController();
    const deadline = setTimeout(() => abort.abort(), options.deadlineMs ?? ASSIST_DEADLINE_MS);
    (req.raw as unknown as EventEmitter).on('close', () => abort.abort());

    // Complete the request durably AND ownership-fenced, all in ONE transaction:
    // fence the claim to 'completed' (the reaper may have refunded an aged claim
    // during a post-provider DB stall — pre/post-provider work isn't bounded by
    // the 120s deadline), persist the assistant turn (thread + ledger), and enqueue
    // the durable commit. Zero rows on the fence → throw OwnershipLost → the whole
    // tx rolls back, so we never publish paid output or charge for a claim we no
    // longer own. Returns the new message list for the конспект roll. (Commit is
    // async via the worker; available was already debited at reserve.)
    const completeAndCommit = async (
      assistantMsg: ScriptThreadMessage,
    ): Promise<ScriptThreadMessage[]> => {
      return db.transaction(async (tx) => {
        const owned = await tx
          .update(scriptAssistRequests)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(
            and(
              eq(scriptAssistRequests.id, assistId),
              eq(scriptAssistRequests.status, 'in_progress'),
            ),
          )
          .returning({ id: scriptAssistRequests.id });
        if (owned.length === 0) throw new OwnershipLost();
        const fresh = await tx
          .select()
          .from(scriptThreads)
          .where(eq(scriptThreads.id, thread.id))
          .limit(1);
        const newMessages = [...(fresh[0]?.messages ?? []), assistantMsg];
        await tx
          .update(scriptThreads)
          .set({ messages: newMessages, updatedAt: new Date() })
          .where(eq(scriptThreads.id, thread.id));
        await tx.insert(scriptThreadMessages).values({
          id: nid(),
          threadId: thread.id,
          scriptId: script.id,
          userId: session.user.id,
          role: 'assistant',
          content: assistantMsg.content,
          ...(assistantMsg.proposal ? { proposal: assistantMsg.proposal } : {}),
          ...(assistantMsg.tier ? { tier: assistantMsg.tier } : {}),
          createdAt: new Date(assistantMsg.at),
        });
        await enqueueViaOutbox({
          tx,
          queueName: CREDIT_COMMIT_QUEUE,
          jobId: `assist-commit-${assistId}`,
          payload: {
            userId: session.user.id,
            jobId: assistId,
            amount: cost,
            reason: 'script.assist.commit',
            idempotencyKey: paidScriptClaimKey('assist', assistId, 'commit'),
            _reqId: req.id,
          },
        });
        return newMessages;
      });
    };
    // Refund + mark terminal, durably. Inline first so the user's balance is
    // restored immediately; if the inline refund fails, mark terminal AND enqueue
    // the refund via the outbox in ONE tx — so it can never be swallowed into a
    // stranded hold. Same canonical key throughout → the ledger dedupes.
    const settleRefund = async (status: 'failed' | 'aborted', failure: string) => {
      const refundKey = paidScriptClaimKey('assist', assistId, 'refund');
      try {
        await credits.refund({
          userId: session.user.id,
          jobId: assistId,
          amount: cost,
          reason: 'script.assist.refund',
          idempotencyKey: refundKey,
        });
        await markRequest(status, failure);
      } catch (err) {
        req.log.warn(
          { err, assistId },
          'assist inline refund failed — deferring to durable outbox',
        );
        await db.transaction(async (tx) => {
          await tx
            .update(scriptAssistRequests)
            .set({ status, failure, updatedAt: new Date() })
            .where(eq(scriptAssistRequests.id, assistId));
          await enqueueViaOutbox({
            tx,
            queueName: CREDIT_REFUND_QUEUE,
            jobId: `assist-refund-${assistId}`,
            payload: {
              userId: session.user.id,
              jobId: assistId,
              amount: cost,
              reason: 'script.assist.refund',
              idempotencyKey: refundKey,
              _reqId: req.id,
            },
          });
        });
      }
      scenarioCreditSettlements.labels('refund').inc();
    };

    // Refresh the claim's lease right before the provider call, so the reaper
    // (which expires on updatedAt) never reaps this live request even if
    // pre-provider work was slow. Best-effort — the completion fence catches a
    // row that's already gone.
    await db
      .update(scriptAssistRequests)
      .set({ updatedAt: new Date() })
      .where(eq(scriptAssistRequests.id, assistId));

    const providerStartedAt = performance.now();
    let firstTokenObserved = false;
    let reasoningObserved = false;
    let providerContentObserved = false;
    const attempts: AiCallAttempt[] = [];
    let creditsCharged: number | null = null;
    const protocolFilter = new ProtocolStreamFilter();
    scenarioAssistInFlight.inc();
    try {
      const answer = await streamAssistCompletion({
        fetchImpl,
        signal: abort.signal,
        model: tier.model,
        disableReasoning: tier.disableReasoning ?? false,
        maxTokens: ASSIST_TOKEN_BUDGET[scope].output,
        system,
        user: userContent,
        onReasoning: () => {
          if (reasoningObserved || providerContentObserved) return;
          reasoningObserved = true;
          send({ phase: 'thinking' });
        },
        onDelta: (delta) => {
          if (!providerContentObserved) {
            providerContentObserved = true;
            send({ phase: 'typing' });
          }
          const visible = protocolFilter.push(delta);
          if (!firstTokenObserved && visible) {
            firstTokenObserved = true;
            scenarioAssistTtft
              .labels(tier.id, scope)
              .observe((performance.now() - providerStartedAt) / 1_000);
          }
          if (visible) send({ delta: visible });
        },
        attempts,
      });
      const visibleTail = protocolFilter.flush();
      if (visibleTail) {
        if (!firstTokenObserved) {
          firstTokenObserved = true;
          scenarioAssistTtft
            .labels(tier.id, scope)
            .observe((performance.now() - providerStartedAt) / 1_000);
        }
        send({ delta: visibleTail });
      }

      const proposal = extractProposal(
        answer,
        effectiveAnchor && !detached ? script.fountain.slice(spanFrom, spanTo) : undefined,
      );

      // A 200/SSE-complete transport is not enough to charge for an assist.
      // Providers occasionally terminate without text or emit only our hidden
      // protocol tags. Neither leaves the writer with a usable reply, so keep
      // their question for Retry but do not persist an assistant turn or spend
      // their credits.
      if (!isUsableAssistOutput(answer, !!proposal)) {
        scenarioAssistValidationFailures.labels(tier.id, scope).inc();
        await settleRefund('failed', 'unusable_output');
        scenarioAssistRequestsTotal.labels(tier.id, scope, 'invalid_refunded').inc();
        send({ error: 'assist_unusable' });
        return;
      }

      const assistantMsg: ScriptThreadMessage = {
        role: 'assistant',
        content: answer,
        tier: tier.id,
        ...(proposal ? { proposal } : {}),
        at: new Date().toISOString(),
      };
      let newMessages: ScriptThreadMessage[];
      try {
        newMessages = await completeAndCommit(assistantMsg);
      } catch (err) {
        if (err instanceof OwnershipLost) {
          // The claim was reaped + refunded mid-flight — do NOT publish paid output
          // or charge; the user's hold is already returned. Nothing was persisted.
          scenarioAssistRequestsTotal.labels(tier.id, scope, 'reaped').inc();
          send({ error: 'assist_failed' });
          return;
        }
        throw err;
      }
      scenarioCreditSettlements.labels('commit').inc();
      creditsCharged = cost;
      scenarioAssistRequestsTotal.labels(tier.id, scope, 'completed').inc();
      send({ done: true, threadId: thread.id, proposal: proposal ?? null, credits: cost });
      // Roll the conспект for the NEXT turn — invisible, cheap, and never
      // allowed to break the answer the user already has.
      await refreshConspect(fetchImpl, thread.id, newMessages)
        .then((changed) =>
          scenarioRollingSummaries.labels(changed ? 'updated' : 'not_needed').inc(),
        )
        .catch((err) => {
          scenarioRollingSummaries.labels('failed').inc();
          req.log.error({ err, threadId: thread.id }, 'conспект refresh failed');
        });
    } catch (err) {
      req.log.warn({ err, tier: tier.id, scope }, 'scenario assist provider call failed');
      await settleRefund(
        abort.signal.aborted ? 'aborted' : 'failed',
        abort.signal.aborted ? 'aborted' : 'provider_failed',
      );
      scenarioAssistRequestsTotal
        .labels(tier.id, scope, abort.signal.aborted ? 'aborted_refunded' : 'provider_refunded')
        .inc();
      send({
        error: abort.signal.aborted ? 'assist_timeout' : 'assist_failed',
        message: (err as Error).message,
      });
    } finally {
      scenarioAssistLatency
        .labels(tier.id, scope)
        .observe((performance.now() - providerStartedAt) / 1_000);
      scenarioAssistInFlight.dec();
      clearTimeout(deadline);
      // Recorded BEFORE the stream is terminated, and bounded inside
      // recordAiUsage by its own short timeout. Ending the response first would
      // release the socket a few ms earlier but makes the row's existence racy
      // for anything that reads it right after the response — including our own
      // tests. The unbounded-wait hazard this ordering used to carry is fixed by
      // the timeout inside the recorder, not by reordering.
      await recordAiUsage(
        attempts,
        {
          op: 'assist',
          userId: session.user.id,
          claimId: assistId,
          scriptId: script.id,
          creditsCharged,
        },
        req.log,
      );
      reply.raw.end();
    }
  });

  /**
   * Apply a rewrite proposal to the canvas: locate the anchored span at the
   * CURRENT text, verify the client saved from the current rev, replace,
   * bump rev, snapshot (cause 'apply'), mark the thread applied.
   */
  app.post<{ Params: { id: string; threadId: string } }>(
    '/v1/scripts/:id/threads/:threadId/apply',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = applySchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });

      const scriptRows = await db
        .select()
        .from(scripts)
        .where(and(eq(scripts.id, req.params.id), eq(scripts.userId, session.user.id)))
        .limit(1);
      if (scriptRows.length === 0) return reply.status(404).send({ error: 'not_found' });
      const script = scriptRows[0]!;

      const threadRows = await db
        .select()
        .from(scriptThreads)
        .where(
          and(
            eq(scriptThreads.id, req.params.threadId),
            eq(scriptThreads.scriptId, script.id),
            eq(scriptThreads.userId, session.user.id),
          ),
        )
        .limit(1);
      if (threadRows.length === 0) return reply.status(404).send({ error: 'not_found' });
      const thread = threadRows[0]!;

      if (parsed.data.baseRev !== script.rev) {
        return reply.status(409).send({ error: 'rev_conflict', rev: script.rev });
      }

      const candidates = thread.messages.filter((m) => m.role === 'assistant' && m.proposal);
      const message =
        parsed.data.messageIndex !== undefined
          ? thread.messages[parsed.data.messageIndex]
          : candidates[candidates.length - 1];
      if (!message?.proposal) return reply.status(400).send({ error: 'no_proposal' });
      const { before, after } = message.proposal;

      // Locate the text to replace: anchored span first, quote fallback.
      let from = -1;
      let to = -1;
      if (thread.anchor) {
        const r = relocateAnchor(thread.anchor, script.fountain, script.rev);
        if (r.status !== 'detached' && script.fountain.slice(r.from, r.to) === before) {
          from = r.from;
          to = r.to;
        }
      }
      if (from === -1 && before) {
        const idx = script.fountain.indexOf(before);
        if (idx !== -1) {
          from = idx;
          to = idx + before.length;
        }
      }
      if (from === -1) {
        await db
          .update(scriptThreads)
          .set({ status: 'detached', updatedAt: new Date() })
          .where(eq(scriptThreads.id, thread.id));
        return reply.status(409).send({ error: 'anchor_detached' });
      }

      const nextFountain = script.fountain.slice(0, from) + after + script.fountain.slice(to);
      const updated = await db
        .update(scripts)
        .set({ fountain: nextFountain, rev: script.rev + 1, updatedAt: new Date() })
        .where(
          and(
            eq(scripts.id, script.id),
            eq(scripts.userId, session.user.id),
            eq(scripts.rev, parsed.data.baseRev),
          ),
        )
        .returning({ rev: scripts.rev });
      if (updated.length === 0) {
        // Lost a race between our read and the write.
        const current = await db
          .select({ rev: scripts.rev })
          .from(scripts)
          .where(eq(scripts.id, script.id))
          .limit(1);
        return reply.status(409).send({ error: 'rev_conflict', rev: current[0]?.rev ?? 0 });
      }
      const rev = updated[0]!.rev;
      await db.insert(scriptSnapshots).values({
        id: nid(),
        scriptId: script.id,
        rev,
        fountain: nextFountain,
        cause: 'apply',
      });
      await db
        .update(scriptThreads)
        .set({
          status: 'applied',
          anchor: { from, to: from + after.length, rev, quote: after.slice(0, 4_000) },
          updatedAt: new Date(),
        })
        .where(eq(scriptThreads.id, thread.id));
      return { ok: true, rev, from, to: from + after.length };
    },
  );

  /**
   * Revert an applied proposal (T-2, launch-plan-round4): put back the exact
   * text the apply replaced, bump rev, snapshot (cause 'revert'), mark the
   * thread dismissed. Free - undo is an explicit visible button.
   */
  app.post<{ Params: { id: string; threadId: string } }>(
    '/v1/scripts/:id/threads/:threadId/revert',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;

      const scriptRows = await db
        .select()
        .from(scripts)
        .where(and(eq(scripts.id, req.params.id), eq(scripts.userId, session.user.id)))
        .limit(1);
      if (scriptRows.length === 0) return reply.status(404).send({ error: 'not_found' });
      const script = scriptRows[0]!;

      const threadRows = await db
        .select()
        .from(scriptThreads)
        .where(
          and(
            eq(scriptThreads.id, req.params.threadId),
            eq(scriptThreads.scriptId, script.id),
            eq(scriptThreads.userId, session.user.id),
          ),
        )
        .limit(1);
      if (threadRows.length === 0) return reply.status(404).send({ error: 'not_found' });
      const thread = threadRows[0]!;

      if (thread.status !== 'applied') {
        return reply.status(409).send({ error: 'not_applied' });
      }

      // Locate the applied AFTER text in the current document; replace it back
      // with the proposal's BEFORE text.
      const candidates = thread.messages.filter((m) => m.role === 'assistant' && m.proposal);
      const message = candidates[candidates.length - 1];
      if (!message?.proposal) return reply.status(409).send({ error: 'no_proposal' });

      const { before, after } = message.proposal;
      const anchor = thread.anchor;
      let from = -1;
      let to = -1;
      if (anchor) {
        const r = relocateAnchor(anchor, script.fountain, script.rev);
        if (r.status !== 'detached' && script.fountain.slice(r.from, r.to) === after) {
          from = r.from;
          to = r.to;
        }
      }
      if (from === -1 && after) {
        const idx = script.fountain.indexOf(after);
        if (idx !== -1) {
          from = idx;
          to = idx + after.length;
        }
      }
      if (from === -1) {
        return reply.status(409).send({ error: 'revert_detached' });
      }

      const nextFountain = script.fountain.slice(0, from) + before + script.fountain.slice(to);
      const updated = await db
        .update(scripts)
        .set({ fountain: nextFountain, rev: script.rev + 1, updatedAt: new Date() })
        .where(
          and(
            eq(scripts.id, script.id),
            eq(scripts.userId, session.user.id),
            eq(scripts.rev, script.rev),
          ),
        )
        .returning({ rev: scripts.rev });
      if (updated.length === 0) {
        const current = await db
          .select({ rev: scripts.rev })
          .from(scripts)
          .where(eq(scripts.id, script.id))
          .limit(1);
        return reply.status(409).send({ error: 'rev_conflict', rev: current[0]?.rev ?? 0 });
      }
      const rev = updated[0]!.rev;
      await db.insert(scriptSnapshots).values({
        id: nid(),
        scriptId: script.id,
        rev,
        fountain: nextFountain,
        cause: 'revert',
      });
      await db
        .update(scriptThreads)
        .set({ status: 'dismissed', updatedAt: new Date() })
        .where(eq(scriptThreads.id, thread.id));
      return { ok: true, rev, from, to: from + before.length };
    },
  );
}

/**
 * Background-compact one МИР ПРОЕКТА file into the editor's memory: the economy
 * model distills it to a canon-focused summary. Returns the summary ONLY when
 * it is genuinely shorter than the raw text (owner rule: a summary must never
 * exceed the raw char count) — otherwise null so the caller keeps the raw file.
 * Best-effort: any gateway error returns null (fall back to the raw content).
 */
export async function compactMaterialText(
  fetchImpl: typeof fetch,
  name: string,
  raw: string,
  ctx: { userId: string | null; scriptId: string | null } = { userId: null, scriptId: null },
): Promise<string | null> {
  if ([...raw].length < MATERIAL_SUMMARY_MIN_RAW_CHARS) return null; // small → inject whole
  const { system, user } = materialCompactionPrompt(name, raw);
  const attempts: AiCallAttempt[] = [];
  let summary: string;
  try {
    summary = await streamAssistCompletion({
      fetchImpl,
      signal: AbortSignal.timeout(ASSIST_DEADLINE_MS),
      model: ASSIST_TIERS.find((t) => t.id === 'economy')!.model,
      disableReasoning: ASSIST_TIERS.find((t) => t.id === 'economy')!.disableReasoning ?? false,
      maxTokens: MATERIAL_COMPACTION_OUTPUT_TOKEN_LIMIT,
      system,
      user,
      onDelta: () => {},
      attempts,
    });
  } catch {
    await recordAiUsage(attempts, { op: 'material_compaction', ...ctx });
    return null;
  }
  await recordAiUsage(attempts, { op: 'material_compaction', ...ctx });
  summary = summary.trim().slice(0, MATERIAL_SUMMARY_MAX_CHARS);
  // Guarantee strictly shorter than the raw text — else the summary buys
  // nothing and we keep the original.
  if (!summary || summary.length >= raw.length) return null;
  return summary;
}

/**
 * Injected into the scripts routes so a file upload can background-compact
 * itself (fire-and-forget). Kept out of the request path: the upload returns
 * immediately, the summary lands async and is used from the next turn on.
 */
export function makeMaterialCompactor(
  fetchImpl: typeof fetch,
): (m: {
  id: string;
  scriptId: string;
  userId: string;
  name: string;
  content: string;
}) => Promise<'ready' | 'raw_used'> {
  return async ({ id, scriptId, userId, name, content }) => {
    const summary = await compactMaterialText(fetchImpl, name, content, { userId, scriptId });
    if (!summary) return 'raw_used';
    await db.update(scriptMaterials).set({ summary }).where(eq(scriptMaterials.id, id));
    return 'ready';
  };
}

/**
 * Fold messages that have dropped out of the verbatim window into the
 * thread's rolling conспект — old conспект + newly-evicted messages → new,
 * bounded conспект. A no-op until the window actually overflows, so short
 * threads never incur an extra gateway call.
 */
async function refreshConspect(
  fetchImpl: typeof fetch,
  threadId: string,
  messages: ScriptThreadMessage[],
): Promise<boolean> {
  const { windowStart } = selectWindow(messages);
  const rows = await db
    .select({
      conspect: scriptThreads.conspect,
      conspectUpto: scriptThreads.conspectUpto,
      scriptId: scriptThreads.scriptId,
      userId: scriptThreads.userId,
    })
    .from(scriptThreads)
    .where(eq(scriptThreads.id, threadId))
    .limit(1);
  const upto = rows[0]?.conspectUpto ?? 0;
  if (windowStart <= upto) return false; // nothing new has been evicted
  const evicted = messages.slice(upto, windowStart);
  if (evicted.length === 0) return false;

  const economy = ASSIST_TIERS.find((t) => t.id === 'economy')!;
  const { system, user } = conspectPrompt(rows[0]?.conspect ?? '', evicted);
  const attempts: AiCallAttempt[] = [];
  let summary: string;
  try {
    summary = await streamAssistCompletion({
      fetchImpl,
      signal: AbortSignal.timeout(ASSIST_DEADLINE_MS),
      model: economy.model,
      disableReasoning: economy.disableReasoning ?? false,
      maxTokens: CONSPECT_OUTPUT_TOKEN_LIMIT,
      system,
      user,
      onDelta: () => {},
      attempts,
    });
  } finally {
    await recordAiUsage(attempts, {
      op: 'conspect',
      userId: rows[0]?.userId ?? null,
      scriptId: rows[0]?.scriptId ?? null,
    });
  }
  await db
    .update(scriptThreads)
    .set({
      conspect: summary.trim().slice(0, CONSPECT_MAX_CHARS),
      conspectUpto: windowStart,
      updatedAt: new Date(),
    })
    .where(eq(scriptThreads.id, threadId));
  return true;
}

function contextSizeBucket(chars: number): 'short' | 'medium' | 'long' {
  if (chars <= 12_000) return 'short';
  if (chars <= 40_000) return 'medium';
  return 'long';
}

class ProtocolStreamFilter {
  private buffer = '';
  private hidden: 'rewrite' | 'rule' | null = null;

  push(chunk: string): string {
    this.buffer += chunk.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    let visible = '';
    for (;;) {
      if (this.hidden) {
        const close = `</${this.hidden}>`;
        const end = this.buffer.toLowerCase().indexOf(close);
        if (end === -1) {
          this.buffer = this.buffer.slice(-close.length);
          return visible;
        }
        this.buffer = this.buffer.slice(end + close.length);
        this.hidden = null;
        continue;
      }
      const lower = this.buffer.toLowerCase();
      const candidates = (['rewrite', 'rule'] as const)
        .map((tag) => ({ tag, index: lower.indexOf(`<${tag}>`) }))
        .filter(({ index }) => index >= 0)
        .sort((a, b) => a.index - b.index);
      const next = candidates[0];
      if (next) {
        visible += this.buffer.slice(0, next.index);
        this.buffer = this.buffer.slice(next.index + next.tag.length + 2);
        this.hidden = next.tag;
        continue;
      }
      const keep = Math.min(this.buffer.length, 10);
      visible += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(-keep);
      return visible;
    }
  }

  flush(): string {
    if (this.hidden) return '';
    const visible = this.buffer;
    this.buffer = '';
    return visible;
  }
}

/** Stream one OpenRouter chat completion, invoking onDelta per token chunk. */
async function streamCompletion(args: {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  model: string;
  disableReasoning: boolean;
  maxTokens: number;
  system: string;
  user: string;
  onReasoning?: () => void;
  onDelta: (delta: string) => void;
  attempts?: AiCallAttempt[];
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  const requestBody = JSON.stringify({
    model: args.model,
    max_tokens: args.maxTokens,
    stream: true,
    ...(args.disableReasoning ? { reasoning: { enabled: false } } : {}),
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
  });

  // A provider occasionally drops a request before producing its first token.
  // Retrying once is safe only in that pre-output window: after a visible delta,
  // replaying would duplicate text in the writer's feed. 4xx contract failures
  // are not retried (except transient 408/425/429); aborts always stop promptly.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The request deadline may expire during the DB/context preparation above.
    // Native fetch rejects an already-aborted signal, but injected adapters and
    // provider SDKs are not guaranteed to replay an abort event to a late
    // listener. Fail closed before starting any provider work.
    args.signal.throwIfAborted();
    let full = '';
    let retryable = true;
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
        body: requestBody,
        signal: args.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => '');
        retryable =
          res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
        throw new Error(`gateway ${res.status}: ${body.slice(0, 300)}`);
      }

      let buffer = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            outcome = full ? 'ok' : 'empty';
            return full;
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning?: string;
                  reasoning_content?: string;
                  reasoning_details?: unknown[];
                };
              }>;
            };
            usage = mergeAiUsage(usage, parseOpenAiUsage(json));
            const frame = json.choices?.[0]?.delta;
            if (
              frame?.reasoning ||
              frame?.reasoning_content ||
              (frame?.reasoning_details?.length ?? 0) > 0
            ) {
              args.onReasoning?.();
            }
            const delta = frame?.content;
            if (delta) {
              full += delta;
              args.onDelta(delta);
            }
          } catch {
            // malformed provider frame — ignore it and continue the stream
          }
        }
      }
      // Some gateways close without [DONE]. Content is still usable; an empty
      // first attempt is equivalent to a pre-token transport drop and gets one retry.
      if (full || attempt === 1) {
        outcome = full ? 'ok' : 'empty';
        return full;
      }
      outcome = 'empty';
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      if (args.signal.aborted || full || !retryable || attempt === 1) throw err;
    } finally {
      args.attempts?.push({
        route: 'openrouter',
        model: args.model,
        attempt: (args.attempts?.length ?? 0) + 1,
        outcome,
        usage,
        ...(errorMessage ? { errorMessage } : {}),
      });
    }
  }
  return '';
}

type StreamCompletionArgs = Parameters<typeof streamCompletion>[0];

/**
 * Primary/fallback router for text completions (owner decisions 2026-07-24).
 * Two tiers go PRIMARY through kie.ai (see kie-chat.ts), each with OpenRouter
 * as the automatic fallback on ANY pre-token failure (transport error, !ok
 * status, empty stream):
 *   · standard — google/gemini-3-flash-preview via the OpenAI-shaped chat leg;
 *   · max      — anthropic/claude-sonnet-5 via the Anthropic-shaped claude leg.
 * Once a content delta was emitted we NEVER fall back — replaying on OR would
 * duplicate text in the writer's feed (the same rule streamCompletion's retry
 * loop follows). Every other model (economy qwen, structurize deepseek,
 * enhancer gpt-4o-mini) stays OR-only: the kie legs only ever see these slugs.
 * Metric leg labels: 'kie' (Gemini) / 'kie_claude' (Claude) / 'openrouter'.
 */
const KIE_LEGS: Record<string, { leg: (args: KieLegArgs) => Promise<string>; metric: string }> = {
  [KIE_PRIMARY_MODEL]: { leg: streamKieCompletion, metric: 'kie' },
  [KIE_CLAUDE_PRIMARY_MODEL]: { leg: streamKieClaudeCompletion, metric: 'kie_claude' },
};

async function streamAssistCompletion(args: StreamCompletionArgs): Promise<string> {
  const kie = KIE_LEGS[args.model];
  if (!kie) return streamCompletion(args);
  if (!kiePrimaryEnabled()) {
    scenarioAssistTextRoute.labels('openrouter', 'direct').inc();
    return streamCompletion(args);
  }
  let emitted = false;
  try {
    const text = await kie.leg({
      fetchImpl: args.fetchImpl,
      signal: args.signal,
      disableReasoning: args.disableReasoning,
      maxTokens: args.maxTokens,
      system: args.system,
      user: args.user,
      ...(args.onReasoning ? { onReasoning: args.onReasoning } : {}),
      onDelta: (delta) => {
        emitted = true;
        args.onDelta(delta);
      },
      ...(args.attempts ? { attempts: args.attempts } : {}),
    });
    if (text || emitted) {
      scenarioAssistTextRoute.labels(kie.metric, 'served').inc();
      return text;
    }
    // A transport-complete but content-empty stream is a pre-token failure
    // for routing purposes — safe to fall back, nothing was shown.
    scenarioAssistTextRoute.labels(kie.metric, 'empty_fallback').inc();
  } catch (err) {
    if (emitted || args.signal.aborted) {
      scenarioAssistTextRoute.labels(kie.metric, 'no_fallback').inc();
      throw err;
    }
    scenarioAssistTextRoute.labels(kie.metric, 'error_fallback').inc();
  }
  return streamCompletion(args);
}

/**
 * Pull a rewrite proposal out of the answer. `before` is the anchored span
 * text the model was asked to rewrite; without a span there is nothing to
 * safely replace, so no proposal is produced.
 */
function extractProposal(
  answer: string,
  before: string | undefined,
): { before: string; after: string } | undefined {
  if (!before) return undefined;
  const m = /<rewrite>([\s\S]*?)<\/rewrite>/.exec(answer);
  if (!m) return undefined;
  const after = m[1]!.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!after) return undefined;
  return { before, after };
}

/**
 * An assist response must contain visible prose, not merely transport success
 * or an internal protocol envelope. The UI intentionally hides <rewrite> and
 * <rule> tags, so an answer made only of those blocks would otherwise look
 * blank while still consuming credits.
 */
function isUsableAssistOutput(answer: string, hasProposal = false): boolean {
  if (!answer.trim()) return false;
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(answer)) return false;
  for (const tag of ['rewrite', 'rule'] as const) {
    const opens = answer.match(new RegExp(`<${tag}>`, 'gi'))?.length ?? 0;
    const closes = answer.match(new RegExp(`</${tag}>`, 'gi'))?.length ?? 0;
    if (opens !== closes) return false;
  }
  const withoutProtocolBlocks = answer
    .replace(/<(?:rewrite|rule)>[\s\S]*?<\/(?:rewrite|rule)>/gi, '')
    .trim();
  if (/<\/?(?:rewrite|rule)>/i.test(withoutProtocolBlocks)) return false;
  // A valid anchored rewrite is itself actionable UI: it renders as the Apply
  // proposal card even when the model omits optional prose outside the tag.
  return withoutProtocolBlocks.length > 0 || hasProposal;
}
