import 'dotenv/config';

// Sentry error monitoring — stub mode when SENTRY_DSN is empty.
// beforeSend scrubs PII per 152-ФЗ.
import * as Sentry from '@sentry/node';

type _WorkerSentryEvent = {
  request?: { cookies?: unknown; headers?: Record<string, unknown>; data?: unknown };
  extra?: Record<string, unknown>;
  contexts?: Record<string, Record<string, unknown> | null | undefined>;
};

const _PII_KEY_RE = /prompt|email|phone|name|address/i;
function _scrubObj(obj: Record<string, unknown> | null | undefined): void {
  if (!obj) return;
  for (const key of Object.keys(obj)) {
    if (_PII_KEY_RE.test(key)) delete obj[key];
  }
}
function _sentryBeforeSend(event: _WorkerSentryEvent): _WorkerSentryEvent | null {
  if (event.request) {
    delete event.request.cookies;
    if (event.request.headers) {
      delete (event.request.headers as Record<string, unknown>)['cookie'];
      delete (event.request.headers as Record<string, unknown>)['authorization'];
    }
    delete event.request.data;
  }
  if (event.extra) _scrubObj(event.extra as Record<string, unknown>);
  if (event.contexts) {
    for (const ctx of Object.values(event.contexts)) {
      if (ctx && typeof ctx === 'object') _scrubObj(ctx as Record<string, unknown>);
    }
  }
  return event;
}

const _sentryDsn = process.env.SENTRY_DSN;
if (_sentryDsn) {
  const _isDebug = process.env.SENTRY_DEBUG === '1';
  const _isDev = process.env.NODE_ENV === 'development';
  Sentry.init({
    dsn: _sentryDsn,
    tracesSampleRate: _isDebug || _isDev ? 1.0 : 0.1,
    debug: _isDebug,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeSend: _sentryBeforeSend as any,
  });
}

import { Worker, Queue, type Processor } from 'bullmq';
import IORedis from 'ioredis';
import { pino } from 'pino';
import {
  CREDIT_COMMIT_QUEUE,
  CREDIT_REFUND_QUEUE,
  AUTH_EMAIL_QUEUE,
  JOB_RUN_QUEUE,
  STUDIO_RENDER_QUEUE,
  type AuthEmailJob,
  type CreditCommitJob,
  type CreditRefundJob,
  type JobRunPayload,
  type StudioRenderPayload,
  CreditService,
  startOutboxDrainer,
  redisTlsOptions,
  SETTLEMENT_WORKER_SETTINGS,
} from '@seed/credits';
import { pool } from '@seed/db';
import { runJob } from './job-runner';
import { registerOfficialLegBudget } from './official-leg-budget';
import { runStudioRender } from './studio-render';
import { closeEventPublisher } from './events';
import { startReaper } from './reaper';
import { startRenderReaper } from './render-reaper';
import { startSubscriptionCycle } from './subscription-cycle';
import { startGalleryReaper } from './gallery-reaper';
import { startAnonAccountReaper } from './anon-account-reaper';
import { startWelcomeExpiryReaper } from './welcome-expiry-reaper';
import { startProjectTrashReaper } from './project-trash-reaper';
import { startBoardTrashReaper } from './board-trash-reaper';
import { startRouteMarginAlarm } from './route-margin-alarm-poller';
import { drainWorkers } from './shutdown';
import { probeReadiness } from './readiness';
import { sendAuthEmailJob } from './auth-email';
import {
  creditsCommitTotal,
  creditsRefundTotal,
  jobsCompletedTotal,
  rendersCompletedTotal,
  studioRenderQueueWaitSeconds,
  studioRenderWallSeconds,
  startMetricsServer,
} from './metrics';

// pino-pretty only when NODE_ENV === 'development'. Anywhere else
// (production, staging, undefined-via-CI) emits newline-delimited JSON
// ready for any aggregator.
const isDev = process.env.NODE_ENV === 'development';
const logLevel = process.env.LOG_LEVEL ?? 'info';
const log = pino(
  isDev
    ? {
        level: logLevel,
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }
    : { level: logLevel },
);

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const METRICS_PORT = Number(process.env.WORKER_METRICS_PORT ?? 4002);
// Bind to all interfaces when running in a container (Prometheus scrapes from outside);
// loopback-only for local dev (the safe default).
const METRICS_HOST = process.env.WORKER_METRICS_HOST ?? '127.0.0.1';
function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  ...redisTlsOptions(REDIS_URL),
});
const credits = new CreditService();

