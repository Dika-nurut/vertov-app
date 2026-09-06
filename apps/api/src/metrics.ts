import http from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Queue } from 'bullmq';
import type IORedis from 'ioredis';
import { pool } from '@seed/db';
import { currentDailySpend, dailySpendCap } from './spend-guard';
// Loose shape — accepts both pino.Logger and Fastify's FastifyBaseLogger.
// The metrics module only ever passes (obj, msg) so we don't need the
// full pino mixin overload chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MetricsLogger = { info: any; warn: any; error: any };

/**
 * Tight observability surface for the API process. Goal: answer "is
 * the engine healthy right now?" with a single `curl /metrics`. We
 * pick a small set of high-signal series and resist over-instrumenting
 * — anything we don't currently alert on is noise that has to be
 * maintained later.
 *
 * Mounted on a SEPARATE listener (127.0.0.1:4001) so it's never
 * exposed publicly through whatever proxy lands in front of the API.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new Counter({
  name: 'seed_http_requests_total',
  help: 'Total HTTP requests handled, partitioned by method/route/status.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'seed_http_request_duration_seconds',
  help: 'HTTP request latency. Buckets picked for the 5ms–5s range we expect.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'seed_queue_depth',
  help: 'BullMQ job counts by queue.',
  labelNames: ['queue', 'state'] as const,
  registers: [registry],
});

export const outboxPendingTotal = new Gauge({
  name: 'seed_outbox_pending_total',
  help: 'Outbox rows where processed_at IS NULL.',
  registers: [registry],
});

export const creditsGrantTotal = new Counter({
  name: 'seed_credits_grant_total',
  help: 'Credits granted, summed in units, by ledger account.',
  labelNames: ['account'] as const,
  registers: [registry],
});

/**
 * W1-0 — PSP webhook events we could not settle and had to retain
 * (`billing_unresolved_events`). Every increment is real money we have not
 * accounted for, so this is an alerting signal, not a debug counter: a
 * non-zero rate means a customer may be charged with nothing delivered.
 */
export const billingUnresolvedEventsTotal = new Counter({
  name: 'seed_billing_unresolved_events_total',
  help: 'PSP webhook events retained because they could not be settled, by event type.',
  labelNames: ['event'] as const,
  registers: [registry],
});

/** Last Tochka reconciliation tick with no provider failures (Unix seconds). A
 * stale value is an operational alert even when the queue is empty and the
 * loop has nothing interesting to log. */
export const tochkaReconciliationLastSuccess = new Gauge({
  name: 'seed_tochka_reconciliation_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last completed Tochka reconciliation tick.',
  registers: [registry],
});

export const tochkaReconciliationFailuresTotal = new Counter({
  name: 'seed_tochka_reconciliation_failures_total',
  help: 'Tochka reconciliation failures by operation.',
  labelNames: ['operation'] as const,
  registers: [registry],
});

// Free-token welcome program (Phase 1 telemetry). Cumulative counters — the
// "per day" view is a rate()/increase() query over these time series. The
// durable per-grant history also lives in free_grant_events for reconciliation.
export const freeGrantsIssuedTotal = new Counter({
  name: 'seed_free_grants_issued_total',
  help: 'Welcome-program grants issued, by level (L0–L3 or collapsed DAILY).',
  labelNames: ['level'] as const,
  registers: [registry],
});

export const freeGrantsRefusedTotal = new Counter({
  name: 'seed_free_grants_refused_total',
  help: 'Welcome-program grants refused, by level (with daily dates collapsed to DAILY) and reason.',
  labelNames: ['level', 'reason'] as const,
  registers: [registry],
});

export const dailySpendCredits = new Gauge({
  name: 'seed_daily_spend_credits',
  help: 'Platform generation spend so far today (credits), the BL-1 rolling counter.',
  registers: [registry],
});

export const dailySpendCapCredits = new Gauge({
  name: 'seed_daily_spend_cap_credits',
  help: 'Daily platform spend ceiling in credits (DAILY_SPEND_CAP_CREDITS); 0 = disabled.',
  registers: [registry],
});

