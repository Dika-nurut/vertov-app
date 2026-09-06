import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Dispatcher } from 'undici';
import { egressDispatcher } from './egress-fetch';
import { z } from 'zod';
import {
  account as authAccount,
  assistTierStates,
  auditLog,
  creditBuckets,
  creditFloorRub,
  creditTransactions,
  costCatalogue,
  db,
  GATEWAY_FX_RUB,
  galleryItems,
  hasPaidMediaStorage,
  jobs,
  lockMediaStorageUser,
  marketingAttribution,
  matchesPricePointSeed,
  mediaExpiresAt,
  modelBreakEven,
  modelPricePoints,
  models,
  nid,
  orders,
  pricePointBreakEven,
  readConservativeCreditFloorRub,
  subscriptions,
  subscriptionsCatalog,
  usersApp,
  usersPii,
} from '@seed/db';
import {
  APP_FLAG_DEFAULTS,
  creditService,
  IdempotencyKeyConflictError,
  readBoolFlag,
  writeBoolFlag,
} from '@seed/credits';
import {
  ASSIST_TIERS,
  assistTier,
  KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK,
  KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK,
} from '@seed/shared';
import {
  assistTierState,
  assistTierStatesView,
  invalidateAssistTierStates,
} from './assist-tier-state';
import { isAdminUser } from './admin';
import { KIE_CLAUDE_PRIMARY_MODEL, KIE_PRIMARY_MODEL, kieChatRoute } from './kie-chat';
import { findLiveBillingIntent } from './billing-intent';
import { evaluatePricePointActivation } from './pricing-activation-gate';
import { gatewayArmingFromEnv } from '@seed/shared';
import { inspectGatewayChange, type GatewayMarginIssue } from './gateway-margin-gate';
import { findLifecycleSubscription } from './subscriptions';

/** App-settings flags the admin panel can read + toggle, with ships-as defaults. */
const KNOWN_FLAGS: Record<string, boolean> = {
  ...APP_FLAG_DEFAULTS,
};

const activeBillingProvider = (process.env.BILLING_PROVIDER ?? 'yookassa').toLowerCase();

/**
 * Admin panel — read-only analytics + a few audited write paths.
 * Plan: research/archive/admin-panel-plan-2026-07.md. Every route is gated by the same
 * `ADMIN_USER_IDS` env allowlist as the gallery-takedown route (see admin.ts);
 * the audit_log records the acting admin's userId per write so it stays meaningful
 * if/when a real role table replaces the allowlist.
 */

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