// Arm the third leg of the image chain (openrouter-official). Until this runs
// the leg does not exist at all — the provider package refuses to build an
// unmetered last-resort leg, per finance's 2026-08-02 cap (Ask 8 b).
registerOfficialLegBudget();

const commitQueue = new Queue<CreditCommitJob>(CREDIT_COMMIT_QUEUE, { connection });
const refundQueue = new Queue<CreditRefundJob>(CREDIT_REFUND_QUEUE, { connection });
const jobRunQueue = new Queue<JobRunPayload>(JOB_RUN_QUEUE, {
  connection,
  // Transient EU↔Evolink network blips on long video jobs → retry a few times
  // with backoff before giving up (the last attempt refunds cleanly).
  defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 8000 } },
});
const studioRenderQueue = new Queue<StudioRenderPayload>(STUDIO_RENDER_QUEUE, { connection });
const authEmailQueue = new Queue<AuthEmailJob>(AUTH_EMAIL_QUEUE, {
  connection,
  // SMTP outages are expected to be transient. Keep retries in BullMQ so the
  // outbox only has to guarantee the hand-off from Postgres to Redis.
  defaultJobOptions: {
    attempts: positiveIntEnv('AUTH_EMAIL_ATTEMPTS', 5),
    backoff: {
      type: 'exponential',
      delay: positiveIntEnv('AUTH_EMAIL_RETRY_DELAY_MS', 1000),
    },
  },
});

const commitProcessor: Processor<CreditCommitJob, unknown> = async (job) => {
  const reqId = (job.data as { _reqId?: string })._reqId;
  const child = reqId ? log.child({ reqId, queue: CREDIT_COMMIT_QUEUE }) : log;
  const { userId, jobId, amount, idempotencyKey, reason } = job.data;
  child.info({ id: job.id, jobId, userId, amount }, 'credits.commit start');
  const result = await credits.commit(
    reason === undefined
      ? { userId, jobId, amount, idempotencyKey }
      : { userId, jobId, amount, idempotencyKey, reason },
  );
  creditsCommitTotal.inc();
  child.info({ id: job.id, spendId: result.spend.id }, 'credits.commit done');
  return { ok: true };
};

const refundProcessor: Processor<CreditRefundJob, unknown> = async (job) => {
  const reqId = (job.data as { _reqId?: string })._reqId;
  const child = reqId ? log.child({ reqId, queue: CREDIT_REFUND_QUEUE }) : log;
  const { userId, jobId, amount, idempotencyKey, reason } = job.data;
  child.info({ id: job.id, jobId, userId, amount, reason }, 'credits.refund start');
  const result = await credits.refund({ userId, jobId, amount, idempotencyKey, reason });
  creditsRefundTotal.inc();
  child.info({ id: job.id, refundId: result.refund.id }, 'credits.refund done');
  return { ok: true };
};

const jobsRunProcessor: Processor<JobRunPayload, unknown> = async (job) => {
  const reqId = (job.data as { _reqId?: string })._reqId;
  const child = reqId ? log.child({ reqId, queue: JOB_RUN_QUEUE }) : log;
  const { jobId } = job.data;
  child.info({ id: job.id, jobId, attempt: job.attemptsMade }, 'jobs.run start');
  const base = {
    jobId,
    log: child,
    attempt: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
  };
  const outcome = await runJob(reqId ? { ...base, reqId } : base);
  jobsCompletedTotal.labels(outcome).inc();
  child.info({ id: job.id, jobId, outcome }, 'jobs.run done');
  return { outcome };
};

// The settlement jobs the outbox enqueues carry `backoff: { type: 'custom' }`
// (retry effectively forever, capped delay — money is never abandoned by a retry
// counter). BullMQ resolves a custom backoff through the WORKER's strategy, so
// without these settings the retries would fire back-to-back with no delay.

const authEmailProcessor: Processor<AuthEmailJob, unknown> = async (job) => {
  const reqId = job.data._reqId;
  const child = reqId ? log.child({ reqId, queue: AUTH_EMAIL_QUEUE }) : log;
  child.info({ id: job.id, attempt: job.attemptsMade }, 'auth.email start');
  const outcome = await sendAuthEmailJob(job.data);
  child.info({ id: job.id, outcome }, 'auth.email done');
  return { outcome };
};

