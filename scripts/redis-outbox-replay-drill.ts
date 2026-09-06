#!/usr/bin/env node
/**
 * Disposable Redis restart + durable outbox replay drill.
 *
 * Safety boundary: this command refuses non-loopback/non-test PostgreSQL and
 * requires READINESS_REDIS_DRILL=1. It owns one explicitly named Redis
 * container and deletes only that container in finally. It never connects to
 * the developer or production Redis instance.
 *
 * Run from the worker dependency context, for example:
 *   READINESS_REDIS_DRILL=1 \
 *   DATABASE_URL=postgres://seedtest:...@127.0.0.1:55434/seed_test \
 *   REDIS_DRILL_PORT=56899 \
 *   pnpm --filter @seed/worker exec tsx ../../scripts/redis-outbox-replay-drill.ts
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { db, outboxJobs, pool } from '@seed/db';
import { startOutboxDrainer } from '../packages/credits/src/outbox.ts';
import { JOB_RUN_QUEUE } from '../packages/credits/src/queues.ts';

const ack = process.env.READINESS_REDIS_DRILL;
if (ack !== '1') {
  throw new Error('set READINESS_REDIS_DRILL=1 to run the disposable drill');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const database = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost'].includes(database.hostname)) {
  throw new Error('refusing non-loopback DATABASE_URL');
}
if (!/(test|scratch|drill)/i.test(database.pathname)) {
  throw new Error('refusing a database URL without a test/scratch/drill database name');
}

const port = Number(process.env.REDIS_DRILL_PORT ?? 56899);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('REDIS_DRILL_PORT must be an unprivileged TCP port');
}
if ([6380, 56380].includes(port)) {
  throw new Error('refusing developer/test Redis port');
}

const runId = `redis-outbox-${Date.now()}-${randomUUID().slice(0, 8)}`;
const container = `seed-${runId}`;
const redisUrl = `redis://127.0.0.1:${port}`;
const markerKey = `${runId}:aof-marker`;
const markerValue = `${runId}:persisted`;
// BullMQ custom IDs deliberately reject `:`; keep this delimiter-safe because
// the production outbox uses the same value as its replay identity.
const jobId = `${runId}-job`;
const log = { info() {}, warn() {}, error() {} } as never;
let containerStarted = false;
let rowId: string | null = null;

function docker(args: string[], stdio: 'pipe' | 'ignore' = 'pipe'): string {
  const output = execFileSync('docker', args, { encoding: 'utf8', stdio });
  return typeof output === 'string' ? output.trim() : '';
}

function waitForRedis(): void {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if (docker(['exec', container, 'redis-cli', 'ping']) === 'PONG') return;
    } catch {
      // The container is still starting.
    }
    execFileSync('sleep', ['1'], { stdio: 'ignore' });
  }
  throw new Error('Redis did not become ready');
}

async function waitForHostRedis(): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const client = new IORedis(redisOptions());
      await client.ping();
      await client.quit().catch(() => client.disconnect());
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('Redis host port did not become reachable');
}

function redisOptions() {
  return {
    host: '127.0.0.1',
    port,
    maxRetriesPerRequest: 1,
    connectTimeout: 700,
    retryStrategy: () => null,
  } as const;
}

function queue(): Queue {
  return new Queue(JOB_RUN_QUEUE, { connection: redisOptions() });
}

async function redisSet(key: string, value: string): Promise<void> {
  const client = new IORedis(redisOptions());
  try {
    await client.set(key, value);
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}

async function redisGet(key: string): Promise<string | null> {
  const client = new IORedis(redisOptions());
  try {
    return await client.get(key);
  } finally {
    await client.quit().catch(() => client.disconnect());
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'com.vertov.readiness-drill=redis-outbox-replay',
    '-p',
    `127.0.0.1:${port}:6379`,
    'redis:7-alpine',
    'redis-server',
    '--appendonly',
    'yes',
    '--appendfsync',
    'always',
    '--save',
    '60',
    '1',
  ]);
  containerStarted = true;
  waitForRedis();
  await waitForHostRedis();
  await redisSet(markerKey, markerValue);

  rowId = await db.transaction(async (tx) => {
    const id = `drill-${runId}`;
    await tx.insert(outboxJobs).values({
      id,
      queueName: JOB_RUN_QUEUE,
      jobId,
      payload: { readinessDrill: runId },
    });
    return id;
  });

  // Make the first drainer attempt observe a real outage from the beginning.
  // Starting the drainer before stopping Redis would introduce a race where
  // its eager background pass can win before the simulated outage begins.
  docker(['stop', container], 'ignore');
  const drainer = startOutboxDrainer({
    log,
    // Create a fresh producer connection per attempt. This is intentional: a
    // Redis outage must not pin the drainer to a dead IORedis connection.
    queues: {
      [JOB_RUN_QUEUE]: {
        add: async (name: string, payload: Record<string, unknown>, options: object) => {
          const q = queue();
          try {
            return await q.add(name, payload, options);
          } finally {
            await q.close();
          }
        },
      } as unknown as Queue,
    },
    intervalMs: 3_600_000,
    maxAttempts: 3,
  });
  drainer.stop();

  // The production drainer starts one eager pass on construction. Let that
  // failed pass settle before the explicit outage assertion below.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const outageStartedAt = Date.now();
  await drainer.drain();
  const afterOutage = await db
    .select({ attempts: outboxJobs.attempts, processedAt: outboxJobs.processedAt })
    .from(outboxJobs)
    .where(eq(outboxJobs.id, rowId));
  if (afterOutage[0]?.processedAt != null || (afterOutage[0]?.attempts ?? 0) < 1) {
    throw new Error('outbox row did not remain pending after Redis outage');
  }

  docker(['start', container]);
  waitForRedis();
  await waitForHostRedis();
  const restartMs = Date.now() - outageStartedAt;
  await drainer.drain();
  const afterReplay = await db
    .select({ attempts: outboxJobs.attempts, processedAt: outboxJobs.processedAt })
    .from(outboxJobs)
    .where(eq(outboxJobs.id, rowId));
  if (!afterReplay[0]?.processedAt)
    throw new Error('outbox row did not replay after Redis recovery');

  const q = queue();
  try {
    const job = await q.getJob(jobId);
    if (!job) throw new Error('replayed BullMQ job was not found');
    await drainer.drain();
    const sameJob = await q.getJob(jobId);
    const counts = await q.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    if (!sameJob || sameJob.id !== jobId || counts.waiting !== 1) {
      throw new Error('deterministic replay did not leave exactly one queued job');
    }
    const markerAfterRestart = await redisGet(markerKey);
    if (markerAfterRestart !== markerValue) throw new Error('AOF marker did not survive restart');

    console.log(
      JSON.stringify(
        {
          status: 'passed',
          startedAt,
          finishedAt: new Date().toISOString(),
          redis: { container, port, aof: true, markerPersisted: true, restartMs },
          outbox: {
            rowId,
            attemptsBeforeRecovery: afterOutage[0]?.attempts,
            attemptsAfterRecovery: afterReplay[0]?.attempts,
            processedAfterRecovery: true,
            deterministicJobId: jobId,
            waitingJobsForDrillQueue: counts.waiting,
          },
          productionTouched: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await q.remove(jobId).catch(() => {});
    await q.close();
  }
}

async function cleanup(): Promise<void> {
  if (rowId) {
    await db
      .delete(outboxJobs)
      .where(and(eq(outboxJobs.id, rowId), eq(outboxJobs.jobId, jobId)))
      .catch(() => {});
  }
  if (containerStarted) docker(['rm', '-f', container], 'ignore');
  await pool.end();
}

main()
  .catch((error: unknown) => {
    console.error(
      `redis-outbox-replay-drill: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  })
  .finally(cleanup);
