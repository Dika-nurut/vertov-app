import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import {
  creditFloorRub,
  db,
  jobs,
  models,
  nid,
  realGateway,
  resolveUserPlanTier,
  readRouteLegHealth,
  routeLegHealthIsHealthy,
  workflows,
  type BreakEvenModel,
} from '@seed/db';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import {
  generationJobRequestSchema,
  generationJobEstimateSchema,
  generationJobSubmitSchema,
  unknownGenerationParamKeys,
} from '@seed/shared/generation-request';
import {
  EXECUTION_SNAPSHOT_VERSION,
  type ExecutionSnapshot,
} from '@seed/shared/execution-snapshot';
import { subscriptionTierAllows } from '@seed/shared/subscription-tiers';
import { validateBoardCompiledGenerationRequest } from '@seed/shared/board-contract';
import { resolveCatalogueEntry, type FrameRole } from '@seed/shared/select-route';
import {
  type CreditService,
  InsufficientCreditsError,
  JOB_RUN_QUEUE,
  enqueueViaOutbox,
} from '@seed/credits';
import {
  countActiveJobsForUser,
  getJobForUser,
  isJobStatus,
  listJobsForUser,
  type JobStatus,
} from './jobs-list';
import { checkPerUserRateLimit } from './prompt-enhancer';
import { screenPrompt } from './moderation';
import { firstUnsafeReferenceUrl, referenceAllowedOrigins } from './safe-ref-url';
import {
  loadActivePricePointsByModel,
  minBillableDurationSeconds,
  loadActivePricePoints,
  priceRefusalMessage,
  referenceCapMessage,
  referenceCapRefusal,
  referenceImageCountForPricing,
  clampReferenceCountToModel,
  priceModeForRequest,
  resolveJobPriceFromPoints,
  validateVideoResolution,
} from './pricing-resolver';
import {
  checkDailyBudget,
  dailySpendCap,
  generationKilled,
  releaseDailyBudget,
  reserveDailyBudget,
} from './spend-guard';
import { validateOwnedLiveProject } from './project-context';
import { emitShadowRoute, type ShadowRouteLogger } from './route-shadow';
import { isExecutableGenerationKind } from './model-exposure';
import {
  collectImageReferenceCandidates,
  createMinioReferenceDimensionProbe,
  preflightReferenceDimensions,
  referenceMaxDimension,
  type ReferenceDimensionProbe,
} from './reference-dimensions';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface JobsRoutesDeps {
  redis: IORedis;
  credits: CreditService;
  /** Injectable for tests; production defaults to the authenticated MinIO probe. */
  referenceProbe?: ReferenceDimensionProbe;
}

// Per-user submit throttle — generation is the most expensive action. Redis
// INCR keys it per user (not per NAT-shared IP). An abuse ceiling, not a quota.
const JOBS_RATE_LIMIT_MAX = 60;
// SF-11: per-user in-flight (queued|running) concurrency cap.
const JOBS_MAX_INFLIGHT = Number(process.env.JOBS_MAX_INFLIGHT ?? 8);
// SF-8: own-origin allow-list for user-supplied reference URLs (imageUrls etc.).
const REFERENCE_ALLOWED_ORIGINS = referenceAllowedOrigins();
const ROUTE_CREDIT_FLOOR_RUB = creditFloorRub(seedSubscriptionTiers);