const commitWorker = new Worker<CreditCommitJob>(CREDIT_COMMIT_QUEUE, commitProcessor, {
  connection,
  settings: SETTLEMENT_WORKER_SETTINGS,
});
const refundWorker = new Worker<CreditRefundJob>(CREDIT_REFUND_QUEUE, refundProcessor, {
  connection,
  settings: SETTLEMENT_WORKER_SETTINGS,
});
// Video generation can run several minutes (submit + multi-minute provider
// queue + poll). The BullMQ default 30s lock would mark such a job "stalled"
// and re-deliver it — causing a duplicate provider call (double spend) or a
// false failure. Hold the lock well past the adapter's 300s poll ceiling.
// Generation jobs are I/O-BOUND — they mostly wait on the provider (submit +
// multi-minute poll + asset download), burning little CPU. So concurrency here
// is bounded by RAM (in-flight asset buffers) and vendor rate limits, not cores,
// and can run well above the render concurrency. Env-tunable so a dedicated
// worker VM can raise it without a rebuild. Default 4 = the pre-split value.
const JOBS_WORKER_CONCURRENCY = Number(process.env.JOBS_WORKER_CONCURRENCY ?? 4);
const jobsWorker = new Worker<JobRunPayload>(JOB_RUN_QUEUE, jobsRunProcessor, {
  connection,
  concurrency: JOBS_WORKER_CONCURRENCY,
  lockDuration: 360_000,
  stalledInterval: 60_000,
  maxStalledCount: 1,
});

const studioRenderProcessor: Processor<StudioRenderPayload, unknown> = async (job) => {
  const reqId = (job.data as { _reqId?: string })._reqId;
  const child = reqId ? log.child({ reqId, queue: STUDIO_RENDER_QUEUE }) : log;
  const { renderId } = job.data;
  const startedAt = Date.now();
  studioRenderQueueWaitSeconds.observe(Math.max(0, (startedAt - job.timestamp) / 1000));
  child.info({ id: job.id, renderId }, 'studio.render start');
  const outcome = await runStudioRender({ renderId, log: child });
  studioRenderWallSeconds.labels(outcome).observe((Date.now() - startedAt) / 1000);
  rendersCompletedTotal.labels(outcome).inc();
  child.info({ id: job.id, renderId, outcome }, 'studio.render done');
  return { outcome };
};

// ffmpeg renders are CPU-BOUND (~1 full core per 1080p encode) — concurrency
// must track available cores, not RAM. Keep it ≈ (vCPU − 1) so the I/O-bound
// generation work + reapers keep a core. Env-tunable; default 2 = pre-split value.
const STUDIO_RENDER_CONCURRENCY = Number(process.env.STUDIO_RENDER_CONCURRENCY ?? 2);
const studioRenderWorker = new Worker<StudioRenderPayload>(
  STUDIO_RENDER_QUEUE,
  studioRenderProcessor,
  {
    connection,
    concurrency: STUDIO_RENDER_CONCURRENCY,
    lockDuration: 660_000,
    stalledInterval: 60_000,
    maxStalledCount: 1,
  },
);
const AUTH_EMAIL_WORKER_CONCURRENCY = positiveIntEnv('AUTH_EMAIL_WORKER_CONCURRENCY', 8);
const AUTH_EMAIL_SMTP_TIMEOUT_MS = positiveIntEnv('SMTP_TIMEOUT_MS', 10_000);
const authEmailWorker = new Worker<AuthEmailJob>(AUTH_EMAIL_QUEUE, authEmailProcessor, {
  connection,
  concurrency: AUTH_EMAIL_WORKER_CONCURRENCY,
  // Keep the lock longer than one bounded SMTP attempt so a slow provider is
  // retried by BullMQ rather than reported as a stalled duplicate.
  lockDuration: Math.max(60_000, AUTH_EMAIL_SMTP_TIMEOUT_MS * 2),
  stalledInterval: 60_000,
  maxStalledCount: 1,
});

const noopWorker = new Worker(
  'seed.noop',
  async (job) => {
    log.info({ id: job.id, name: job.name }, 'noop processed');
    return { ok: true };
  },
  { connection },
);