function legacyAdminGrantKey(input: {
  adminUserId: string;
  targetUserId: string;
  amount: number;
  reason: string;
  account: 'refund' | 'pack_grant';
}): string {
  const canonical = JSON.stringify(input);
  return `legacy:admin:grant:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * Landed USD→RUB rates by payment channel — the vendor bill is settled in USD on
 * one of two channels and the effective RUB cost differs. Values are the
 * finance-frozen ladder rates, READ from the export rather than copied out of it.
 *
 * They had been copied once and not moved when v14 re-based the landed pair
 * (95.5567/90.5751 → 106.182/100.6315), so this panel divided the same vendor bill
 * by a retired basis and reported a margin ~11 points too flattering — on the one
 * screen an operator uses to decide whether a model is worth selling. A copied
 * constant is a copy until the day the source changes; then it is a lie.
 *
 * There is deliberately NO env override any more. A retunable FX means an operator
 * can make every displayed margin fiction without touching a price, which is the
 * same class of defect as pricing a job on the leg that did not serve it.
 */
const DIRECT_USD_TO_RUB = GATEWAY_FX_RUB.direct;
const OR_USD_TO_RUB = GATEWAY_FX_RUB.openrouter;
const DAY_MS = 86_400_000;
const SUBSCRIPTION_CYCLE_MS = 30 * DAY_MS;

// Provider-balance cache. Without it, every /admin (Кокпит) load hits each provider's
// balance API — which spooked Laozhang into a "new access" alert. 2-min TTL means at
// most one poll per provider per 2 min regardless of how often the panel is opened.
const BALANCE_TTL_MS = 120_000;
let balanceCache: { at: number; body: unknown } | null = null;

function windowDays(raw: unknown, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(365, Math.floor(n)));
}

/** Cheapest ₽-per-credit across every tier = the conservative revenue floor,
 * including inactive legacy plans whose credits remain spendable. One shared
 * derivation (`@seed/db`) so this panel, the margin guards and the official-leg
 * budget cannot disagree about what a credit is worth. */
const creditRubFloor = readConservativeCreditFloorRub;

export function setupAdminPanelRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  /** Resolve a session AND enforce admin. Returns the session or null (reply already sent). */
  async function requireAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ user: { id: string } } | null> {
    const session = await requireSession(req, reply);
    if (!session) return null;
    if (!isAdminUser(session.user.id)) {
      reply.status(403).send({ error: 'forbidden' });
      return null;
    }
    return session;
  }

  // --- Phase 0: identity probe (used by the web /admin layout guard) ---
  // Does NOT 403 — it reports admin-ness so the layout can 404 unknown users itself.
  app.get('/v1/admin/me', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    return { userId: session.user.id, isAdmin: isAdminUser(session.user.id) };
  });

  // --- Feature flags / kill-switches (app_settings; audited write path) ---
  app.get('/v1/admin/settings', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const flags: Record<string, boolean> = {};
    for (const [key, def] of Object.entries(KNOWN_FLAGS)) {
      flags[key] = await readBoolFlag(key, def);
    }
    return { flags };
  });

  const settingsPatchSchema = z.object({
    key: z.enum(Object.keys(KNOWN_FLAGS) as [string, ...string[]]),
    value: z.boolean(),
  });

  app.patch('/v1/admin/settings', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const before = await readBoolFlag(parsed.data.key, KNOWN_FLAGS[parsed.data.key]!);
    await writeBoolFlag(parsed.data.key, parsed.data.value, session.user.id);
    await db.insert(auditLog).values({
      id: nid(),
      userId: session.user.id,
      action: 'admin.setting_update',
      payload: { key: parsed.data.key, before, after: parsed.data.value },
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    return { ok: true, key: parsed.data.key, value: parsed.data.value };
  });

  // --- Phase 1: business cockpit + margin ---
  app.get<{ Querystring: { days?: string } }>('/v1/admin/cockpit', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = windowDays(req.query.days);
    const since = new Date(Date.now() - days * DAY_MS);

    // Revenue is provider-agnostic; the label below reflects the active
    // acquiring integration rather than a retired YooKassa-only assumption.
    const [rev] = await db
      .select({
        grossRub: sql<number>`coalesce(sum(${orders.amountRub}) filter (where ${orders.ourStatus} = 'paid' and ${orders.paidAt} >= ${since}), 0)`,
        orderCount: sql<number>`count(*) filter (where ${orders.ourStatus} = 'paid' and ${orders.paidAt} >= ${since})`,
        refundedRub: sql<number>`coalesce(sum(${orders.amountRub}) filter (where ${orders.ourStatus} = 'refunded' and ${orders.refundedAt} >= ${since}), 0)`,
        grossRubAllTime: sql<number>`coalesce(sum(${orders.amountRub}) filter (where ${orders.ourStatus} = 'paid'), 0)`,
      })
      .from(orders);

    // Subscriptions: MRR = recurring revenue, so it sums ONLY paying ('active') subs;
    // trials contribute 0 until they convert. The subscriber count still includes
    // trialing (they are live subscriptions), so count and revenue are reported honestly
    // side by side rather than trials inflating MRR at their snapshot price.
    const byTier = await db
      .select({
        tier: subscriptions.tier,
        count: sql<number>`count(*)`,
        trialing: sql<number>`count(*) filter (where ${subscriptions.status} = 'trialing')`,
        mrrRub: sql<number>`coalesce(sum(${subscriptions.priceRub}) filter (where ${subscriptions.status} = 'active'), 0)`,
      })
      .from(subscriptions)
      .where(inArray(subscriptions.status, ['active', 'trialing']))
      .groupBy(subscriptions.tier);
    const mrrRub = byTier.reduce((s, r) => s + Number(r.mrrRub), 0);
    const activeCount = byTier.reduce((s, r) => s + Number(r.count), 0);
    const trialingCount = byTier.reduce((s, r) => s + Number(r.trialing), 0);

    // Churn (approximate): subs that ended (canceled/expired) with a period end in
    // the window, over (still-active + churned). Labelled approximate — no per-status
    // history table exists.
    const [churnRow] = await db
      .select({
        churned: sql<number>`count(*) filter (where ${subscriptions.status} in ('canceled','expired') and ${subscriptions.currentPeriodEnd} >= ${since})`,
      })
      .from(subscriptions);
    const churned = Number(churnRow?.churned ?? 0);
    const churnBase = activeCount + churned;

    // Margin: per-model and blended. Historical job analytics keep their
    // persisted-unit limitation, but any rate used for a computable group must
    // come from the signed workbook leg, never a model capability scalar.
    //
    // Two independent reasons a group has no COGS, both reported as unknown
    // rather than guessed:
    //  1. Only jobs with a persisted reserve-time unit cost can recover billed
    //     units. Legacy rows, including existing video rows, have no durable unit
    //     count; do not reverse-derive one from the mutable catalogue rate.
    //  2. The leg/rung is not present in the signed workbook. Such a group counts
    //     as UNKNOWN — visibly, in `costUnknown`, not by quietly vanishing from
    //     the totals.
    const creditRub = await creditRubFloor();
    const modelRows = await db
      .select({
        modelId: jobs.modelId,
        modelFamily: models.family,
        modelVariant: models.variant,
        modelDisplayName: models.displayName,
        kind: models.kind,
        gatewayUsed: jobs.gatewayUsed,
        fallbackDepth: jobs.fallbackDepth,
        jobCount: sql<number>`count(*)`,
        creditsSpent: sql<number>`coalesce(sum(${jobs.creditsSpent}), 0)`,
      })
      .from(jobs)
      .innerJoin(models, eq(models.id, jobs.modelId))
      .where(and(eq(jobs.status, 'succeeded'), gte(jobs.finishedAt, since)))
      .groupBy(
        jobs.modelId,
        models.family,
        models.variant,
        models.displayName,
        models.kind,
        jobs.gatewayUsed,
        jobs.fallbackDepth,
      );

    let blendedRevenue = 0;
    let blendedCost = 0;
    let blendedApproximate = false;
    let blendedUnknownJobs = 0;
    // Fold the (model × serving leg × depth) groups into one row per model.
    // The exact sold rung is not present on every historical job, so groups
    // without durable rung provenance remain unknown rather than being priced
    // from a model-wide scalar.
    const byModel = new Map<
      string,
      {
        model: { family: string; variant: string; displayName: string | null };
        kind: string;
        jobs: number;
        creditsSpent: number;
        /** Credits from groups we CAN price — the honest margin denominator. */
        pricedCreditsSpent: number;
        costRub: number | null;
        unknownJobs: number;
        unknownLegs: Set<string>;
      }
    >();
    for (const r of modelRows) {
      const creditsSpent = Number(r.creditsSpent);
      // The legacy aggregation has no sold-rung/mode/reference columns, so it
      // cannot safely resolve an exact workbook entry. Keep this conservative:
      // only a future job record with durable rung provenance may be reintroduced
      // into this report. Existing rows are explicitly UNKNOWN.
      const groupCost = null;
      const acc = byModel.get(r.modelId) ?? {
        model: {
          family: r.modelFamily,
          variant: r.modelVariant,
          displayName: r.modelDisplayName,
        },
        kind: r.kind,
        jobs: 0,
        creditsSpent: 0,
        pricedCreditsSpent: 0,
        costRub: null as number | null,
        unknownJobs: 0,
        unknownLegs: new Set<string>(),
      };
      acc.jobs += Number(r.jobCount);
      acc.creditsSpent += creditsSpent;
      if (groupCost != null) {
        acc.costRub = (acc.costRub ?? 0) + groupCost;
        acc.pricedCreditsSpent += creditsSpent;
      } else {
        acc.unknownJobs += Number(r.jobCount);
        acc.unknownLegs.add(`${r.gatewayUsed ?? 'unknown'}@${r.fallbackDepth ?? 'unknown'}`);
      }
      byModel.set(r.modelId, acc);
    }

    const perModel = [...byModel.entries()].map(([modelId, r]) => {
      const revenueRub = r.creditsSpent * creditRub;
      // Margin compares like with like: the cost we HAVE against the revenue of
      // the jobs it covers. Dividing a partial cost by the full revenue would
      // report an unpriced leg as free margin — the exact blindness being fixed.
      const pricedRevenueRub = r.pricedCreditsSpent * creditRub;
      const costRub = r.costRub;
      const marginPct =
        costRub == null || pricedRevenueRub === 0 ? null : 1 - costRub / pricedRevenueRub;
      if (costRub != null) {
        blendedRevenue += pricedRevenueRub;
        blendedCost += costRub;
      }
      blendedUnknownJobs += r.unknownJobs;
      // Existing jobs do not persist the complete workbook configuration, so
      // their row remains explicitly marked approximate/unknown.
      const approximate = r.kind === 'video';
      if (costRub != null && approximate) blendedApproximate = true;
      return {
        modelId,
        model: r.model,
        kind: r.kind,
        jobs: r.jobs,
        creditsSpent: r.creditsSpent,
        revenueRub: Math.round(revenueRub),
        costRub: costRub == null ? null : Math.round(costRub),
        marginPct,
        priced: costRub != null,
        approximate,
        // Jobs whose serving leg carries no rate we can cite. Surfaced (never
        // folded into the priced totals) so an expensive leg reads as a gap
        // instead of as margin.
        costUnknown: {
          jobs: r.unknownJobs,
          revenueRub: Math.round(revenueRub - pricedRevenueRub),
          legs: [...r.unknownLegs].sort(),
        },
      };
    });
    perModel.sort((a, b) => b.revenueRub - a.revenueRub);

    return {
      window: { days, since: since.toISOString() },
      revenue: {
        psp: activeBillingProvider,
        note:
          activeBillingProvider === 'tochka'
            ? 'Точка Банк — интернет-эквайринг с оплатой картой и через СБП.'
            : 'ЮKassa — активный платёжный провайдер текущего окружения.',
        grossRub: Number(rev?.grossRub ?? 0),
        grossRubAllTime: Number(rev?.grossRubAllTime ?? 0),
        refundedRub: Number(rev?.refundedRub ?? 0),
        orderCount: Number(rev?.orderCount ?? 0),
        sbpSplit: null,
      },
      subscriptions: {
        mrrRub,
        arrRub: mrrRub * 12,
        activeCount,
        trialingCount,
        byTier: byTier.map((r) => ({
          tier: r.tier,
          count: Number(r.count),
          mrrRub: Number(r.mrrRub),
        })),
        churn: {
          approximate: true,
          churned,
          base: churnBase,
          ratePct: churnBase > 0 ? churned / churnBase : 0,
        },
      },
      margin: {
        creditRubValue: creditRub,
        usdToRub: { direct: DIRECT_USD_TO_RUB, openrouter: OR_USD_TO_RUB },
        blended: {
          // Revenue here is the PRICED subset's revenue, so the ratio is honest;
          // the jobs left out are counted in costUnknownJobs.
          revenueRub: Math.round(blendedRevenue),
          costRub: Math.round(blendedCost),
          marginPct: blendedRevenue > 0 ? 1 - blendedCost / blendedRevenue : null,
          approximate: blendedApproximate,
          costUnknownJobs: blendedUnknownJobs,
        },
        perModel,
      },
    };
  });

  // --- Phase 2: product / generation analytics ---
  app.get<{ Querystring: { days?: string } }>('/v1/admin/generation', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = windowDays(req.query.days, 14);
    const since = new Date(Date.now() - days * DAY_MS);

    // Jobs/day by kind.
    const daily = await db
      .select({
        day: sql<string>`to_char(date_trunc('day', ${jobs.queuedAt}), 'YYYY-MM-DD')`,
        kind: models.kind,
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${jobs.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')`,
      })
      .from(jobs)
      .innerJoin(models, eq(models.id, jobs.modelId))
      .where(gte(jobs.queuedAt, since))
      .groupBy(sql`date_trunc('day', ${jobs.queuedAt})`, models.kind)
      .orderBy(sql`date_trunc('day', ${jobs.queuedAt})`);

    // Success/fail rate by kind.
    const rateRows = await db
      .select({
        kind: models.kind,
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${jobs.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')`,
        refunded: sql<number>`count(*) filter (where ${jobs.status} = 'refunded')`,
      })
      .from(jobs)
      .innerJoin(models, eq(models.id, jobs.modelId))
      .where(gte(jobs.queuedAt, since))
      .groupBy(models.kind);

    // Latency: measured p50/p95 (ms) vs each model's declared expectation.
    const latency = await db
      .select({
        modelId: jobs.modelId,
        modelFamily: models.family,
        modelVariant: models.variant,
        modelDisplayName: models.displayName,
        kind: models.kind,
        samples: sql<number>`count(*)`,
        p50Ms: sql<number>`percentile_cont(0.5) within group (order by extract(epoch from (${jobs.finishedAt} - ${jobs.startedAt})) * 1000)`,
        p95Ms: sql<number>`percentile_cont(0.95) within group (order by extract(epoch from (${jobs.finishedAt} - ${jobs.startedAt})) * 1000)`,
        expectedP50Ms: models.expectedLatencyMsP50,
        expectedP95Ms: models.expectedLatencyMsP95,
      })
      .from(jobs)
      .innerJoin(models, eq(models.id, jobs.modelId))
      .where(
        and(
          eq(jobs.status, 'succeeded'),
          gte(jobs.queuedAt, since),
          sql`${jobs.startedAt} is not null and ${jobs.finishedAt} is not null`,
        ),
      )
      .groupBy(
        jobs.modelId,
        models.family,
        models.variant,
        models.displayName,
        models.kind,
        models.expectedLatencyMsP50,
        models.expectedLatencyMsP95,
      )
      .orderBy(desc(sql`count(*)`));

    // jobs.used_fallback (added alongside models.fallback_gateway) closes the gap
    // noted below — tally real per-job fallback triggers, not just "the mechanism exists".
    const [fallbackTotals] = await db
      .select({
        total: sql<number>`count(*)`,
        fellBack: sql<number>`count(*) filter (where ${jobs.usedFallback})`,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'succeeded'), gte(jobs.queuedAt, since)));

    return {
      window: { days, since: since.toISOString() },
      daily: daily.map((r) => ({
        day: r.day,
        kind: r.kind,
        total: Number(r.total),
        succeeded: Number(r.succeeded),
        failed: Number(r.failed),
      })),
      successRate: rateRows.map((r) => {
        const total = Number(r.total);
        return {
          kind: r.kind,
          total,
          succeeded: Number(r.succeeded),
          failed: Number(r.failed),
          refunded: Number(r.refunded),
          successPct: total > 0 ? Number(r.succeeded) / total : null,
        };
      }),
      latency: latency.map((r) => ({
        modelId: r.modelId,
        model: {
          family: r.modelFamily,
          variant: r.modelVariant,
          displayName: r.modelDisplayName,
        },
        kind: r.kind,
        samples: Number(r.samples),
        p50Ms: r.p50Ms == null ? null : Math.round(Number(r.p50Ms)),
        p95Ms: r.p95Ms == null ? null : Math.round(Number(r.p95Ms)),
        expectedP50Ms: r.expectedP50Ms,
        expectedP95Ms: r.expectedP95Ms,
      })),
      // Not fakeable from current data — flagged rather than invented (see plan §gaps).
      presetLeaderboard: {
        available: false,
        reason:
          'No preset reference is persisted on jobs/workflows — instrumentation needed before this can be built.',
      },
      fallback: {
        available: true,
        total: Number(fallbackTotals?.total ?? 0),
        fellBack: Number(fallbackTotals?.fellBack ?? 0),
        reason:
          'Автофолбэк доступен для ЛЮБОЙ модели: при ошибке основного шлюза задача автоматически повторяется на резервном (models.fallback_gateway, настраивается в /admin/models). Счётчик — по jobs.used_fallback за окно: это ЛЮБОЙ переход на запасную ногу, включая внутренние ноги цепочек (исторические цепочки: laozhang → kie → official OpenRouter для Nano Banana, kie → AtlasCloud для Gemini Omni), которые раньше не считались.',
      },
    };
  });

  // --- Provider prepaid balances (live fetch from each provider's own API) ---
  // A drained prepaid balance fails jobs (credits auto-refund) silently, so surface
  // it. OpenRouter + Kie + Laozhang + AtlasCloud expose balance APIs (verified).
  // Laozhang uses a separate system AccessToken (LAOZHANG_ACCESS_TOKEN) and its own
  // /api/user/self.
  app.get<{ Querystring: { fresh?: string } }>(
    '/v1/admin/provider-balances',
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      // Serve from cache unless it's stale or ?fresh=1 — keeps provider polling to
      // ~once/2min (was: once per page load → triggered Laozhang access alerts).
      if (!req.query.fresh && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
        return {
          ...(balanceCache.body as object),
          cachedAgeSec: Math.round((Date.now() - balanceCache.at) / 1000),
        };
      }
      const env = process.env;
      // `auth` is the full Authorization header value (providers differ: some want
      // `Bearer <key>`, Laozhang wants the raw system token).
      const egress = egressDispatcher(env);
      async function timedJson(url: string, auth: string, ms = 6000): Promise<any> {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ms);
        try {
          const r = await fetch(url, {
            headers: { Authorization: auth, Accept: 'application/json' },
            signal: c.signal,
            // Route through the egress proxy when configured (undefined = direct).
            ...(egress ? { dispatcher: egress } : {}),
          } as RequestInit & { dispatcher?: Dispatcher });
          const text = await r.text();
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
          return JSON.parse(text);
        } finally {
          clearTimeout(t);
        }
      }
      const isLive = (mode: string | undefined) => (mode ?? 'live') === 'live';
      const tasks: Array<Promise<Record<string, unknown>>> = [];

      if (env.OPENROUTER_API_KEY && isLive(env.OPENROUTER_MODE)) {
        tasks.push(
          timedJson('https://openrouter.ai/api/v1/credits', `Bearer ${env.OPENROUTER_API_KEY}`)
            .then((j) => {
              const bal = Number(j?.data?.total_credits ?? 0) - Number(j?.data?.total_usage ?? 0);
              return {
                provider: 'openrouter',
                label: 'OpenRouter',
                unit: 'usd',
                balance: bal,
                status: 'ok',
                low: bal < 5,
                dashboardUrl: 'https://openrouter.ai/credits',
              };
            })
            .catch(() => ({
              provider: 'openrouter',
              label: 'OpenRouter',
              unit: 'usd',
              balance: null,
              status: 'error',
              low: false,
              dashboardUrl: 'https://openrouter.ai/credits',
            })),
        );
      }
      if (env.KIE_API_KEY && isLive(env.KIE_MODE)) {
        const base = (env.KIE_BASE_URL ?? 'https://api.kie.ai').replace(/\/$/, '');
        tasks.push(
          timedJson(`${base}/api/v1/chat/credit`, `Bearer ${env.KIE_API_KEY}`)
            .then((j) => {
              const bal = Number(j?.data ?? 0);
              return {
                provider: 'kie',
                label: 'Kie.ai',
                unit: 'credits',
                balance: bal,
                status: 'ok',
                low: bal < 20,
                dashboardUrl: 'https://kie.ai/billing',
              };
            })
            .catch(() => ({
              provider: 'kie',
              label: 'Kie.ai',
              unit: 'credits',
              balance: null,
              status: 'error',
              low: false,
              dashboardUrl: 'https://kie.ai/billing',
            })),
        );
      }
      // Laozhang: system AccessToken + /api/user/self; balance USD = quota / 500_000
      // (500K quota ≈ $1). Raw token as the Authorization value (no "Bearer").
      if (env.LAOZHANG_ACCESS_TOKEN && isLive(env.LAOZHANG_MODE)) {
        const base = (env.LAOZHANG_BASE_URL ?? 'https://api.laozhang.ai').replace(/\/$/, '');
        tasks.push(
          timedJson(`${base}/api/user/self`, env.LAOZHANG_ACCESS_TOKEN)
            .then((j) => {
              const bal = Number(j?.data?.quota ?? 0) / 500_000;
              return {
                provider: 'laozhang',
                label: 'Laozhang',
                unit: 'usd',
                balance: bal,
                status: 'ok',
                low: bal < 5,
                dashboardUrl: 'https://api.laozhang.ai/panel',
              };
            })
            .catch(() => ({
              provider: 'laozhang',
              label: 'Laozhang',
              unit: 'usd',
              balance: null,
              status: 'error',
              low: false,
              dashboardUrl: 'https://api.laozhang.ai/panel',
            })),
        );
      }
      if (env.ATLASCLOUD_API_KEY && isLive(env.ATLASCLOUD_MODE)) {
        tasks.push(
          timedJson(
            'https://api.atlascloud.ai/public/v1/balance',
            `Bearer ${env.ATLASCLOUD_API_KEY}`,
          )
            .then((j) => {
              const bal = Number(j?.available?.value ?? NaN);
              return {
                provider: 'atlascloud',
                label: 'AtlasCloud',
                unit: 'usd',
                balance: Number.isFinite(bal) ? bal : null,
                status: Number.isFinite(bal) ? 'ok' : 'error',
                low: Number.isFinite(bal) && bal < 5,
                dashboardUrl: 'https://www.atlascloud.ai',
              };
            })
            .catch(() => ({
              provider: 'atlascloud',
              label: 'AtlasCloud',
              unit: 'usd',
              balance: null,
              status: 'error',
              low: false,
              dashboardUrl: 'https://www.atlascloud.ai',
            })),
        );
      }
      const fetched = await Promise.all(tasks);

      // Providers with a key but no reachable balance API — dashboard-only (not faked).
      const dashboardOnly: Array<Record<string, unknown>> = [];
      if (env.LAOZHANG_API_KEY && !env.LAOZHANG_ACCESS_TOKEN && isLive(env.LAOZHANG_MODE))
        dashboardOnly.push({
          provider: 'laozhang',
          label: 'Laozhang',
          unit: null,
          balance: null,
          status: 'no_api',
          low: false,
          dashboardUrl: 'https://api.laozhang.ai/panel',
        });

      // No global default provider: every active model pins its own primary and
      // fallback routing. The dashboard shows provider health, not a single
      // active gateway.
      const activeGateway = 'per-model';
      // Admin ON/OFF state per tier (assist_tier_states; missing row = active).
      const tierStates = await assistTierStatesView();
      const body = {
        activeGateway,
        providers: [...fetched, ...dashboardOnly].map((p) => ({
          ...p,
          active: false,
        })),
        // Text (LLM) routing for the «Сценарий» assist tiers (owner 2026-07-24):
        // the standard tier's Gemini AND the max tier's Claude go PRIMARY
        // through kie.ai (≈70% / ≈57% cheaper) with OpenRouter as the automatic
        // pre-token fallback; the economy tier is OpenRouter-only. `isActive`
        // is the admin kill-switch — enforced server-side in script-assist.ts
        // (409 tier_disabled before any credit hold); toggles go through
        // PATCH /v1/admin/text-tiers/:id below.
        textModels: ASSIST_TIERS.map((t) => ({
          id: t.id,
          labelRu: t.labelRu,
          model: t.model,
          creditsPerCall: t.creditsPerCall,
          priceUsdPerMTok: t.priceUsdPerMTok,
          isActive: tierStates[t.id]?.isActive ?? true,
          updatedAt: tierStates[t.id]?.updatedAt?.toISOString() ?? null,
          updatedBy: tierStates[t.id]?.updatedBy ?? null,
          route:
            t.model === KIE_PRIMARY_MODEL
              ? { ...kieChatRoute(), kiePriceUsdPerMTok: KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK }
              : t.model === KIE_CLAUDE_PRIMARY_MODEL
                ? { ...kieChatRoute(), kiePriceUsdPerMTok: KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK }
                : { primary: 'openrouter' as const },
        })),
      };
      balanceCache = { at: Date.now(), body };
      return body;
    },
  );

  // --- Phase 3: growth funnel (DB-derived; landing-visit lives in Plausible) ---
  app.get<{ Querystring: { days?: string } }>('/v1/admin/funnel', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const days = windowDays(req.query.days);
    const since = new Date(Date.now() - days * DAY_MS);

    type FunnelCohortRow = {
      cohort: string;
      channel: string;
      signups: string | number;
      attempted: string | number;
      activated: string | number;
      wow_video: string | number;
      paid: string | number;
      revenue_rub: string | number;
      refunded_rub: string | number;
      d1: string | number;
      d7: string | number;
      d30: string | number;
    };

    // Keep the cohort query as one DB-derived truth. Correlated EXISTS subqueries
    // prevent jobs/orders from multiplying one another, while the PII join removes
    // anonymous and known seed identities from business metrics. Plausible remains
    // the only source for anonymous visits; this endpoint never receives client
    // analytics payloads.
    const cohortResult = await db.execute(sql`
      WITH humans AS (
        SELECT
          ua.id,
          ua.created_at,
          date_trunc('week', ua.created_at) AS cohort,
          coalesce(nullif(ma.utm_source, ''), 'organic') AS channel
        FROM users_app ua
        LEFT JOIN users_pii pii ON pii.id = ua.id
        LEFT JOIN marketing_attribution ma ON ma.user_id = ua.id
        WHERE ua.created_at >= ${since}
          AND ua.deleted_at IS NULL
          AND coalesce(pii.email, '') NOT LIKE '%@anon.vertov.local'
          AND coalesce(pii.email, '') NOT LIKE '%seed.local'
      )
      SELECT
        to_char(h.cohort, 'YYYY-MM-DD') AS cohort,
        h.channel,
        count(*) AS signups,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j WHERE j.user_id = h.id
        )) AS attempted,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.user_id = h.id AND j.status = 'succeeded'
        )) AS activated,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1
          FROM jobs j
          JOIN models m ON m.id = j.model_id
          WHERE j.user_id = h.id AND j.status = 'succeeded' AND m.kind = 'video'
        ) OR EXISTS (
          SELECT 1 FROM studio_renders r
          WHERE r.user_id = h.id AND r.status = 'succeeded'
        )) AS wow_video,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM orders o
          WHERE o.user_id = h.id AND o.our_status = 'paid'
        )) AS paid,
        coalesce(sum((
          SELECT coalesce(sum(o.amount_rub), 0)
          FROM orders o
          WHERE o.user_id = h.id AND o.our_status = 'paid'
        )), 0) AS revenue_rub,
        coalesce(sum((
          SELECT coalesce(sum(o.amount_rub), 0)
          FROM orders o
          WHERE o.user_id = h.id AND o.our_status = 'refunded'
        )), 0) AS refunded_rub,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.user_id = h.id AND j.queued_at >= h.created_at + interval '1 day'
        ) OR EXISTS (
          SELECT 1 FROM studio_renders r
          WHERE r.user_id = h.id AND r.created_at >= h.created_at + interval '1 day'
        )) AS d1,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.user_id = h.id AND j.queued_at >= h.created_at + interval '7 days'
        ) OR EXISTS (
          SELECT 1 FROM studio_renders r
          WHERE r.user_id = h.id AND r.created_at >= h.created_at + interval '7 days'
        )) AS d7,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.user_id = h.id AND j.queued_at >= h.created_at + interval '30 days'
        ) OR EXISTS (
          SELECT 1 FROM studio_renders r
          WHERE r.user_id = h.id AND r.created_at >= h.created_at + interval '30 days'
        )) AS d30
      FROM humans h
      GROUP BY h.cohort, h.channel
      ORDER BY h.cohort DESC, h.channel ASC
    `);

    const cohorts = (cohortResult.rows as FunnelCohortRow[]).map((row) => ({
      cohort: row.cohort,
      channel: row.channel,
      signups: Number(row.signups),
      attempted: Number(row.attempted),
      activated: Number(row.activated),
      wowVideo: Number(row.wow_video),
      paid: Number(row.paid),
      revenueRub: Number(row.revenue_rub),
      refundedRub: Number(row.refunded_rub),
      retention: {
        d1: Number(row.d1),
        d7: Number(row.d7),
        d30: Number(row.d30),
      },
    }));
    const sum = (key: 'signups' | 'attempted' | 'activated' | 'wowVideo' | 'paid') =>
      cohorts.reduce((total, row) => total + row[key], 0);
    const signups = sum('signups');
    const attempted = sum('attempted');
    const activated = sum('activated');
    const paid = sum('paid');
    const wowVideo = sum('wowVideo');
    const byChannel = cohorts.reduce<Array<{ channel: string; signups: number }>>((result, row) => {
      const existing = result.find((candidate) => candidate.channel === row.channel);
      if (existing) existing.signups += row.signups;
      else result.push({ channel: row.channel, signups: row.signups });
      return result;
    }, []);
    byChannel.sort((a, b) => b.signups - a.signups || a.channel.localeCompare(b.channel));
    return {
      window: { days, since: since.toISOString() },
      landingVisit: {
        available: false,
        reason: 'Landing visits are tracked in Plausible (external) — not in the app DB.',
      },
      // All conversions are relative to the same human signup cohort. A user can
      // pay without generating, so paid/activated is intentionally not shown.
      steps: [
        { key: 'signup', label: 'Регистрация', count: signups, conv: null },
        {
          key: 'attempted',
          label: 'Первая попытка',
          count: attempted,
          conv: signups > 0 ? attempted / signups : null,
        },
        {
          key: 'activated',
          label: 'Первая генерация',
          count: activated,
          conv: signups > 0 ? activated / signups : null,
        },
        {
          key: 'paid',
          label: 'Оплата',
          count: paid,
          conv: signups > 0 ? paid / signups : null,
        },
      ],
      wowVideo: {
        count: wowVideo,
        conv: signups > 0 ? wowVideo / signups : null,
      },
      byChannel,
      cohorts,
    };
  });

  // --- Phase 3: audit log viewer ---
  app.get<{ Querystring: { limit?: string; action?: string } }>(
    '/v1/admin/audit',
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 100) || 100));
      const filters = req.query.action ? [eq(auditLog.action, req.query.action)] : [];
      const rows = await db
        .select()
        .from(auditLog)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit);
      return { rows };
    },
  );

  // Every gateway getAdapter()/getAdapterWithFallback() know how to build —
  // the admin dropdown's option list. Keep in sync with @seed/provider-byteplus's
  // `Gateway` union (checked by a contract test, see gateway-list.test.ts).
  // O-1 (2026-09-02): the 'nanobanana'/'geminiomni' chain labels are gone from
  // the picker — rows route via real gatewayOverride/fallbackGateway pairs now.
  // The registry still RESOLVES the aliases for in-flight legacy jobs, so a
  // stored value never breaks; it is simply no longer offered to new routing.
  const KNOWN_GATEWAYS = ['atlascloud', 'openrouter', 'laozhang', 'kie', 'gptproto'] as const;

  // --- Phase 3: model catalog (read; feeds the switch UI) ---
  app.get('/v1/admin/models', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const rows = await db
      .select({
        id: models.id,
        provider: models.provider,
        family: models.family,
        variant: models.variant,
        kind: models.kind,
        isActive: models.isActive,
        tierMin: models.tierMin,
        unitKind: models.unitKind,
        priceUsdPerUnit: sql<number | null>`(${models.capabilities}->>'priceUsdPerUnit')::numeric`,
        capForceGateway: sql<string | null>`(${models.capabilities}->>'forceGateway')`,
        providerModelId: models.providerModelId,
        capabilities: models.capabilities,
        gatewayOverride: models.gatewayOverride,
        fallbackGateway: models.fallbackGateway,
      })
      .from(models)
      .orderBy(models.kind, models.id);

    // The workbook-derived price-point rows are the only source for displayed
    // margin. capabilities.priceUsdPerUnit is kept in this response solely as a
    // legacy/admin compatibility field; it is not allowed to manufacture a
    // margin when the signed workbook has no row.
    const activePoints = await db
      .select()
      .from(modelPricePoints)
      .where(eq(modelPricePoints.isActive, true));
    const activePointsByModel = new Map<string, typeof activePoints>();
    for (const point of activePoints) {
      const bucket = activePointsByModel.get(point.modelId) ?? [];
      bucket.push(point);
      activePointsByModel.set(point.modelId, bucket);
    }

    // Fallback-usage stats (last 7 days) per model, so the operator can see
    // whether a configured fallback is actually being leaned on.
    const since = new Date(Date.now() - 7 * DAY_MS);
    const fallbackStats = await db
      .select({
        modelId: jobs.modelId,
        total: sql<number>`count(*)`,
        fellBack: sql<number>`count(*) filter (where ${jobs.usedFallback})`,
      })
      .from(jobs)
      .where(and(gte(jobs.queuedAt, since), eq(jobs.status, 'succeeded')))
      .groupBy(jobs.modelId);
    const statsByModel = new Map(fallbackStats.map((s) => [s.modelId, s]));

    const creditRub = await creditRubFloor();
    return {
      creditRubValue: creditRub,
      usdToRub: { direct: DIRECT_USD_TO_RUB, openrouter: OR_USD_TO_RUB },
      gateways: KNOWN_GATEWAYS,
      rows: rows.map((r) => {
        const usd = r.priceUsdPerUnit == null ? null : Number(r.priceUsdPerUnit);
        const points = activePointsByModel.get(r.id) ?? [];
        const breakEvenRows = points.map((point) =>
          pricePointBreakEven(
            {
              id: r.id,
              gatewayOverride: r.gatewayOverride,
              fallbackGateway: r.fallbackGateway,
              providerModelId: r.providerModelId,
              capabilities: r.capabilities,
            },
            creditRub,
            point,
          ),
        );
        const primaryMargins = breakEvenRows
          .map((result) => result.margin)
          .filter((margin): margin is number => margin !== null);
        const fallbackMargins = breakEvenRows
          .map((result) => result.fallback?.margin ?? null)
          .filter((margin): margin is number => margin !== null);
        const hasWorkbookMargin =
          points.length > 0 &&
          breakEvenRows.every((result) => result.hasCostData && result.margin !== null);
        const marginPct =
          hasWorkbookMargin && primaryMargins.length ? Math.min(...primaryMargins) : null;
        const fallbackMarginPct = fallbackMargins.length ? Math.min(...fallbackMargins) : null;
        // Mirrors the priority order resolved per-job in jobs-routes.ts: an
        // explicit admin override wins, then the slug-shaped-OpenRouter
        // inference, then the seed-time capabilities.forceGateway default.
        // No global env fallback: a model with no pin cannot route.
        const effectiveGateway =
          r.gatewayOverride ??
          (r.providerModelId.includes('/')
            ? 'openrouter'
            : (r.capForceGateway ?? 'unset (will fail)'));
        const stat = statsByModel.get(r.id);
        return {
          ...r,
          priceUsdPerUnit: usd,
          marginPct,
          workbookMarginPct: marginPct,
          workbookFallbackMarginPct: fallbackMarginPct,
          workbookPricePointCount: points.length,
          pricingSource: 'Vertov_Pricing_Model_v14_2026-07-28.xlsx',
          effectiveGateway,
          fallbackUsage7d: stat
            ? { total: Number(stat.total), fellBack: Number(stat.fellBack) }
            : null,
        };
      }),
    };
  });

  // --- Phase 3: model / pricing / gateway switches (audited write path) ---
  const gatewayField = z.enum(KNOWN_GATEWAYS).nullable();
  const modelPatchSchema = z
    .object({
      isActive: z.boolean().optional(),
      gatewayOverride: gatewayField.optional(),
      fallbackGateway: gatewayField.optional(),
      // A deliberate loss-leader is allowed only with a named, audit-visible
      // exception. This mirrors the price-point activation override.
      force: z.boolean().optional().default(false),
      forceReason: z.string().trim().min(1).max(500).optional(),
    })
    .refine(
      (v) =>
        v.isActive !== undefined ||
        v.gatewayOverride !== undefined ||
        v.fallbackGateway !== undefined,
      { message: 'nothing to update' },
    )
    .refine((v) => !v.force || v.forceReason !== undefined, {
      message: 'forceReason is required when force is true',
      path: ['forceReason'],
    });

  app.patch<{ Params: { id: string } }>('/v1/admin/models/:id', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = modelPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const [before] = await db.select().from(models).where(eq(models.id, req.params.id)).limit(1);
    if (!before) return reply.status(404).send({ error: 'not_found' });

    const gatewayChange =
      (parsed.data.gatewayOverride !== undefined &&
        parsed.data.gatewayOverride !== before.gatewayOverride) ||
      (parsed.data.fallbackGateway !== undefined &&
        parsed.data.fallbackGateway !== before.fallbackGateway);
    let gatewayIssues: GatewayMarginIssue[] = [];
    let gatewayFloorRub: number | null = null;
    if (gatewayChange) {
      const activePoints = await db
        .select()
        .from(modelPricePoints)
        .where(and(eq(modelPricePoints.modelId, before.id), eq(modelPricePoints.isActive, true)));
      // One source for this number (`packages/db/src/credit-floor.ts`): the gate and
      // the official-leg ledger must score revenue identically, or a leg the ledger
      // calls affordable is one the gate calls a violation. The unusable-tier guard
      // that used to live here is already inside `creditFloorRub`.
      const floorRub = await readConservativeCreditFloorRub(db);
      gatewayFloorRub = floorRub;
      gatewayIssues = inspectGatewayChange({
        before: {
          id: before.id,
          gatewayOverride: before.gatewayOverride,
          fallbackGateway: before.fallbackGateway,
          providerModelId: before.providerModelId,
          capabilities: before.capabilities,
        },
        after: {
          id: before.id,
          gatewayOverride:
            parsed.data.gatewayOverride !== undefined
              ? parsed.data.gatewayOverride
              : before.gatewayOverride,
          fallbackGateway:
            parsed.data.fallbackGateway !== undefined
              ? parsed.data.fallbackGateway
              : before.fallbackGateway,
          providerModelId: before.providerModelId,
          capabilities: before.capabilities,
        },
        floorRub,
        pricePoints: activePoints,
        v2Catalogue: costCatalogue(),
        gatewayArming: gatewayArmingFromEnv(process.env),
      });
      if (gatewayIssues.length > 0 && !parsed.data.force) {
        return reply.status(409).send({
          error: 'gateway_margin_guard',
          message:
            'Gateway change refused: an executable leg is below its margin floor or has no recorded cost. ' +
            'Use force:true with forceReason to accept an explicit exception.',
          modelId: before.id,
          floorRub,
          violations: gatewayIssues,
          override: { field: 'force', reasonField: 'forceReason' },
        });
      }
    }

    const patch: Partial<typeof models.$inferInsert> = {};
    if (parsed.data.isActive !== undefined) patch.isActive = parsed.data.isActive;
    if (parsed.data.gatewayOverride !== undefined)
      patch.gatewayOverride = parsed.data.gatewayOverride;
    if (parsed.data.fallbackGateway !== undefined)
      patch.fallbackGateway = parsed.data.fallbackGateway;
    const [after] = await db
      .update(models)
      .set(patch)
      .where(eq(models.id, req.params.id))
      .returning();

    const marginWarning: string | null = null;

    const gatewayMarginOverride =
      parsed.data.force && gatewayIssues.length > 0
        ? {
            reason: parsed.data.forceReason!,
            floorRub: gatewayFloorRub,
            accepted: gatewayIssues,
          }
        : null;

    await db.insert(auditLog).values({
      id: nid(),
      userId: session.user.id,
      action: 'admin.model_update',
      payload: {
        modelId: req.params.id,
        before: {
          isActive: before.isActive,
          gatewayOverride: before.gatewayOverride,
          fallbackGateway: before.fallbackGateway,
        },
        after: {
          isActive: after!.isActive,
          gatewayOverride: after!.gatewayOverride,
          fallbackGateway: after!.fallbackGateway,
        },
        marginWarning,
        gatewayMarginOverride,
      },
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    return { ok: true, model: after, marginWarning, gatewayMarginOverride };
  });

  // --- «Сценарий» text-tier ON/OFF switch (audited write path, owner 2026-07-24) ---
  // Flips assist_tier_states; the assist route enforces it server-side
  // (409 tier_disabled BEFORE any claim row / credit hold — see script-assist.ts).
  const textTierPatchSchema = z.object({ isActive: z.boolean() });

  app.patch<{ Params: { id: string } }>('/v1/admin/text-tiers/:id', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const tier = assistTier(req.params.id);
    if (!tier) return reply.status(404).send({ error: 'not_found' });
    const parsed = textTierPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const before = await assistTierState(tier.id);
    const now = new Date();
    const [after] = await db
      .insert(assistTierStates)
      .values({
        tierId: tier.id,
        isActive: parsed.data.isActive,
        updatedAt: now,
        updatedBy: session.user.id,
      })
      .onConflictDoUpdate({
        target: assistTierStates.tierId,
        set: { isActive: parsed.data.isActive, updatedAt: now, updatedBy: session.user.id },
      })
      .returning();

    // The assist route reads tier state through a short process-local cache —
    // invalidate so the toggle bites immediately; drop the balances cache too so
    // the cockpit's textModels block shows the new state on the next load.
    invalidateAssistTierStates();
    balanceCache = null;

    await db.insert(auditLog).values({
      id: nid(),
      userId: session.user.id,
      action: 'admin.text_tier_update',
      payload: {
        tierId: tier.id,
        before: { isActive: before.isActive },
        after: { isActive: after!.isActive },
      },
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    return {
      ok: true,
      tier: {
        id: tier.id,
        isActive: after!.isActive,
        updatedAt: after!.updatedAt,
        updatedBy: after!.updatedBy,
      },
    };
  });

  // --- Parametric price-point activation (audited, margin-gated) ---
  // The ONLY safe way to flip a model_price_points row active. A raw SQL flip
  // bypasses every check; this endpoint refuses to activate a row that loses money
  // at the model's REAL routing, using the SAME pricePointBreakEven() math the CI guard
  // (packages/db/__tests__/cogs-breakeven.test.ts) runs — so CI and runtime agree.
  const pricePointActivateSchema = z
    .object({
      resolution: z.string().min(1),
      videoInput: z.boolean().default(false),
      audio: z.boolean().default(false),
      // The other two halves of the row's identity. Defaulted so an existing caller
      // still addresses the plain row, and REQUIRED for the lookup to be unique: a
      // model can now hold a t2v row and an i2v row that differ in nothing else, and
      // a four-column WHERE + `.limit(1)` would activate whichever one Postgres
      // happened to return.
      mode: z.string().min(1).max(32).default('any'),
      refsMin: z.number().int().min(0).max(16).default(0),
      active: z.boolean().default(true),
      // Deliberate override that bypasses ALL activation blocks — below-break-even,
      // unverifiable-COGS, AND undeliverable-config (e.g. an owner-accepted sub-floor,
      // or activating a config knowing its delivery path is pending). Recorded in the
      // audit log; never silent, and never reason-less.
      force: z.boolean().default(false),
      forceReason: z.string().min(1).max(500).optional(),
    })
    // A force override MUST carry a reason — an unexplained below-cost activation is
    // exactly what the audit trail exists to prevent.
    .refine((v) => !v.force || (v.forceReason && v.forceReason.trim().length > 0), {
      message: 'forceReason is required when force is true',
      path: ['forceReason'],
    });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/models/:id/price-points/activate',
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      const parsed = pricePointActivateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { resolution, videoInput, audio, mode, refsMin, active, force, forceReason } =
        parsed.data;

      const [model] = await db.select().from(models).where(eq(models.id, req.params.id)).limit(1);
      if (!model) return reply.status(404).send({ error: 'model_not_found' });

      const [point] = await db
        .select()
        .from(modelPricePoints)
        .where(
          and(
            eq(modelPricePoints.modelId, req.params.id),
            eq(modelPricePoints.resolution, resolution),
            eq(modelPricePoints.videoInput, videoInput),
            eq(modelPricePoints.audio, audio),
            eq(modelPricePoints.mode, mode),
            eq(modelPricePoints.refsMin, refsMin),
          ),
        )
        .limit(1);
      if (!point) {
        return reply.status(404).send({
          error: 'price_point_not_found',
          modelId: req.params.id,
          resolution,
          mode,
          refsMin,
        });
      }

      // Break-even at REAL routing, at the cheapest credit rate any subscriber can
      // obtain — min over ALL tiers including an inactive legacy plan, whose credits
      // are still spendable. Same single source as the CI guard and the gateway gate;
      // `creditRubFloor` is now this function too, so there is no longer an
      // active-only variant to confuse it with.
      const floorRub = await readConservativeCreditFloorRub(db);
      const be = pricePointBreakEven(
        {
          id: model.id,
          gatewayOverride: model.gatewayOverride,
          fallbackGateway: model.fallbackGateway,
          providerModelId: model.providerModelId,
          capabilities: model.capabilities,
        },
        floorRub,
        point,
      );

      // Fail-closed gate (pure, unit-tested — see pricing-activation-gate.test.ts):
      // undeliverable config, below break-even, or unverifiable COGS all 409 unless
      // force. Deactivation is always allowed. The margin is calculated from THIS
      // row's credits and units (and its fallback leg), never borrowed from the
      // model reference rung. Since the COGS ladder has no independent arbitrary-SKU
      // costs, edited rows are additionally restricted to the canonical SSOT shape.
      const gateArgs = {
        active,
        modelId: model.id,
        resolution,
        routedFamily: be.routedFamily,
        hasCanonicalPrice: matchesPricePointSeed(point),
        hasCostData: be.hasCostData,
        margin: be.margin,
        floorRub,
        fallback: be.fallback
          ? {
              gateway: be.fallback.gateway,
              hasCostData: be.fallback.costPerCredit !== null,
              margin: be.fallback.margin,
            }
          : null,
      };
      const block = evaluatePricePointActivation({ ...gateArgs, force });
      if (block) {
        // undeliverable_config is a deliverability block (no margin context); the two
        // margin blocks carry the routing/margin diagnostics. Preserves the original
        // per-error response shapes.
        const payload: Record<string, unknown> = {
          error: block.error,
          message: block.reason,
          modelId: model.id,
          resolution,
        };
        if (block.error !== 'undeliverable_config' && block.error !== 'price_not_ssot') {
          payload.routedFamily = be.routedFamily;
          payload.marginPct = be.margin === null ? null : be.margin * 100;
          payload.hasCostData = be.hasCostData;
          payload.floorRub = floorRub;
        }
        return reply.status(block.status).send(payload);
      }
      // Would this activation have been blocked without `force`? (for the audit trail)
      const forcedOverBlock =
        force && evaluatePricePointActivation({ ...gateArgs, force: false }) !== null;

      // Atomic: the activation and its audit record commit together, so an active
      // (possibly forced below-cost) price point can NEVER exist without its logged
      // reason — if the audit insert fails, the activation rolls back too.
      const after = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(modelPricePoints)
          .set({ isActive: active })
          .where(eq(modelPricePoints.id, point.id))
          .returning();
        await tx.insert(auditLog).values({
          id: nid(),
          userId: session.user.id,
          action: 'admin.price_point_activation',
          payload: {
            modelId: model.id,
            resolution,
            videoInput,
            audio,
            mode,
            refsMin,
            before: { isActive: point.isActive },
            after: { isActive: row!.isActive },
            breakEven: {
              hasCostData: be.hasCostData,
              routedFamily: be.routedFamily,
              marginPct: be.margin === null ? null : be.margin * 100,
              fallback: be.fallback
                ? {
                    gateway: be.fallback.gateway,
                    family: be.fallback.family,
                    hasCostData: be.fallback.costPerCredit !== null,
                    marginPct: be.fallback.margin === null ? null : be.fallback.margin * 100,
                  }
                : null,
              floorRub,
            },
            forcedBelowBreakEven: forcedOverBlock,
            forceReason: forceReason ?? null,
          },
          ip: req.ip ?? null,
          ua: req.headers['user-agent'] ?? null,
        });
        return row;
      });

      return {
        ok: true,
        pricePoint: after,
        breakEven: {
          hasCostData: be.hasCostData,
          routedFamily: be.routedFamily,
          marginPct: be.margin === null ? null : be.margin * 100,
          fallback: be.fallback
            ? {
                gateway: be.fallback.gateway,
                family: be.fallback.family,
                hasCostData: be.fallback.costPerCredit !== null,
                marginPct: be.fallback.margin === null ? null : be.fallback.margin * 100,
              }
            : null,
          floorRub,
          forcedBelowBreakEven: forcedOverBlock,
        },
      };
    },
  );

  // --- Phase 4: support ops — user lookup ---
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/v1/admin/users',
    async (req, reply) => {
      if (!(await requireAdmin(req, reply))) return;
      const q = (req.query.q ?? '').trim();
      const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
      // Match on exact id or email substring (email lives in the PII split table).
      const rows = await db
        .select({
          id: usersApp.id,
          displayName: usersApp.displayName,
          tier: usersApp.tier,
          status: usersApp.status,
          createdAt: usersApp.createdAt,
          email: usersPii.email,
        })
        .from(usersApp)
        .leftJoin(usersPii, eq(usersPii.id, usersApp.id))
        .where(
          q ? sql`${usersApp.id} = ${q} or ${usersPii.email} ilike ${'%' + q + '%'}` : sql`true`,
        )
        .orderBy(desc(usersApp.createdAt))
        .limit(limit);
      return { rows };
    },
  );

  // --- Phase 4: support ops — user detail ---
  app.get<{ Params: { id: string } }>('/v1/admin/users/:id', async (req, reply) => {
    if (!(await requireAdmin(req, reply))) return;
    const id = req.params.id;
    const [user] = await db
      .select({
        id: usersApp.id,
        displayName: usersApp.displayName,
        tier: usersApp.tier,
        status: usersApp.status,
        locale: usersApp.locale,
        createdAt: usersApp.createdAt,
        onboardedAt: usersApp.onboardedAt,
        deletedAt: usersApp.deletedAt,
      })
      .from(usersApp)
      .where(eq(usersApp.id, id))
      .limit(1);
    if (!user) return reply.status(404).send({ error: 'not_found' });

    const [pii] = await db
      .select({ email: usersPii.email, phone: usersPii.phone })
      .from(usersPii)
      .where(eq(usersPii.id, id))
      .limit(1);
    const balance = await creditService.balanceFor(id);
    const sub = await findLifecycleSubscription(db, id);
    const recentJobs = await db
      .select({
        id: jobs.id,
        modelId: jobs.modelId,
        modelFamily: models.family,
        modelVariant: models.variant,
        modelDisplayName: models.displayName,
        status: jobs.status,
        creditsSpent: jobs.creditsSpent,
        errorCode: jobs.errorCode,
        queuedAt: jobs.queuedAt,
        finishedAt: jobs.finishedAt,
      })
      .from(jobs)
      .leftJoin(models, eq(models.id, jobs.modelId))
      .where(eq(jobs.userId, id))
      .orderBy(desc(jobs.queuedAt))
      .limit(20);
    const recentOrders = await db
      .select({
        id: orders.id,
        kind: orders.kind,
        amountRub: orders.amountRub,
        ourStatus: orders.ourStatus,
        paidAt: orders.paidAt,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.userId, id))
      .orderBy(desc(orders.createdAt))
      .limit(10);
    const creditHistory = await db
      .select({
        createdAt: creditTransactions.createdAt,
        amount: creditTransactions.amount,
        account: creditTransactions.account,
        reason: creditTransactions.reason,
        relatedOrderId: creditTransactions.relatedOrderId,
        relatedJobId: creditTransactions.relatedJobId,
        origin: creditBuckets.origin,
        expiresAt: creditBuckets.expiresAt,
      })
      .from(creditTransactions)
      .leftJoin(creditBuckets, eq(creditTransactions.bucketId, creditBuckets.id))
      .where(eq(creditTransactions.userId, id))
      .orderBy(desc(creditTransactions.createdAt))
      .limit(50);
    const linked = await db
      .select({ providerId: authAccount.providerId, createdAt: authAccount.createdAt })
      .from(authAccount)
      .where(eq(authAccount.userId, id));

    return {
      user,
      contact: { email: pii?.email ?? null, phone: pii?.phone ?? null },
      balance,
      subscription: sub ?? null,
      linkedAccounts: linked,
      recentJobs: recentJobs.map((job) => ({
        ...job,
        model:
          job.modelFamily && job.modelVariant
            ? {
                family: job.modelFamily,
                variant: job.modelVariant,
                displayName: job.modelDisplayName,
              }
            : null,
      })),
      recentOrders,
      creditHistory,
    };
  });

  // --- Phase 4: support ops — manual credit grant/refund (audited) ---
  const grantSchema = z.object({
    amount: z.number().int().positive().max(1_000_000),
    reason: z.string().min(3).max(500),
    account: z.enum(['refund', 'pack_grant']).default('refund'),
    // Client-supplied stable key so a re-click after a lost response (this stack
    // runs behind a tunnel) dedups instead of double-granting. A deterministic
    // compatibility key is derived when an old client omits it; a fresh random
    // fallback would turn a lost response into a second grant.
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9:_-]+$/)
      .optional(),
  });

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/credits', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = grantSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const [user] = await db
      .select({ id: usersApp.id })
      .from(usersApp)
      .where(eq(usersApp.id, req.params.id))
      .limit(1);
    if (!user) return reply.status(404).send({ error: 'not_found' });

    // Keys are user-scoped (a colliding client key on another user is a 409, not
    // a silent replay), and a client that omits the key falls back to a
    // deterministic legacy key so a re-click after a lost response dedups instead
    // of double-granting (both properties kept from the two ancestors of this
    // merge).
    const key = parsed.data.idempotencyKey
      ? `admin:grant:${req.params.id}:${parsed.data.idempotencyKey}`
      : legacyAdminGrantKey({
          adminUserId: session.user.id,
          targetUserId: req.params.id,
          amount: parsed.data.amount,
          reason: parsed.data.reason,
          account: parsed.data.account,
        });
    let grant;
    try {
      grant = await creditService.grant({
        userId: req.params.id,
        amount: parsed.data.amount,
        reason: `admin:${parsed.data.reason}`,
        idempotencyKey: key,
        account: parsed.data.account,
        origin: 'admin',
        expiresAt: null,
      });
    } catch (err) {
      if (err instanceof IdempotencyKeyConflictError) {
        return reply.status(409).send({ error: 'idempotency_key_conflict' });
      }
      throw err;
    }
    const outcome = grant.inserted ? 'granted' : 'replayed';
    await db.insert(auditLog).values({
      id: nid(),
      userId: session.user.id,
      action: 'admin.credit_grant',
      payload: {
        targetUserId: req.params.id,
        amount: parsed.data.amount,
        account: parsed.data.account,
        reason: parsed.data.reason,
        idempotencyKey: key,
        outcome,
      },
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    const balance = await creditService.balanceFor(req.params.id);
    return { ok: true, outcome, balance };
  });

  // --- Phase 4: support ops — manual subscription and account status (audited) ---
  // These tier names are the currently sellable catalog tiers. `creator` remains
  // readable for legacy rows, but support must not create a new legacy plan.
  const adminTierSchema = z.enum(['start', 'plus', 'pro', 'studio', 'max']);
  const createSubscriptionSchema = z.object({
    tier: adminTierSchema,
    grantCycleCredits: z.boolean().default(false),
  });
  const changeSubscriptionSchema = z.object({ tier: adminTierSchema });
  const extendSubscriptionSchema = z.object({ days: z.number().int().positive().max(3650) });
  const closeSubscriptionSchema = z.object({ mode: z.enum(['at_period_end', 'now']) });
  const statusSchema = z.object({
    status: z.enum(['active', 'banned']),
    reason: z.string().min(3).max(500),
  });

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/subscription', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = createSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const result = await db.transaction(async (tx) => {
      await lockMediaStorageUser(tx, req.params.id);
      const blockingIntent = await findLiveBillingIntent(tx, req.params.id);
      if (blockingIntent) {
        return { kind: 'billing_intent_in_flight' as const, orderId: blockingIntent.id };
      }
      const [user] = await tx
        .select({ id: usersApp.id })
        .from(usersApp)
        .where(eq(usersApp.id, req.params.id))
        .limit(1);
      if (!user) return { kind: 'not_found' as const };

      const existing = await findLifecycleSubscription(tx, req.params.id);
      if (existing) return { kind: 'already_subscribed' as const, subscriptionId: existing.id };

      const [catalog] = await tx
        .select()
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, parsed.data.tier))
        .limit(1);
      if (!catalog || !catalog.isActive) return { kind: 'tier_not_available' as const };

      const now = new Date();
      const periodEnd = new Date(now.getTime() + SUBSCRIPTION_CYCLE_MS);
      const subscriptionId = nid();
      await tx.insert(subscriptions).values({
        id: subscriptionId,
        userId: req.params.id,
        tier: parsed.data.tier,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        // Comped plans never enter the renewal worker: this explicit marker
        // matches the two owner test rows and prevents fabricated stub revenue.
        cancelAtPeriodEnd: true,
        cycleNumber: 1,
        priceRub: catalog.priceRub,
        creditsPerCycle: catalog.creditsPerCycle,
      });
      if (await hasPaidMediaStorage(tx, req.params.id, now)) {
        await tx
          .update(galleryItems)
          .set({ expiresAt: null })
          .where(and(eq(galleryItems.userId, req.params.id), isNull(galleryItems.deletedAt)));
      }
      if (parsed.data.grantCycleCredits) {
        await creditService.grant({
          userId: req.params.id,
          amount: catalog.creditsPerCycle,
          account: 'subscription_grant',
          origin: 'subscription',
          expiresAt: periodEnd,
          reason: 'admin.subscription_create',
          sourceSubscriptionId: subscriptionId,
          cycleNumber: 1,
          idempotencyKey: `admin:subscription:${subscriptionId}:cycle:1`,
          tx,
        });
      }
      await tx.insert(auditLog).values({
        id: nid(),
        userId: session.user.id,
        action: 'admin.subscription_create',
        payload: {
          targetUserId: req.params.id,
          before: null,
          after: {
            subscriptionId,
            tier: parsed.data.tier,
            status: 'active',
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            cancelAtPeriodEnd: true,
            cycleNumber: 1,
            priceRub: catalog.priceRub,
            creditsPerCycle: catalog.creditsPerCycle,
          },
          grantCycleCredits: parsed.data.grantCycleCredits,
        },
        ip: req.ip ?? null,
        ua: req.headers['user-agent'] ?? null,
      });
      return { kind: 'created' as const, subscriptionId, periodEnd };
    });
    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (result.kind === 'already_subscribed') {
      return reply
        .status(409)
        .send({ error: 'already_subscribed', subscriptionId: result.subscriptionId });
    }
    if (result.kind === 'billing_intent_in_flight') {
      return reply.status(409).send({ error: 'billing_intent_in_flight', orderId: result.orderId });
    }
    if (result.kind === 'tier_not_available') {
      return reply.status(400).send({ error: 'tier_not_available' });
    }
    return reply
      .status(201)
      .send({ ok: true, subscriptionId: result.subscriptionId, periodEnd: result.periodEnd });
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/users/:id/subscription', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = changeSubscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const result = await db.transaction(async (tx) => {
      await lockMediaStorageUser(tx, req.params.id);
      const blockingIntent = await findLiveBillingIntent(tx, req.params.id);
      if (blockingIntent) {
        return { kind: 'billing_intent_in_flight' as const, orderId: blockingIntent.id };
      }
      const sub = await findLifecycleSubscription(tx, req.params.id);
      if (!sub) return { kind: 'no_subscription' as const };
      const [catalog] = await tx
        .select()
        .from(subscriptionsCatalog)
        .where(eq(subscriptionsCatalog.tier, parsed.data.tier))
        .limit(1);
      if (!catalog || !catalog.isActive) return { kind: 'tier_not_available' as const };

      const before = {
        tier: sub.tier,
        priceRub: sub.priceRub,
        creditsPerCycle: sub.creditsPerCycle,
      };
      await tx
        .update(subscriptions)
        .set({
          tier: parsed.data.tier,
          priceRub: catalog.priceRub,
          creditsPerCycle: catalog.creditsPerCycle,
        })
        .where(eq(subscriptions.id, sub.id));
      await tx.insert(auditLog).values({
        id: nid(),
        userId: session.user.id,
        action: 'admin.subscription_tier_change',
        payload: {
          targetUserId: req.params.id,
          subscriptionId: sub.id,
          before,
          after: {
            tier: parsed.data.tier,
            priceRub: catalog.priceRub,
            creditsPerCycle: catalog.creditsPerCycle,
          },
        },
        ip: req.ip ?? null,
        ua: req.headers['user-agent'] ?? null,
      });
      return { kind: 'changed' as const, subscriptionId: sub.id };
    });
    if (result.kind === 'no_subscription') {
      return reply.status(404).send({ error: 'no_lifecycle_subscription' });
    }
    if (result.kind === 'billing_intent_in_flight') {
      return reply.status(409).send({ error: 'billing_intent_in_flight', orderId: result.orderId });
    }
    if (result.kind === 'tier_not_available') {
      return reply.status(400).send({ error: 'tier_not_available' });
    }
    return { ok: true, subscriptionId: result.subscriptionId };
  });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/users/:id/subscription/extend',
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      const parsed = extendSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const result = await db.transaction(async (tx) => {
        await lockMediaStorageUser(tx, req.params.id);
        const blockingIntent = await findLiveBillingIntent(tx, req.params.id);
        if (blockingIntent) {
          return { kind: 'billing_intent_in_flight' as const, orderId: blockingIntent.id };
        }
        const sub = await findLifecycleSubscription(tx, req.params.id);
        if (!sub) return { kind: 'no_subscription' as const };
        const periodEnd = new Date(sub.currentPeriodEnd.getTime() + parsed.data.days * DAY_MS);
        await tx
          .update(subscriptions)
          .set({ currentPeriodEnd: periodEnd })
          .where(eq(subscriptions.id, sub.id));
        await tx
          .update(creditBuckets)
          .set({
            // Deliberate support remedy: an expired current-cycle bucket becomes
            // spendable again if the operator restores time to its period.
            expiresAt: sql`${creditBuckets.expiresAt} + (${parsed.data.days} * interval '1 day')`,
          })
          .where(
            and(
              eq(creditBuckets.relatedSubscriptionId, sub.id),
              eq(creditBuckets.cycleNumber, sub.cycleNumber),
            ),
          );
        await tx.insert(auditLog).values({
          id: nid(),
          userId: session.user.id,
          action: 'admin.subscription_extend',
          payload: {
            targetUserId: req.params.id,
            subscriptionId: sub.id,
            days: parsed.data.days,
            before: { currentPeriodEnd: sub.currentPeriodEnd },
            after: { currentPeriodEnd: periodEnd, cycleNumber: sub.cycleNumber },
          },
          ip: req.ip ?? null,
          ua: req.headers['user-agent'] ?? null,
        });
        return { kind: 'extended' as const, subscriptionId: sub.id, periodEnd };
      });
      if (result.kind === 'no_subscription') {
        return reply.status(404).send({ error: 'no_lifecycle_subscription' });
      }
      if (result.kind === 'billing_intent_in_flight') {
        return reply
          .status(409)
          .send({ error: 'billing_intent_in_flight', orderId: result.orderId });
      }
      return { ok: true, subscriptionId: result.subscriptionId, periodEnd: result.periodEnd };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/users/:id/subscription/close',
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      const parsed = closeSubscriptionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const result = await db.transaction(async (tx) => {
        await lockMediaStorageUser(tx, req.params.id);
        const blockingIntent = await findLiveBillingIntent(tx, req.params.id);
        if (blockingIntent) {
          return { kind: 'billing_intent_in_flight' as const, orderId: blockingIntent.id };
        }
        const sub = await findLifecycleSubscription(tx, req.params.id);
        if (!sub) return { kind: 'no_subscription' as const };
        if (parsed.data.mode === 'at_period_end' && sub.status !== 'active') {
          return { kind: 'at_period_end_requires_active' as const };
        }
        const now = new Date();
        if (parsed.data.mode === 'at_period_end') {
          await tx
            .update(subscriptions)
            .set({ cancelAtPeriodEnd: true })
            .where(eq(subscriptions.id, sub.id));
        } else {
          // `resolveLivePlanSubscription` can select an older concurrent row,
          // so immediate close must revoke every lifecycle row, not just the
          // newest one returned by the management selector.
          await tx
            .update(subscriptions)
            .set({ status: 'canceled', currentPeriodEnd: now })
            .where(
              and(
                eq(subscriptions.userId, req.params.id),
                inArray(subscriptions.status, ['active', 'trialing', 'past_due']),
              ),
            );
          if (!(await hasPaidMediaStorage(tx, req.params.id, now))) {
            await tx
              .update(galleryItems)
              .set({ expiresAt: mediaExpiresAt(false, now) })
              .where(
                and(
                  eq(galleryItems.userId, req.params.id),
                  isNull(galleryItems.expiresAt),
                  isNull(galleryItems.deletedAt),
                ),
              );
          }
        }
        const after =
          parsed.data.mode === 'at_period_end'
            ? {
                status: sub.status,
                cancelAtPeriodEnd: true,
                currentPeriodEnd: sub.currentPeriodEnd,
              }
            : {
                status: 'canceled' as const,
                cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
                currentPeriodEnd: now,
              };
        // Intentionally do not alter credit buckets on an early close: a paid
        // cycle's grant is not confiscated retroactively (canon R4).
        await tx.insert(auditLog).values({
          id: nid(),
          userId: session.user.id,
          action: 'admin.subscription_close',
          payload: {
            targetUserId: req.params.id,
            subscriptionId: sub.id,
            mode: parsed.data.mode,
            before: {
              status: sub.status,
              cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
              currentPeriodEnd: sub.currentPeriodEnd,
            },
            after,
          },
          ip: req.ip ?? null,
          ua: req.headers['user-agent'] ?? null,
        });
        return { kind: 'closed' as const, subscriptionId: sub.id, mode: parsed.data.mode };
      });
      if (result.kind === 'no_subscription') {
        return reply.status(404).send({ error: 'no_lifecycle_subscription' });
      }
      if (result.kind === 'billing_intent_in_flight') {
        return reply
          .status(409)
          .send({ error: 'billing_intent_in_flight', orderId: result.orderId });
      }
      if (result.kind === 'at_period_end_requires_active') {
        return reply.status(409).send({ error: 'close_at_period_end_requires_active' });
      }
      return { ok: true, subscriptionId: result.subscriptionId, mode: result.mode };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/status', async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const result = await db.transaction(async (tx) => {
      const blockingIntent = await findLiveBillingIntent(tx, req.params.id);
      if (blockingIntent) {
        return { kind: 'billing_intent_in_flight' as const, orderId: blockingIntent.id };
      }
      const [user] = await tx
        .select({ id: usersApp.id, status: usersApp.status, deletedAt: usersApp.deletedAt })
        .from(usersApp)
        .where(eq(usersApp.id, req.params.id))
        .limit(1);
      if (!user) return { kind: 'not_found' as const };
      if (user.status === 'deleted' || user.deletedAt !== null) {
        return { kind: 'deleted_account' as const };
      }
      await tx
        .update(usersApp)
        .set({ status: parsed.data.status })
        .where(eq(usersApp.id, req.params.id));
      await tx.insert(auditLog).values({
        id: nid(),
        userId: session.user.id,
        action: 'admin.user_status_change',
        payload: {
          targetUserId: req.params.id,
          reason: parsed.data.reason,
          before: { status: user.status },
          after: { status: parsed.data.status },
        },
        ip: req.ip ?? null,
        ua: req.headers['user-agent'] ?? null,
      });
      return { kind: 'changed' as const };
    });
    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (result.kind === 'deleted_account') {
      return reply.status(409).send({ error: 'deleted_account_immutable' });
    }
    if (result.kind === 'billing_intent_in_flight') {
      return reply.status(409).send({ error: 'billing_intent_in_flight', orderId: result.orderId });
    }
    return { ok: true, status: parsed.data.status };
  });
}