export function setupJobsRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  deps: JobsRoutesDeps,
): void {
  const { redis, credits } = deps;
  const referenceProbe = deps.referenceProbe ?? createMinioReferenceDimensionProbe();

  app.post('/v1/jobs', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    // Pre-paywall anonymous browsing (2026-07-07): the hard wall. Generate's
    // submit AND Boards' node "Run" both create jobs through this one
    // endpoint, so gating it here covers both surfaces in one place.
    // Anonymous sessions can browse/create/edit freely — they just can't
    // reach the actual credit-spending call until they sign up for real.
    if (session.user.isAnonymous) {
      return reply.status(403).send({ error: 'signup_required' });
    }

    // BL-1: hard kill-switch — refuse ALL new generation immediately, before
    // any reservation or provider enqueue.
    if (generationKilled()) {
      req.log.warn({ userId: session.user.id }, 'job rejected: generation kill-switch on');
      return reply.status(503).send({ error: 'generation_disabled' });
    }

    const rl = await checkPerUserRateLimit(redis, session.user.id, 'jobs', JOBS_RATE_LIMIT_MAX);
    reply.header('x-ratelimit-limit', String(JOBS_RATE_LIMIT_MAX));
    reply.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) {
      return reply.status(429).send({ error: 'rate_limit_exceeded' });
    }

    // SF-11: per-user in-flight concurrency cap (queued|running). Set
    // JOBS_MAX_INFLIGHT=0 to disable.
    if (JOBS_MAX_INFLIGHT > 0) {
      const active = await countActiveJobsForUser(session.user.id, JOBS_MAX_INFLIGHT);
      if (active >= JOBS_MAX_INFLIGHT) {
        return reply.status(429).send({ error: 'too_many_active_jobs', limit: JOBS_MAX_INFLIGHT });
      }
    }

    const parsed = generationJobSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    let input = parsed.data;

    if (input.projectId) {
      const project = await validateOwnedLiveProject(db, input.projectId, session.user.id);
      if (!project) return reply.status(404).send({ error: 'not_found' });
    }

    // DoD 6 (log-first): surface params keys outside the known vocabulary so the
    // eventual schema tightening can flip to reject once real traffic proves the
    // allowlist complete. LOG ONLY — never rejects here.
    const submitOffContract = unknownGenerationParamKeys(input.params);
    if (submitOffContract.length > 0) {
      req.log.warn(
        {
          userId: session.user.id,
          modelId: input.modelId,
          // Key names are user-controlled — cap count + length so a crafted request
          // can't spam the log or smuggle content through a key name.
          offContractKeys: submitOffContract.slice(0, 20).map((k) => k.slice(0, 64)),
        },
        'generation params carry off-contract keys (DoD 6 log-first — not rejected)',
      );
    }

    // M-1: severe-content pre-screen (CSAE only, EN+RU). Refuse before any
    // reservation or provider enqueue. Deliberately narrow — everything else is
    // left to model self-moderation + the provider NSFW signal. Don't log the
    // prompt itself (abuse content / privacy); the category is enough for ops.
    const screen = screenPrompt(input.prompt);
    if (screen.blocked) {
      req.log.warn(
        { userId: session.user.id, category: screen.category },
        'job rejected: prompt blocked by moderation',
      );
      return reply.status(400).send({
        error: 'prompt_blocked',
        message: 'Запрос отклонён: он нарушает правила использования сервиса.',
      });
    }

    // SF-8: refuse reference URLs that target a private/internal host or a
    // non-http(s) scheme before they're persisted or forwarded. The server-side
    // dimension probe separately restricts itself to the caller's own storage.
    const unsafeRef = firstUnsafeReferenceUrl(
      input.params,
      input.referenceAssets,
      REFERENCE_ALLOWED_ORIGINS,
    );
    if (unsafeRef !== null) {
      return reply.status(400).send({ error: 'unsafe_reference_url', url: unsafeRef });
    }

    const modelRow = await db.select().from(models).where(eq(models.id, input.modelId)).limit(1);
    const model = modelRow[0];
    if (!model || !model.isActive) {
      return reply.status(400).send({ error: 'model_not_available', modelId: input.modelId });
    }
    if (!isExecutableGenerationKind(model.kind)) {
      return reply.status(400).send({ error: 'model_not_available', modelId: input.modelId });
    }

    if (input.source === 'boards') {
      const validated = validateBoardCompiledGenerationRequest(
        { modelId: input.modelId, prompt: input.prompt, params: input.params },
        model,
      );
      if (!validated.ok) {
        return reply.status(400).send({
          error: 'invalid_board_request',
          message: validated.reason,
          field: validated.field,
        });
      }
      input = { ...input, ...validated.request };
    }

    // Server-side tier gate. The UI already hides higher-tier models, but the
    // gate must live here too — a crafted POST could otherwise run a model the
    // user's plan doesn't include. Tiers are ordered; the user needs at least
    // the model's tierMin.
    //
    // W0: the tier comes from the LIVE subscription row, never from
    // `users_app.tier`. That column is written by nothing but god-mode raw SQL,
    // so gating on it refused 31 of 35 catalogue models to real subscribers; and
    // OR-ing it in would keep the split brain alive, since no cancellation ever
    // resets it. This read replaces the old one — no extra round trip — and
    // sits before the job/credit transaction, so no lock order changes.
    const userTier = await resolveUserPlanTier(db, session.user.id);
    if (!subscriptionTierAllows(userTier, model.tierMin)) {
      return reply.status(403).send({
        error: 'tier_required',
        requiredTier: model.tierMin,
        currentTier: userTier,
        message: `Эта модель доступна на тарифе «${model.tierMin}» и выше.`,
      });
    }

    // AFTER the tier gate on purpose: authorization precedes parameter
    // validation. A user whose plan does not include this model must hear
    // `tier_required`, not that their resolution is missing — otherwise the
    // 403 is unreachable for any video model and we answer a question the
    // caller was never entitled to ask.
    const resolutionError = validateVideoResolution(model, input.params);
    if (resolutionError) {
      return reply.status(400).send({
        error: resolutionError.error,
        message: priceRefusalMessage(resolutionError.error),
      });
    }

    // …and a resolution we do not sell is refused just as plainly (origin/main,
    // `fix(generate): persist job state and resolution`). The two checks are
    // complementary: the one above catches «asked for nothing», this one catches
    // «asked for something we do not carry». Without it a stale client could send
    // 1080p to a 720p-only fast model and the adapter would silently clamp it,
    // delivering less than we billed. Absent/empty capability metadata keeps the
    // legacy provider-default behaviour.
    const declaredResolutions = (model.capabilities as Record<string, unknown> | null)?.[
      'resolutions'
    ];
    const requestedResolution = input.params['resolution'];
    if (
      Array.isArray(declaredResolutions) &&
      declaredResolutions.length > 0 &&
      typeof requestedResolution === 'string' &&
      !declaredResolutions.includes(requestedResolution)
    ) {
      return reply.status(400).send({
        error: 'resolution_not_available',
        modelId: model.id,
        requestedResolution,
        resolutions: declaredResolutions.filter(
          (value): value is string => typeof value === 'string',
        ),
      });
    }

    // O-6: a reference generated by our own image model can exceed a fallback
    // video's pixel ceiling (the observed 6336×2688 → Kie 6000px rejection).
    // Inspect only our own user-prefixed objects, and do it before price/budget
    // work and the credit reservation. A storage read failure fails closed with
    // a retryable 503; unknown image containers are allowed through so this
    // bounded parser cannot become a false rejection for a provider format we
    // do not yet decode.
    const referencePreflight = await preflightReferenceDimensions(
      collectImageReferenceCandidates(input.params, input.referenceAssets),
      referenceMaxDimension(model.capabilities),
      session.user.id,
      referenceProbe,
    );
    if (!referencePreflight.ok) {
      if (referencePreflight.reason === 'unavailable') {
        req.log.warn(
          {
            userId: session.user.id,
            modelId: model.id,
            referenceIndex: referencePreflight.candidate.index,
            detail: referencePreflight.detail,
          },
          'job rejected: reference dimensions unavailable before reservation',
        );
        return reply.status(503).send({
          error: 'reference_dimensions_unavailable',
          referenceIndex: referencePreflight.candidate.index,
          message: 'Не удалось проверить размер референса. Повторите попытку.',
        });
      }
      const { width, height } = referencePreflight.dimensions;
      return reply.status(400).send({
        error: 'reference_dimensions_exceeded',
        referenceIndex: referencePreflight.candidate.index,
        width,
        height,
        maxDimension: referencePreflight.maxDimension,
        message:
          `Референс ${width}×${height} px превышает предел ${referencePreflight.maxDimension} px. ` +
          'Уменьшите изображение или выберите более низкое качество; формат видео менять не нужно.',
      });
    }

    // Parametric charge: resolve the credits for this exact request
    // (model × resolution × videoInput × duration/count). A config we have no
    // usable price for is REFUSED (400 `price_unavailable` / `config_not_available`),
    // never silently charged at the resolution-blind flat rate.
    const requestedReferenceCount = referenceImageCountForPricing(
      input.params,
      input.referenceAssets,
    );
    const pricedReferenceCount = referenceImageCountForPricing(
      input.params,
      input.referenceAssets,
      model.capabilities,
    );
    // REFUSED, not clamped. The clamp was defensible while the reference count only
    // decided whether a per-image surcharge applied — it priced what we could
    // forward, and forwarding fewer than asked was the adapter's business. It stopped
    // being defensible when the count became a price BAND: nothing enforces the cap
    // on the way out (the OpenRouter image serializer forwards up to 14 references,
    // and kie meters every input image past the first at $0.0025), so «price 10, send
    // 20» is a charge for one job and a bill for another. A request we cannot price
    // for what it actually sends is a 400, the same as any other unpriceable config.
    const activePoints = await loadActivePricePoints(model.id, db);
    const capRefusal = referenceCapRefusal(
      requestedReferenceCount,
      model.capabilities,
      activePoints,
    );
    if (capRefusal) {
      return reply.status(400).send({
        error: 'too_many_references',
        message: referenceCapMessage(capRefusal.maxReferenceCount),
        modelId: model.id,
        ...capRefusal,
      });
    }
    if (pricedReferenceCount < requestedReferenceCount) {
      // Over the cap on a model whose price does NOT depend on the count. Nothing is
      // mispriced — the vendor bills per output image — so this stays what it always
      // was: price what the model can use, log that the request asked for more.
      req.log.warn(
        { modelId: model.id, requestedReferenceCount, pricedReferenceCount },
        'reference image count exceeds model cap; pricing only deliverable references',
      );
    }
    const priced = resolveJobPriceFromPoints(
      {
        id: model.id,
        kind: model.kind,
        maxDurationSeconds: model.maxDurationSeconds ?? null,
        minDurationSeconds: minBillableDurationSeconds(model.capabilities),
        capabilities: model.capabilities,
      },
      input.params,
      activePoints,
      pricedReferenceCount,
    );
    if (priced.ok === false) {
      // The stable code AND a human message: the client shows the message rather
      // than mapping every code itself, and stops rendering an optimistic local
      // price for a request we just refused to quote.
      const message = priceRefusalMessage(priced.error);
      return reply.status(400).send({ error: priced.error, ...(message ? { message } : {}) });
    }
    const cost = priced.price.cost;
    // Persisted so the worker settles image jobs at the SAME effective per-image
    // rate we charged. Parametric reference add-ons are included in this value;
    // null is for video only (video settlement uses the full reserved amount).
    const creditUnitCost = priced.price.imageUnitCredits;

    // Quote binding: charge the number the user was shown, or refuse. `/v1/jobs/estimate`
    // and this route share one resolver, so the two agree for an identical request — until
    // the catalogue moves between them, and then the customer sees one price and pays
    // another. The client sends back the quote it displayed; we compare it against the
    // price we just resolved and refuse on any difference. Deliberately NOT a signed
    // token: the resolved price is the only number ever charged, so a forged expectation
    // can only make the request MORE likely to be refused.
    //
    // The comparison itself lives INSIDE the create transaction (below), after the
    // idempotency lock and the existing-job lookup. An idempotency replay must outrank
    // quote freshness — a retry of a submit whose response was lost has to get its job
    // back, not a price argument about a charge that already happened. Checking here
    // instead, even with a pre-query for an existing row, loses the race the lock exists
    // to win: a retry that arrives while the original is still committing sees no row and
    // is refused as stale.
    const quoteIsStale = input.expectedCost !== undefined && input.expectedCost !== cost;

    // Hard per-job spend guard: refuse any single job whose credit cost exceeds
    // the configured ceiling, BEFORE reserving credits or hitting the provider.
    // Set MAX_JOB_CREDITS=0 (or unset) to disable the cap.
    const MAX_JOB_CREDITS = Number(process.env.MAX_JOB_CREDITS ?? 0);
    if (MAX_JOB_CREDITS > 0 && cost > MAX_JOB_CREDITS) {
      req.log.warn(
        { modelId: model.id, cost, cap: MAX_JOB_CREDITS },
        'job rejected: cost exceeds MAX_JOB_CREDITS',
      );
      return reply.status(400).send({
        error: 'cost_cap_exceeded',
        cost,
        cap: MAX_JOB_CREDITS,
        message: `Стоимость ${cost} кр превышает текущий лимит ${MAX_JOB_CREDITS} кр на одну генерацию.`,
      });
    }

    // BL-1: platform-wide daily spend ceiling — refuse new jobs once today's
    // accumulated generation cost would exceed the cap, before any reservation.
    const cap = dailySpendCap();
    let budgetReserved = false;
    if (cap > 0) {
      // M1: reserve the daily budget ATOMICALLY here (Lua conditional INCRBY) so
      // N concurrent jobs can't each pass a read-only check and collectively
      // overshoot the cap. Released below on any path that doesn't create a job.
      const budget = await reserveDailyBudget(redis, cost, cap);
      if (!budget.allowed) {
        req.log.warn(
          { cost, current: budget.current, cap },
          'job rejected: daily spend cap reached',
        );
        return reply.status(503).send({
          error: 'daily_spend_cap_exceeded',
          cap,
          message: 'Платформа достигла дневного лимита генераций. Попробуйте позже.',
        });
      }
      budgetReserved = true;
    }

    let jobCreated = false;
    try {
      const jobId = nid();
      const workflowId = nid();
      // Gateway routing: a slug-shaped providerModelId ('vendor/model', e.g.
      // 'google/veo-3.1-fast') ONLY resolves on OpenRouter — AtlasCloud would throw
      // MODEL_UNAVAILABLE — so force the OpenRouter gateway for those rows
      // regardless of the dev override. There is no global default provider.
      // EXCEPTION: an explicit `model.gatewayOverride` wins first (below), so a
      // slash-id row CAN be pinned elsewhere — e.g. veo/grok carry
      // gatewayOverride='kie' (2026-07-19) and route to kie, not OpenRouter.
      // Seedance/Seedream (no slash) keep honoring the explicit per-job provider.
      // `capabilities.forceGateway` is the same idea for rows that need a
      // specific NON-OpenRouter gateway (e.g. the Nano Banana family →
      // laozhang.ai/kie.ai direct) without an enum migration on `provider`.
      const capForceGateway = (model.capabilities as Record<string, unknown> | null)?.[
        'forceGateway'
      ];
      // model.gatewayOverride (admin manual pin, /admin/models) wins over
      // everything else, including the slug-shaped-OpenRouter inference below —
      // an explicit admin switch must never be silently overridden.
      const forcedGateway =
        model.gatewayOverride ??
        (model.providerModelId.includes('/')
          ? 'openrouter'
          : typeof capForceGateway === 'string'
            ? capForceGateway
            : input.provider);
      const paramsWithPrompt = {
        ...input.params,
        prompt: input.prompt,
        ...(forcedGateway ? { __gateway: forcedGateway } : {}),
      };

      // B4: freeze every model/routing/request fact that the worker may need
      // before the job enters BullMQ. A queued job must execute the thing the
      // customer was quoted, even if an operator edits the live catalogue
      // while it waits. The ledger's `creditUnitCost` remains the settlement
      // lock; this snapshot freezes the provider-facing contract around it.
      const executionSnapshot: ExecutionSnapshot = {
        snapshotVersion: EXECUTION_SNAPSHOT_VERSION,
        model: {
          kind: model.kind,
          provider: model.provider,
          providerModelId: model.providerModelId,
          providerEndpoint: model.providerEndpoint,
          gatewayOverride: model.gatewayOverride,
          fallbackGateway: model.fallbackGateway,
          capabilities: model.capabilities,
          maxDurationSeconds: model.maxDurationSeconds,
          pricing: {
            source: priced.price.source,
            imageUnitCredits: priced.price.imageUnitCredits,
          },
        },
        effectiveGateway: forcedGateway ?? null,
        validatedRequest: {
          prompt: input.prompt,
          params: paramsWithPrompt,
          referenceAssets: input.referenceAssets,
        },
        unitsBreakdown: {
          units: priced.price.units,
          imageUnitCredits: priced.price.imageUnitCredits,
          referenceCount: pricedReferenceCount,
        },
        quotedCredits: cost,
      };

      // Phase 2 shadow only: resolve the v2 entry explicitly from the same
      // request facts that produced `priced`. This log never decides or changes
      // the API/worker gateway path.
      try {
        const shadowResolution =
          typeof input.params['resolution'] === 'string'
            ? input.params['resolution']
            : typeof input.params['quality'] === 'string'
              ? input.params['quality']
              : 'default';
        const shadowMode = priceModeForRequest(
          {
            id: model.id,
            kind: model.kind,
            capabilities: model.capabilities,
          },
          input.params,
          pricedReferenceCount,
        );
        const requestedAudio =
          typeof input.params['generate_audio'] === 'boolean'
            ? input.params['generate_audio']
            : undefined;
        const audioCandidates = [requestedAudio, true, false, undefined].filter(
          (value, index, values): value is boolean | undefined => values.indexOf(value) === index,
        );
        let shadowEntry = null;
        for (const audio of audioCandidates) {
          const entrySelector = {
            modelId: model.id,
            resolution: shadowResolution,
            references: pricedReferenceCount,
            mode: shadowMode,
            ...(audio === undefined ? {} : { audio }),
          };
          shadowEntry = resolveCatalogueEntry(entrySelector);
          if (shadowEntry) break;
        }
        if (!shadowEntry) {
          throw new Error(
            `no v2 catalogue entry for ${model.id}/${shadowResolution}/${shadowMode}/${pricedReferenceCount}`,
          );
        }

        const frameImages = input.params['frameImages'];
        const frames: FrameRole[] = Array.isArray(frameImages)
          ? frameImages.flatMap((frame): FrameRole[] => {
              if (typeof frame !== 'object' || frame === null) return [];
              const role = (frame as { role?: unknown }).role;
              return role === 'first' || role === 'last' ? [role] : [];
            })
          : [];
        const durationValue = input.params['duration_seconds'];
        const durationSeconds =
          typeof durationValue === 'number' && Number.isFinite(durationValue)
            ? durationValue
            : null;
        const healthRows = await readRouteLegHealth(db);
        const healthByIdentity = new Map(healthRows.map((row) => [row.legIdentity, row]));
        const healthNow = new Date();
        emitShadowRoute({
          jobId,
          modelId: model.id,
          entry: shadowEntry,
          request: {
            references: pricedReferenceCount,
            durationSeconds,
            frames,
            audio: input.params['generate_audio'] === true,
            resolution: shadowResolution,
            aspect:
              typeof input.params['aspect_ratio'] === 'string'
                ? input.params['aspect_ratio']
                : null,
            units: priced.price.units,
            revenueRub: shadowEntry.credits * ROUTE_CREDIT_FLOOR_RUB,
            videoReferences: Array.isArray(input.params['videoUrls'])
              ? input.params['videoUrls'].length
              : 0,
            audioReferences: Array.isArray(input.params['audioUrls'])
              ? input.params['audioUrls'].length
              : 0,
            health: (legIdentity) => {
              const row = healthByIdentity.get(legIdentity);
              return routeLegHealthIsHealthy(row, healthNow)
                ? 'healthy'
                : {
                    healthy: false,
                    detail: `three consecutive submit failures for ${legIdentity}`,
                  };
            },
          },
          now: new Date(),
          legacyChoice: realGateway(model as unknown as BreakEvenModel),
          apiForcedGateway: forcedGateway ?? null,
          logger: req.log as unknown as ShadowRouteLogger,
        });
      } catch (err) {
        req.log.warn(
          {
            shadowRouteError: {
              jobId,
              modelId: model.id,
              error: err instanceof Error ? err.message : String(err),
            },
          },
          'route-selection shadow preparation failed',
        );
      }

      type CreateOutcome =
        | { created: true; jobId: string; cost: number }
        // The quote the client bound no longer matches this price, and no job exists
        // under its idempotency key — so there is nothing to replay and nothing to
        // charge. Carried out of the transaction rather than thrown: a rollback is
        // exactly what it wants, and the daily budget release below keys on
        // `jobCreated`, which stays false.
        | { created: false; quoteStale: true }
        | {
            created: false;
            existing: {
              id: string;
              userId: string;
              projectId: string | null;
              status: string;
              modelId: string;
              presetSlug: string | null;
              params: Record<string, unknown>;
              referenceAssets: string[];
            };
          };

      let outcome: CreateOutcome;
      try {
        outcome = await db.transaction(async (tx): Promise<CreateOutcome> => {
          // Serialize the entire read/create decision, not just the unique
          // insert. The old conflict path inserted a workflow, threw a sentinel
          // to roll it back, then looked the job up outside its transaction.
          // Under two simultaneous submits that error path could escape as a
          // 500. One transaction-scoped lock makes the loser read the committed
          // winner and return its job instead.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`jobs:${input.idempotencyKey}`}))`,
          );
          const existingRows = await tx
            .select({
              id: jobs.id,
              userId: jobs.userId,
              projectId: jobs.projectId,
              status: jobs.status,
              modelId: jobs.modelId,
              presetSlug: jobs.presetSlug,
              params: workflows.params,
              referenceAssets: workflows.referenceAssets,
            })
            .from(jobs)
            .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
            .where(eq(jobs.idempotencyKey, input.idempotencyKey))
            .limit(1);
          const existing = existingRows[0];
          if (existing) return { created: false, existing };
          // Nothing to replay — so a bound quote that no longer matches is refused here,
          // before the workflow row is written or a single credit is reserved.
          if (quoteIsStale) return { created: false, quoteStale: true };

          await tx.insert(workflows).values({
            id: workflowId,
            userId: session.user.id,
            modelId: model.id,
            params: paramsWithPrompt,
            referenceAssets: input.referenceAssets,
          });
          const inserted = await tx
            .insert(jobs)
            .values({
              id: jobId,
              userId: session.user.id,
              workflowId,
              modelId: model.id,
              projectId: input.projectId ?? null,
              presetSlug: input.presetSlug ?? null,
              status: 'queued',
              creditsReserved: cost,
              creditUnitCost,
              executionSnapshot,
              idempotencyKey: input.idempotencyKey,
            })
            .onConflictDoNothing({ target: jobs.idempotencyKey })
            .returning({ id: jobs.id });

          if (inserted.length === 0) {
            // The lock covers current writers. This fallback also preserves the
            // invariant during a rolling deploy with an older writer: remove
            // this attempt's unreferenced workflow and replay the winner.
            await tx.delete(workflows).where(eq(workflows.id, workflowId));
            const racedRows = await tx
              .select({
                id: jobs.id,
                userId: jobs.userId,
                projectId: jobs.projectId,
                status: jobs.status,
                modelId: jobs.modelId,
                presetSlug: jobs.presetSlug,
                params: workflows.params,
                referenceAssets: workflows.referenceAssets,
              })
              .from(jobs)
              .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
              .where(eq(jobs.idempotencyKey, input.idempotencyKey))
              .limit(1);
            const raced = racedRows[0];
            if (!raced) throw new Error('idempotency conflict without a persisted job');
            return { created: false, existing: raced };
          }

          await credits.reserve({
            userId: session.user.id,
            jobId,
            amount: cost,
            reason: 'job.reserve',
            idempotencyKey: `job:${jobId}:reserve`,
            tx,
          });
          // Persist the correlation id so the worker can re-emit it in its own
          // pino bindings — one grep traces web→api→worker→ledger.
          await enqueueViaOutbox({
            tx,
            queueName: JOB_RUN_QUEUE,
            payload: { jobId, _reqId: req.id },
            jobId: `run-${jobId}`,
          });
          return { created: true, jobId, cost };
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return reply.status(402).send({
            error: 'insufficient_credits',
            available: err.available,
            required: err.requested,
          });
        }
        req.log.error({ err }, 'POST /v1/jobs failed');
        return reply.status(500).send({ error: 'internal' });
      }

      if (!outcome.created) {
        if ('quoteStale' in outcome) {
          req.log.warn(
            { userId: session.user.id, modelId: model.id, expected: input.expectedCost, cost },
            'job rejected: quote is stale',
          );
          // 409 and not 400 — nothing about the request is invalid, it is the price that
          // is no longer the quoted one. The fresh number rides along so the surface can
          // show it instead of asking the user to guess what changed.
          return reply.status(409).send({
            error: 'quote_stale',
            cost,
            expectedCost: input.expectedCost,
            message: `Цена изменилась: ${cost} кр вместо ${input.expectedCost} кр. Проверьте и запустите снова.`,
          });
        }
        if (outcome.existing.userId !== session.user.id) {
          return reply.status(409).send({ error: 'idempotency_key_in_use' });
        }
        if (outcome.existing.projectId !== (input.projectId ?? null)) {
          return reply.status(409).send({ error: 'idempotency_project_mismatch' });
        }
        if (
          outcome.existing.modelId !== model.id ||
          outcome.existing.presetSlug !== (input.presetSlug ?? null) ||
          !isDeepStrictEqual(outcome.existing.params, paramsWithPrompt) ||
          !isDeepStrictEqual(outcome.existing.referenceAssets, input.referenceAssets)
        ) {
          return reply.status(409).send({ error: 'idempotency_request_mismatch' });
        }
        return { jobId: outcome.existing.id, status: outcome.existing.status };
      }

      // M1: budget was already reserved atomically at the gate — mark the job
      // created so the finally below keeps (rather than releases) the reservation.
      jobCreated = true;
      return reply.status(201).send({
        jobId: outcome.jobId,
        status: 'queued',
        creditsReserved: outcome.cost,
        ...(input.source === 'boards'
          ? {
              normalizedRequest: {
                modelId: input.modelId,
                prompt: input.prompt,
                params: input.params,
              },
            }
          : {}),
      });
    } finally {
      // Release the reserved daily budget on every non-created path (idempotency
      // hit, insufficient credits, validation/internal error) so only genuine new
      // spend stays counted toward the cap.
      if (budgetReserved && !jobCreated) await releaseDailyBudget(redis, cost);
    }
  });

  // Cost-aware tiering (product-AI): a read-only price preview — same inputs as
  // POST /v1/jobs but NO reservation, NO provider call, NO side effects. Returns
  // the cost, affordability, whether the daily cap would block, and cheaper
  // same-kind models the user's tier allows (cheap-iterate / expensive-finalize).
  app.post('/v1/jobs/estimate', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = generationJobEstimateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    let input = parsed.data;

    // DoD 6 (log-first): mirror the submit-path off-contract-key log on estimate, so
    // the SAME normalize+validate signal covers both endpoints. LOG ONLY.
    const estimateOffContract = unknownGenerationParamKeys(input.params);
    if (estimateOffContract.length > 0) {
      req.log.warn(
        {
          userId: session.user.id,
          modelId: input.modelId,
          offContractKeys: estimateOffContract.slice(0, 20).map((k) => k.slice(0, 64)),
        },
        'generation params carry off-contract keys (DoD 6 log-first — not rejected)',
      );
    }

    // SF-8: estimate is a public, authenticated HTTP boundary too. Validate
    // every reference before the O-6 probe can perform any server-side read;
    // otherwise an attacker could use the read-only quote endpoint as an SSRF
    // oracle even though submit rejects the same URL.
    const unsafeRef = firstUnsafeReferenceUrl(
      input.params,
      input.referenceAssets,
      REFERENCE_ALLOWED_ORIGINS,
    );
    if (unsafeRef !== null) {
      return reply.status(400).send({ error: 'unsafe_reference_url', url: unsafeRef });
    }

    const modelRow = await db.select().from(models).where(eq(models.id, input.modelId)).limit(1);
    const model = modelRow[0];
    if (!model || !model.isActive) {
      return reply.status(400).send({ error: 'model_not_available', modelId: input.modelId });
    }
    if (!isExecutableGenerationKind(model.kind)) {
      return reply.status(400).send({ error: 'model_not_available', modelId: input.modelId });
    }
    const resolutionError = validateVideoResolution(model, input.params);
    if (resolutionError) {
      return reply.status(400).send({
        error: resolutionError.error,
        message: priceRefusalMessage(resolutionError.error),
      });
    }
    if (input.source === 'boards') {
      const validated = validateBoardCompiledGenerationRequest(
        { modelId: input.modelId, prompt: input.prompt, params: input.params },
        model,
      );
      if (!validated.ok) {
        return reply.status(400).send({
          error: 'invalid_board_request',
          message: validated.reason,
          field: validated.field,
        });
      }
      input = { ...input, ...validated.request };
    }
    // Keep quote and submit aligned: an undeclared resolution is rejected at
    // the API boundary, before the price resolver. It is a capability error,
    // not merely an absent price configuration.
    const declaredResolutions = (model.capabilities as Record<string, unknown> | null)?.[
      'resolutions'
    ];
    const requestedResolution = input.params['resolution'];
    if (
      Array.isArray(declaredResolutions) &&
      declaredResolutions.length > 0 &&
      typeof requestedResolution === 'string' &&
      !declaredResolutions.includes(requestedResolution)
    ) {
      return reply.status(400).send({
        error: 'resolution_not_available',
        modelId: model.id,
        requestedResolution,
        resolutions: declaredResolutions.filter(
          (value): value is string => typeof value === 'string',
        ),
      });
    }

    // Keep estimate and submit aligned on the same pre-reservation reference
    // contract. Estimates have no side effects, but refusing an over-sized own
    // reference only at submit would still show a misleading quote.
    const referencePreflight = await preflightReferenceDimensions(
      collectImageReferenceCandidates(input.params, input.referenceAssets),
      referenceMaxDimension(model.capabilities),
      session.user.id,
      referenceProbe,
    );
    if (!referencePreflight.ok) {
      if (referencePreflight.reason === 'unavailable') {
        return reply.status(503).send({
          error: 'reference_dimensions_unavailable',
          referenceIndex: referencePreflight.candidate.index,
          message: 'Не удалось проверить размер референса. Повторите попытку.',
        });
      }
      const { width, height } = referencePreflight.dimensions;
      return reply.status(400).send({
        error: 'reference_dimensions_exceeded',
        referenceIndex: referencePreflight.candidate.index,
        width,
        height,
        maxDimension: referencePreflight.maxDimension,
        message:
          `Референс ${width}×${height} px превышает предел ${referencePreflight.maxDimension} px. ` +
          'Уменьшите изображение или выберите более низкое качество; формат видео менять не нужно.',
      });
    }
    // Parametric estimate — the SAME resolver POST /v1/jobs charges with, so the
    // quoted cost equals the reserved cost for an identical request.
    const requestedReferenceCount = referenceImageCountForPricing(
      input.params,
      input.referenceAssets,
    );
    // References that do not exist YET but will by submit time — a board quote is
    // taken before the graph runs, so a shot fed by an unrendered upstream is one
    // reference short of what it will actually send. Counted here, and clamped to
    // the model's cap like any other reference, so the quote matches the submit once
    // the reference COUNT is a price dimension. Estimate only: at submit the
    // references are real and countable, and trusting a caller's number there would
    // be a way to buy a cheaper band.
    const pricedReferenceCount = clampReferenceCountToModel(
      referenceImageCountForPricing(input.params, input.referenceAssets, model.capabilities) +
        (input.pendingReferenceCount ?? 0),
      model.capabilities,
    );
    // The SAME refusal as the submit path, on the SAME number: the count the submit
    // will carry, pending references included. Testing the cap against the references
    // that exist TODAY would quote a board shot whose own submit is then refused.
    const activePoints = await loadActivePricePoints(model.id, db);
    const effectiveReferenceCount = requestedReferenceCount + (input.pendingReferenceCount ?? 0);
    const capRefusal = referenceCapRefusal(
      effectiveReferenceCount,
      model.capabilities,
      activePoints,
    );
    if (capRefusal) {
      return reply.status(400).send({
        error: 'too_many_references',
        message: referenceCapMessage(capRefusal.maxReferenceCount),
        modelId: model.id,
        ...capRefusal,
      });
    }
    const priced = resolveJobPriceFromPoints(
      {
        id: model.id,
        kind: model.kind,
        maxDurationSeconds: model.maxDurationSeconds ?? null,
        minDurationSeconds: minBillableDurationSeconds(model.capabilities),
        capabilities: model.capabilities,
      },
      input.params,
      activePoints,
      pricedReferenceCount,
    );
    if (priced.ok === false) {
      const message = priceRefusalMessage(priced.error);
      return reply.status(400).send({ error: priced.error, ...(message ? { message } : {}) });
    }
    const cost = priced.price.cost;
    const units = priced.price.units;

    // Same source as the gate above, deliberately: an estimate that judged the
    // tier differently could suggest a "cheaper model your tier allows" that
    // POST /v1/jobs then refuses.
    const userTier = await resolveUserPlanTier(db, session.user.id);
    const tierAllows = (tierMin: string) => subscriptionTierAllows(userTier, tierMin);

    const balance = await credits.balanceFor(session.user.id);
    const cap = dailySpendCap();
    const daily =
      cap > 0 ? await checkDailyBudget(redis, cost, cap) : { allowed: true, current: 0, cap: 0 };

    // Cheaper active models of the same kind, priced for the same request, that the
    // user's tier already permits — sorted cheapest first, top 3.
    const sameKind = await db
      .select()
      .from(models)
      .where(and(eq(models.isActive, true), eq(models.kind, model.kind)));
    const candidates = sameKind.filter((m) => m.id !== model.id && tierAllows(m.tierMin));
    // Batch-load every candidate's active price points in one query, then price
    // each parametrically (same resolver as the charge) with no per-model query.
    const pointsByModel = await loadActivePricePointsByModel(candidates.map((m) => m.id));
    const alternatives = candidates
      .map((m) => {
        const candidateRequest =
          input.source === 'boards'
            ? validateBoardCompiledGenerationRequest(
                { modelId: m.id, prompt: input.prompt, params: input.params },
                m,
              )
            : null;
        if (candidateRequest && !candidateRequest.ok) return null;
        const candidateParams = candidateRequest?.ok
          ? candidateRequest.request.params
          : input.params;
        const mPriced = resolveJobPriceFromPoints(
          {
            id: m.id,
            kind: m.kind,
            maxDurationSeconds: m.maxDurationSeconds ?? null,
            minDurationSeconds: minBillableDurationSeconds(m.capabilities),
            capabilities: m.capabilities,
          },
          candidateParams,
          pointsByModel.get(m.id) ?? [],
          referenceImageCountForPricing(candidateParams, input.referenceAssets, m.capabilities),
        );
        if (!mPriced.ok) return null;
        return {
          modelId: m.id,
          family: m.family,
          variant: m.variant,
          cost: mPriced.price.cost,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null && a.cost < cost)
      .sort((a, b) => a.cost - b.cost)
      .slice(0, 3)
      .map((a) => ({ ...a, savings: cost - a.cost }));

    return {
      modelId: model.id,
      units,
      unitKind: model.unitKind,
      cost,
      requiredTier: model.tierMin,
      tierAllowed: tierAllows(model.tierMin),
      balanceAvailable: balance.available,
      affordable: balance.available >= cost,
      dailyCapWouldBlock: !daily.allowed,
      alternatives,
      ...(input.source === 'boards'
        ? {
            normalizedRequest: {
              modelId: input.modelId,
              prompt: input.prompt,
              params: input.params,
            },
          }
        : {}),
    };
  });

  app.get<{ Querystring: { limit?: string; cursor?: string; status?: string } }>(
    '/v1/jobs',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const limit = req.query.limit
        ? Math.max(1, Math.min(100, Number(req.query.limit) || 24))
        : 24;
      const opts: Parameters<typeof listJobsForUser>[1] = { limit };
      if (req.query.cursor) opts.cursor = req.query.cursor;
      if (req.query.status) {
        const statuses = req.query.status.split(',').map((s) => s.trim());
        if (!statuses.every(isJobStatus)) {
          return reply.status(400).send({ error: 'invalid_status' });
        }
        opts.status = statuses as JobStatus[];
      }
      return listJobsForUser(session.user.id, opts);
    },
  );

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const job = await getJobForUser(req.params.id, session.user.id);
    if (!job) return reply.status(404).send({ error: 'not_found' });
    return job;
  });
}