const reaper = startReaper({ log, redis: connection });
const renderReaper = startRenderReaper({ log, redis: connection });
const subCycle = startSubscriptionCycle({ log, redis: connection });
const galleryReaper = startGalleryReaper({ log, redis: connection });
const anonAccountReaper = startAnonAccountReaper({ log, redis: connection });
const welcomeExpiryReaper = startWelcomeExpiryReaper({ log, redis: connection });
const projectTrashReaper = startProjectTrashReaper({ log, redis: connection });
const boardTrashReaper = startBoardTrashReaper({ log, redis: connection });
// Off unless ROUTE_MARGIN_ALARM_ENABLED=1; returns a no-op handle otherwise.
const routeMarginAlarm = startRouteMarginAlarm({ log, redis: connection });
const outbox = startOutboxDrainer({
  log,
  queues: {
    [JOB_RUN_QUEUE]: jobRunQueue,
    [CREDIT_COMMIT_QUEUE]: commitQueue,
    [CREDIT_REFUND_QUEUE]: refundQueue,
    [STUDIO_RENDER_QUEUE]: studioRenderQueue,
    [AUTH_EMAIL_QUEUE]: authEmailQueue,
  },
});

const metricsServer = startMetricsServer({
  port: METRICS_PORT,
  host: METRICS_HOST,
  log,
  queues: {
    [JOB_RUN_QUEUE]: jobRunQueue,
    [CREDIT_COMMIT_QUEUE]: commitQueue,
    [CREDIT_REFUND_QUEUE]: refundQueue,
    // INF-17: the render queue was previously unguaged, so a render backlog was
    // invisible to alerting. Gauge it too.
    [STUDIO_RENDER_QUEUE]: studioRenderQueue,
    [AUTH_EMAIL_QUEUE]: authEmailQueue,
  },
  // INF-17 readiness: the worker can only do work if both Postgres (ledger) and
  // Redis (queues) are reachable.
  readiness: () =>
    probeReadiness({
      db: () => pool.query('SELECT 1'),
      redis: () => connection.ping(),
    }),
});

for (const w of [
  commitWorker,
  refundWorker,
  jobsWorker,
  studioRenderWorker,
  authEmailWorker,
  noopWorker,
]) {
  w.on('ready', () => log.info({ queue: w.name }, 'worker up'));
  w.on('error', (err) => log.error({ err, queue: w.name }, 'worker error'));
  w.on('failed', (job, err) => log.error({ jobId: job?.id, queue: w.name, err }, 'job failed'));
}

const SHUTDOWN_DRAIN_TIMEOUT_MS = Number(process.env.SHUTDOWN_DRAIN_TIMEOUT_MS ?? 25_000);

const shutdown = async (sig: string) => {
  log.info({ sig }, 'shutting down');
  reaper.stop();
  renderReaper.stop();
  subCycle.stop();
  galleryReaper.stop();
  anonAccountReaper.stop();
  welcomeExpiryReaper.stop();
  projectTrashReaper.stop();
  boardTrashReaper.stop();
  routeMarginAlarm.stop();
  // M4: do NOT stop the outbox yet. Jobs finishing during the worker drain below
  // write their credits commit/refund rows; if the drainer were already stopped
  // those rows would dangle (processed_at IS NULL) until the next process boots.
  // We flush + stop the outbox AFTER drainWorkers returns.
  await metricsServer.close();
  // Drain workers FIRST (wait for the in-flight job), bounded by a deadline so a
  // long render can't hang past the orchestrator grace; force-close on timeout
  // and let the reapers + outbox recover (INF-12). Only then tear down the
  // producer queues / connection / pool, so nothing is mid-flight at disconnect.
  const drain = await drainWorkers(
    [commitWorker, refundWorker, jobsWorker, studioRenderWorker, authEmailWorker, noopWorker],
    SHUTDOWN_DRAIN_TIMEOUT_MS,
    log,
  );
  log.info({ drain }, 'workers drained');
  // M4: flush outbox rows produced during the drain window, THEN stop it. Bounded
  // loop so a steady trickle can't hang shutdown; anything still pending is
  // recovered by the next process's drainer (the rows stay processed_at IS NULL).
  for (let i = 0; i < 5; i++) {
    if ((await outbox.drain().catch(() => 0)) === 0) break;
  }
  outbox.stop();
  await Promise.allSettled([
    commitQueue.close(),
    refundQueue.close(),
    jobRunQueue.close(),
    studioRenderQueue.close(),
    authEmailQueue.close(),
  ]);
  await closeEventPublisher();
  await connection.quit();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