export const scenarioAssistRequestsTotal = new Counter({
  name: 'seed_scenario_assist_requests_total',
  help: 'Scenario assist requests by tier, scope, and terminal outcome.',
  labelNames: ['tier', 'scope', 'outcome'] as const,
  registers: [registry],
});

export const scenarioAssistLatency = new Histogram({
  name: 'seed_scenario_assist_latency_seconds',
  help: 'Scenario assist completion latency by tier and scope.',
  labelNames: ['tier', 'scope'] as const,
  buckets: [0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

export const scenarioAssistTtft = new Histogram({
  name: 'seed_scenario_assist_ttft_seconds',
  help: 'Scenario assist time to first text token by tier and scope.',
  labelNames: ['tier', 'scope'] as const,
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const scenarioAssistInFlight = new Gauge({
  name: 'seed_scenario_assist_in_flight',
  help: 'Current Scenario provider requests in flight.',
  registers: [registry],
});

export const scenarioAssistValidationFailures = new Counter({
  name: 'seed_scenario_assist_validation_failures_total',
  help: 'Scenario responses rejected as unusable by tier and scope.',
  labelNames: ['tier', 'scope'] as const,
  registers: [registry],
});

export const scenarioAssistTextRoute = new Counter({
  name: 'seed_scenario_assist_text_route_total',
  help: 'Standard-tier Gemini text routing (kie.ai primary, OpenRouter fallback): which leg served, or why it fell back / could not fall back.',
  labelNames: ['leg', 'outcome'] as const,
  registers: [registry],
});

export const scenarioCreditSettlements = new Counter({
  name: 'seed_scenario_credit_settlements_total',
  help: 'Scenario assist credit settlement outcomes.',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const scenarioContextPlans = new Counter({
  name: 'seed_scenario_context_plans_total',
  help: 'Scenario context plans by scope and low-cardinality size bucket.',
  labelNames: ['scope', 'size_bucket'] as const,
  registers: [registry],
});

export const scenarioAssistQuotesTotal = new Counter({
  name: 'seed_scenario_assist_quotes_total',
  help: 'Scenario quote lifecycle by tier, scope, band, and terminal outcome.',
  labelNames: ['tier', 'scope', 'band', 'outcome'] as const,
  registers: [registry],
});

export const scenarioMaterialCompactions = new Counter({
  name: 'seed_scenario_material_compactions_total',
  help: 'Scenario material compaction terminal outcomes.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const scenarioRollingSummaries = new Counter({
  name: 'seed_scenario_rolling_summaries_total',
  help: 'Scenario rolling conversation summary outcomes.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const scenarioBoardHandoffs = new Counter({
  name: 'seed_scenario_board_handoffs_total',
  help: 'Scenario to Board handoff terminal outcomes.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const scenarioStructurizeRequestsTotal = new Counter({
  name: 'seed_scenario_structurize_requests_total',
  help: 'Scenario structurization requests by source kind and terminal outcome.',
  labelNames: ['kind', 'outcome'] as const,
  registers: [registry],
});

export const scenarioStructurizeAttempts = new Counter({
  name: 'seed_scenario_structurize_attempts_total',
  help: 'Scenario structurization gateway attempts by result (parsed | schema_fail | provider_fail).',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const shotPlanRequestsTotal = new Counter({
  name: 'seed_shot_plan_requests_total',
  help: 'Scene-to-shots planning requests by terminal outcome.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const shotPlanAttempts = new Counter({
  name: 'seed_shot_plan_attempts_total',
  help: 'Scene-to-shots gateway attempts by result (parsed | schema_fail | provider_fail).',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * Calibration for SHOT_PLAN_CHARS_PER_TOKEN (contract §3). The char budget is a
 * deliberately pessimistic working assumption, not a guarantee: this histogram
 * records the ratio the provider actually reported, and the counter below fires
 * whenever an attempt's input exceeded the budget the ceiling was priced on.
 */
export const shotPlanInputTokensPerChar = new Histogram({
  name: 'seed_shot_plan_input_tokens_per_char',
  help: 'Reported input tokens divided by assembled prompt characters, per attempt.',
  buckets: [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6, 0.8, 1],
  registers: [registry],
});

export const shotPlanBudgetOverrun = new Counter({
  name: 'seed_shot_plan_budget_overrun_total',
  help: 'Attempts whose reported input tokens exceeded SHOT_PLAN_BUDGET.input.',
  registers: [registry],
});

export const scenarioShotPlanRequestsTotal = new Counter({
  name: 'seed_scenario_shot_plan_requests_total',
  help: 'Scenario shot-planner requests by terminal outcome; cache hits are zero-call.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const scenarioShotPlanAttempts = new Counter({
  name: 'seed_scenario_shot_plan_attempts_total',
  help: 'Scenario shot-planner provider attempts by result.',
  labelNames: ['result'] as const,
  registers: [registry],
});

// seed_jobs_completed_total lives in the WORKER registry — the API
// process never observes job outcomes. Don't declare a same-named
// counter here or scrapers see a flat zero and assume it's accurate.

/**
 * Snapshot BullMQ counts + outbox backlog into gauges. Called every
 * scrape (cheap, all Redis calls). Done synchronously inside the
 * /metrics handler so the gauge values match the scrape moment.
 */
export async function refreshGauges(
  queues: Record<string, Queue>,
  spend?: { redis: IORedis; env?: NodeJS.ProcessEnv },
): Promise<void> {
  await Promise.all(
    Object.entries(queues).map(async ([name, q]) => {
      try {
        const c = await q.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed');
        queueDepth.labels(name, 'wait').set(c.wait ?? 0);
        queueDepth.labels(name, 'active').set(c.active ?? 0);
        queueDepth.labels(name, 'delayed').set(c.delayed ?? 0);
        queueDepth.labels(name, 'failed').set(c.failed ?? 0);
        queueDepth.labels(name, 'completed').set(c.completed ?? 0);
      } catch {
        // Redis hiccup — leave the last-known value rather than zeroing.
      }
    }),
  );
  try {
    // Raw SQL on purpose — avoids dragging drizzle's peer-dep graph
    // into this module so prom-client's @opentelemetry/api transitive
    // doesn't fork drizzle-orm into two type-incompatible stamps.
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox_jobs WHERE processed_at IS NULL',
    );
    outboxPendingTotal.set(Number(result.rows[0]?.count ?? 0));
  } catch {
    // Same reasoning — keep last value on transient DB failures.
  }
  // BL-1 daily spend vs. cap (INF-17) — lets alerting fire as spend approaches
  // the ceiling, before generation starts getting refused.
  if (spend) {
    try {
      dailySpendCapCredits.set(dailySpendCap(spend.env ?? process.env));
      dailySpendCredits.set(await currentDailySpend(spend.redis));
    } catch {
      // Redis hiccup — keep last value.
    }
  }
}

export interface MetricsServerOptions {
  port: number;
  host?: string;
  log: MetricsLogger;
  queues: Record<string, Queue>;
  /** When set, the scrape also gauges BL-1 daily spend vs. cap (INF-17). */
  spend?: { redis: IORedis; env?: NodeJS.ProcessEnv };
}

/**
 * Start a tiny standalone HTTP server that exposes /metrics on the
 * given host:port. Returns a handle with a `close()` for graceful
 * shutdown. Anything other than GET /metrics returns 404 — no other
 * routes are mounted here.
 */
export function startMetricsServer(opts: MetricsServerOptions): { close: () => Promise<void> } {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      await refreshGauges(opts.queues, opts.spend);
      const body = await registry.metrics();
      res.setHeader('content-type', registry.contentType);
      res.statusCode = 200;
      res.end(body);
    } catch (err) {
      opts.log.error({ err }, 'metrics: scrape failed');
      res.statusCode = 500;
      res.end('scrape failed');
    }
  });
  // Cap a single scrape at 5s so a wedged refreshGauges call can't
  // pile up Prometheus requests behind it. Default Node has no
  // per-request ceiling on http.createServer.
  server.requestTimeout = 5_000;
  server.listen(opts.port, host, () => {
    opts.log.info({ host, port: opts.port }, 'metrics server up');
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
