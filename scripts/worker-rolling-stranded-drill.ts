#!/usr/bin/env node
/**
 * Isolated BullMQ operations drill for INF-12/INF-21.
 *
 * The drill proves two transport-level properties without touching the app
 * database, production Redis, provider APIs, credits, or user data:
 *   1. a second worker keeps a queue serviced while the first drains on SIGTERM;
 *   2. a second worker recovers a job whose first worker is killed while the
 *      handler is active and its BullMQ lock expires.
 *
 * Safety is deliberately fail-closed. READINESS_WORKER_DRILL=1 is required,
 * the Redis port must be an explicitly non-standard loopback port, and cleanup
 * can address only the uniquely named container created by this process.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const runId = randomUUID().replaceAll('-', '').slice(0, 16);
const redisPort = Number(process.env.WORKER_DRILL_PORT ?? 56901);
const redisContainer = `seed-worker-drill-redis-${runId}`;
const rollingQueueName = `seed.ops.rolling.${runId}`;
const strandedQueueName = `seed.ops.stranded.${runId}`;
const redisUrl = `redis://127.0.0.1:${redisPort}`;

const forbiddenPorts = new Set([6379, 6380, 55432, 55433, 55434, 56380, 56899]);
if (process.env.READINESS_WORKER_DRILL !== '1') {
  throw new Error('refusing worker drill: set READINESS_WORKER_DRILL=1 explicitly');
}
if (!Number.isInteger(redisPort) || redisPort < 1024 || redisPort > 65535) {
  throw new Error(`refusing worker drill: invalid loopback port ${redisPort}`);
}
if (forbiddenPorts.has(redisPort)) {
  throw new Error(`refusing worker drill: port ${redisPort} is reserved for another stack`);
}

type DrillEvent = {
  event: string;
  role?: string;
  jobId?: string;
  [key: string]: unknown;
};

type Agent = {
  role: string;
  child: ChildProcess;
  events: DrillEvent[];
  waiters: Array<{
    predicate: (event: DrillEvent) => boolean;
    resolve: (event: DrillEvent) => void;
  }>;
  exit: Promise<number | null>;
};

const childSource = String.raw`
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

const role = process.env.DRILL_ROLE;
const mode = process.env.DRILL_MODE;
const queueName = process.env.DRILL_QUEUE;
const redisUrl = process.env.DRILL_REDIS_URL;
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const emit = (event, extra = {}) => process.stdout.write(JSON.stringify({ event, role, ...extra }) + '\n');
let stopping = false;

const worker = new Worker(queueName, async (job) => {
  emit('active', { jobId: job.id, attempt: job.attemptsMade });
  const holdMs = mode === 'stranded' && role === 'primary'
    ? 10000
    : Number(job.data?.holdMs ?? 150);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  emit('handler_done', { jobId: job.id });
  return { ok: true, role };
}, {
  connection,
  concurrency: 1,
  lockDuration: mode === 'stranded' ? 1000 : 5000,
  stalledInterval: 500,
  maxStalledCount: 1,
});

worker.on('stalled', (jobId) => emit('stalled', { jobId }));
worker.on('error', (error) => emit('error', { message: String(error?.message ?? error) }));

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  emit('shutdown_start', { signal });
  await worker.close();
  await connection.quit();
  emit('shutdown_done');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await worker.waitUntilReady();
emit('ready');
`;

function runDocker(args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  label: string,
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function startAgent(role: string, mode: string, queueName: string): Agent {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: `${root}/apps/worker`,
    env: {
      ...process.env,
      DRILL_ROLE: role,
      DRILL_MODE: mode,
      DRILL_QUEUE: queueName,
      DRILL_REDIS_URL: redisUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agent: Agent = {
    role,
    child,
    events: [],
    waiters: [],
    exit: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
  };
  const lines = createInterface({ input: child.stdout! });
  lines.on('line', (line) => {
    try {
      const event = JSON.parse(line) as DrillEvent;
      agent.events.push(event);
      for (const waiter of [...agent.waiters]) {
        if (!waiter.predicate(event)) continue;
        agent.waiters = agent.waiters.filter((candidate) => candidate !== waiter);
        waiter.resolve(event);
      }
    } catch {
      // Keep the parent output structured; child diagnostics are not evidence.
    }
  });
  child.stderr?.on('data', () => undefined);
  return agent;
}

async function waitForEvent(
  agent: Agent,
  predicate: (event: DrillEvent) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<DrillEvent> {
  const existing = agent.events.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    agent.waiters.push(waiter);
    const timer = setTimeout(() => {
      agent.waiters = agent.waiters.filter((candidate) => candidate !== waiter);
      reject(new Error(`timeout waiting for ${agent.role} ${label}`));
    }, timeoutMs);
    const originalResolve = waiter.resolve;
    waiter.resolve = (event) => {
      clearTimeout(timer);
      originalResolve(event);
    };
  });
}

async function waitForCompleted(queue: Queue, ids: string[], timeoutMs: number): Promise<void> {
  await waitUntil(
    `${ids.length} jobs completed`,
    async () => {
      const states = await Promise.all(ids.map(async (id) => (await queue.getJob(id))?.getState()));
      return states.every((state) => state === 'completed');
    },
    timeoutMs,
  );
}

async function stopAgent(agent: Agent, signal: NodeJS.Signals = 'SIGTERM'): Promise<number | null> {
  if (agent.child.exitCode === null) agent.child.kill(signal);
  return agent.exit;
}

let redis: IORedis | undefined;
let rollingQueue: Queue | undefined;
let strandedQueue: Queue | undefined;
let agents: Agent[] = [];
let containerStarted = false;

async function main(): Promise<void> {
  try {
    try {
      runDocker(['inspect', redisContainer]);
      throw new Error(
        `refusing worker drill: owned container name already exists: ${redisContainer}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('refusing worker drill: owned'))
        throw error;
    }

    runDocker([
      'run',
      '-d',
      '--name',
      redisContainer,
      '--label',
      'seed.readiness.drill=worker-rolling-stranded',
      '-p',
      `127.0.0.1:${redisPort}:6379`,
      'redis:7-alpine',
      '--save',
      '',
      '--appendonly',
      'no',
    ]);
    containerStarted = true;
    redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    await waitUntil('isolated Redis ping', async () => (await redis!.ping()) === 'PONG', 15_000);
    rollingQueue = new Queue(rollingQueueName, { connection: redis });
    strandedQueue = new Queue(strandedQueueName, { connection: redis });

    // Rolling restart: the old worker has active no-op load, then drains while
    // the new worker continues the same queue.
    const oldRolling = startAgent('old', 'rolling', rollingQueueName);
    agents.push(oldRolling);
    await waitForEvent(oldRolling, (event) => event.event === 'ready', 'ready');
    const rollingIds = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        rollingQueue!.add('no-spend-load', { holdMs: 120 }, { jobId: `rolling-${runId}-${index}` }),
      ),
    ).then((jobs) => jobs.map((job) => String(job.id)));
    await waitForEvent(oldRolling, (event) => event.event === 'active', 'active load');
    const newRolling = startAgent('new', 'rolling', rollingQueueName);
    agents.push(newRolling);
    await waitForEvent(newRolling, (event) => event.event === 'ready', 'ready');
    const oldExit = await stopAgent(oldRolling);
    await waitForCompleted(rollingQueue, rollingIds, 20_000);

    // Stranded recovery: kill the primary while its handler is active. A second
    // worker must observe the expired lock, requeue the job, and complete it.
    const primary = startAgent('primary', 'stranded', strandedQueueName);
    agents.push(primary);
    await waitForEvent(primary, (event) => event.event === 'ready', 'ready');
    const strandedJob = await strandedQueue.add(
      'kill-during-handler',
      { holdMs: 10_000 },
      { jobId: `stranded-${runId}` },
    );
    await waitForEvent(
      primary,
      (event) => event.event === 'active' && event.jobId === strandedJob.id,
      'active stranded job',
    );
    const killedAt = Date.now();
    const primaryExit = await stopAgent(primary, 'SIGKILL');
    if (primaryExit === 0) throw new Error('stranded primary unexpectedly exited cleanly');
    const recovery = startAgent('recovery', 'stranded', strandedQueueName);
    agents.push(recovery);
    await waitForEvent(recovery, (event) => event.event === 'ready', 'ready');
    await waitForEvent(
      recovery,
      (event) => event.event === 'active' && event.jobId === strandedJob.id,
      'recovered active job',
      15_000,
    );
    await waitForCompleted(strandedQueue, [String(strandedJob.id)], 15_000);
    const recoveredAfterKillMs = Date.now() - killedAt;
    const recovered = await strandedQueue.getJob(strandedJob.id);

    await stopAgent(newRolling);
    await stopAgent(recovery);
    agents = [];
    for (const id of [...rollingIds, String(strandedJob.id)]) {
      await (id.startsWith('rolling-') ? rollingQueue : strandedQueue)?.remove(id);
    }

    console.log(
      JSON.stringify({
        status: 'passed',
        productionTouched: false,
        providerCalls: 0,
        moneyMutations: 0,
        rollingRestart: {
          jobs: rollingIds.length,
          oldWorkerExitCode: oldExit,
          newWorkerKeptQueueServiced: true,
          allJobsCompleted: true,
        },
        strandedJob: {
          primaryKilled: primaryExit !== 0,
          recoveredBySecondWorker: true,
          attemptsMade: recovered?.attemptsMade ?? null,
          recoveredAfterKillMs,
        },
        exactTemporaryRedis: redisContainer,
        exactTemporaryQueues: [rollingQueueName, strandedQueueName],
        cleanup: 'jobs removed; Redis container removed by finally',
      }),
    );
  } finally {
    for (const agent of agents) {
      await stopAgent(agent).catch(() => undefined);
    }
    await rollingQueue?.close().catch(() => undefined);
    await strandedQueue?.close().catch(() => undefined);
    await redis?.quit().catch(() => undefined);
    if (containerStarted) {
      try {
        runDocker(['rm', '-f', redisContainer]);
      } catch {
        // Preserve the original failure; cleanup is scoped to this exact name.
      }
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
