import http from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Queue } from 'bullmq';
import { pool } from '@seed/db';
import type { Logger } from 'pino';

/**
 * Standalone metrics surface for the worker process — same shape as
 * apps/api/src/metrics.ts (separate registry on purpose so we don't
 * accidentally cross-pollinate counters across processes).
 *
 * Hosts on 127.0.0.1:4002 by default.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const jobsCompletedTotal = new Counter({
  name: 'seed_jobs_completed_total',
  help: 'Worker job outcomes.',
  labelNames: ['status'] as const,
  registers: [registry],
});

export const creditsCommitTotal = new Counter({
  name: 'seed_credits_commit_total',
  help: 'Credit commit ledger writes (worker side).',
  registers: [registry],
});

export const creditsRefundTotal = new Counter({
  name: 'seed_credits_refund_total',
  help: 'Credit refund ledger writes (worker side).',
  registers: [registry],
});

export const legacyUnsnapshottedJobsTotal = new Counter({
  name: 'seed_legacy_unsnapshotted_jobs_total',
  help: 'Generation jobs executed without the immutable pre-queue execution snapshot.',
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

// Reaper activity so operators see lifecycle recovery/purge work without
// grepping logs (generation | render | anon-account | project-trash).
export const reaperReapedTotal = new Counter({
  name: 'seed_reaper_reaped_total',
  help: 'Jobs/renders timed-out and reaped to failed, by kind.',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const rendersCompletedTotal = new Counter({
  name: 'seed_renders_completed_total',
  help: 'Studio render outcomes.',
  labelNames: ['status'] as const,
  registers: [registry],
});

// Free-token welcome program: L0 72h-expiry reaper output.
export const welcomeL0ExpiredTotal = new Counter({
  name: 'seed_welcome_l0_expired_total',
  help: 'L0 welcome grants processed by the expiry reaper (users), and tokens clawed back.',
  labelNames: ['kind'] as const, // kind: 'users' | 'tokens'
  registers: [registry],
});

export const studioRenderQueueWaitSeconds = new Histogram({
  name: 'seed_studio_render_queue_wait_seconds',
  help: 'Time from Studio render enqueue to worker processor start.',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});

export const studioRenderWallSeconds = new Histogram({
  name: 'seed_studio_render_wall_seconds',
  help: 'Studio render processor wall time by terminal outcome.',
  labelNames: ['status'] as const,
  buckets: [1, 2, 5, 10, 30, 60, 120, 300, 600, 1200, 2400],
  registers: [registry],
});

// B-9: age of the oldest still-running work — a stuck job/render the reaper
// hasn't yet caught shows up as a climbing gauge.
export const oldestRunningJobAge = new Gauge({
  name: 'seed_oldest_running_job_age_seconds',
  help: 'Age of the oldest generation job still running (0 if none).',
  registers: [registry],
});

export const oldestRunningRenderAge = new Gauge({
  name: 'seed_oldest_running_render_age_seconds',
  help: 'Age of the oldest studio render still running (0 if none).',
  registers: [registry],
});

/** Oldest-running ages via raw SQL (drizzle-free, like the rest of this
 * module). Exported so the metrics test can assert it against seeded rows. */
export async function refreshAgeGauges(): Promise<void> {
  try {
    const jobs = await pool.query<{ age: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(started_at)))::text AS age
         FROM jobs WHERE status = 'running' AND started_at IS NOT NULL`,
    );
    oldestRunningJobAge.set(Number(jobs.rows[0]?.age ?? 0) || 0);
    const renders = await pool.query<{ age: string | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(started_at)))::text AS age
         FROM studio_renders WHERE status = 'running' AND started_at IS NOT NULL`,
    );
    oldestRunningRenderAge.set(Number(renders.rows[0]?.age ?? 0) || 0);
  } catch {
    // Keep last value on transient failure.
  }
}

export async function refreshGauges(queues: Record<string, Queue>): Promise<void> {
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
        // Leave the last value on transient Redis failures.
      }
    }),
  );
  try {
    // Raw SQL on purpose — see apps/api/src/metrics.ts for why we
    // avoid drizzle-orm in this module.
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM outbox_jobs WHERE processed_at IS NULL',
    );
    outboxPendingTotal.set(Number(result.rows[0]?.count ?? 0));
  } catch {
    // Same — keep last value.
  }
  await refreshAgeGauges();
}

export interface MetricsServerOptions {
  port: number;
  host?: string;
  log: Logger;
  queues: Record<string, Queue>;
  /**
   * Readiness probe (INF-17): resolves to { ok, checks } describing whether the
   * worker's deps (DB, Redis) are reachable. `/ready` returns 200 when ok, 503
   * otherwise — health-gated rollout (INF-16) waits for this before sending work.
   */
  readiness?: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
}

export function startMetricsServer(opts: MetricsServerOptions): { close: () => Promise<void> } {
  const host = opts.host ?? '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    // Liveness: the process is up and the event loop is turning.
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString() }));
      return;
    }

    // Readiness: dependencies (DB, Redis) reachable.
    if (req.url === '/ready') {
      const result = opts.readiness ? await opts.readiness() : { ok: true, checks: {} };
      res.setHeader('content-type', 'application/json');
      res.statusCode = result.ok ? 200 : 503;
      res.end(JSON.stringify(result));
      return;
    }

    if (req.url !== '/metrics') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      await refreshGauges(opts.queues);
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
  // Same 5s scrape cap as the api side — see apps/api/src/metrics.ts.
  server.requestTimeout = 5_000;
  server.listen(opts.port, host, () => {
    opts.log.info({ host, port: opts.port }, 'worker metrics server up');
  });
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
