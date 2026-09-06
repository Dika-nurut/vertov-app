#!/usr/bin/env node
/**
 * Safe, zero-spend Boards release-test entry point.
 *
 * Modes:
 *   quick   static + selected unit/contract/API gates
 *   e2e     production build + critical Chromium/Yandex journeys
 *   perf    production build + exact 200-node/300-edge cross-browser gate
 *   cleanup remove only labelled disposable Boards containers and verify ports
 *
 * Paid-provider and destructive staging tests are deliberately absent. They
 * require the separate authorization recorded by the release test plan.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem, freemem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'quick';
const allowedModes = new Set(['quick', 'e2e', 'perf', 'cleanup']);
if (!allowedModes.has(mode)) {
  throw new Error(`unknown mode ${JSON.stringify(mode)} (quick|e2e|perf|cleanup)`);
}

const runId = (process.env.BOARDS_RELEASE_RUN_ID ?? new Date().toISOString())
  .replace(/[^a-zA-Z0-9_.-]/g, '-')
  .slice(0, 80);
const evidenceDir = resolve(
  root,
  process.env.BOARDS_RELEASE_EVIDENCE_DIR ??
    `docs/evidence/product-testing/boards/2026-07-16/runs/${runId}`,
);
const pgName = 'seed-boards-release-postgres';
const redisName = 'seed-boards-release-redis';
const pgPort = Number(process.env.BOARDS_RELEASE_PG_PORT ?? 55434);
const redisPort = Number(process.env.BOARDS_RELEASE_REDIS_PORT ?? 56380);
const dbUrl = `postgres://seed:boards-release-only@127.0.0.1:${pgPort}/seed_test`;
const redisUrl = `redis://127.0.0.1:${redisPort}`;
const scopeLabel = 'boards-release';
const steps = [];
let infraStarted = false;
const hostAtStart = {
  cpuCount: cpus().length,
  loadAverage: loadavg(),
  totalMemoryBytes: totalmem(),
  freeMemoryBytes: freemem(),
};
const performanceMaximumLoad = Number(
  process.env.BOARDS_PERF_MAX_LOAD ?? Math.max(2, cpus().length * 0.6),
);

class EnvironmentFailure extends Error {}

function run(label, command, args, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  process.stdout.write(`\n[boards-release] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
  const step = {
    label,
    command: [command, ...args].map((value) =>
      /^POSTGRES_PASSWORD=/.test(value) ? 'POSTGRES_PASSWORD=<redacted>' : value,
    ),
    startedAt,
    durationMs: Math.round(performance.now() - started),
    exitCode: result.status ?? 1,
  };
  steps.push(step);
  if (step.exitCode !== 0 && options.required !== false) {
    throw new Error(`${label} failed with exit ${step.exitCode}`);
  }
  return step.exitCode === 0;
}

function output(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(label, check, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (check()) return;
    sleep(500);
  }
  throw new Error(`${label} did not become ready`);
}

function containerLabel(name) {
  return output('docker', [
    'inspect',
    '--format',
    '{{ index .Config.Labels "seed.test-scope" }}',
    name,
  ]);
}

function removeOwnedContainer(name) {
  const label = containerLabel(name);
  if (label === null) return;
  if (label !== scopeLabel) {
    throw new Error(`refusing to remove ${name}: unexpected seed.test-scope=${label}`);
  }
  run(`remove ${name}`, 'docker', ['rm', '-f', name]);
  if (containerLabel(name) !== null) throw new Error(`${name} still exists after cleanup`);
}

function portClosed(port) {
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (closed) => {
      socket.destroy();
      resolvePort(closed);
    };
    socket.setTimeout(500);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

function startInfra() {
  if (containerLabel(pgName) !== null || containerLabel(redisName) !== null) {
    throw new Error('Boards release containers already exist; run cleanup first');
  }
  run('start disposable PostgreSQL', 'docker', [
    'run',
    '-d',
    '--name',
    pgName,
    '--label',
    `seed.test-scope=${scopeLabel}`,
    '-e',
    'POSTGRES_USER=seed',
    '-e',
    'POSTGRES_PASSWORD=boards-release-only',
    '-e',
    'POSTGRES_DB=seed_test',
    '-p',
    `127.0.0.1:${pgPort}:5432`,
    '--tmpfs',
    '/var/lib/postgresql/data:rw,noexec,nosuid,size=1g',
    'postgres:16-alpine',
  ]);
  run('start disposable Redis', 'docker', [
    'run',
    '-d',
    '--name',
    redisName,
    '--label',
    `seed.test-scope=${scopeLabel}`,
    '-p',
    `127.0.0.1:${redisPort}:6379`,
    'redis:7-alpine',
  ]);
  infraStarted = true;
  waitFor('PostgreSQL', () =>
    Boolean(output('docker', ['exec', pgName, 'pg_isready', '-U', 'seed', '-d', 'seed_test'])),
  );
  waitFor('Redis', () => output('docker', ['exec', redisName, 'redis-cli', 'ping']) === 'PONG');
  run('migrate isolated database', 'pnpm', ['--filter', '@seed/db', 'migrate'], {
    env: { DATABASE_URL: dbUrl },
  });
  run('seed isolated model catalog', 'pnpm', ['--filter', '@seed/db', 'seed'], {
    env: { DATABASE_URL: dbUrl },
  });
}

async function cleanup() {
  removeOwnedContainer(redisName);
  removeOwnedContainer(pgName);
  for (const port of [pgPort, redisPort, 4310, 4311, 3209]) {
    if (!(await portClosed(port)))
      throw new Error(`cleanup verification failed: port ${port} open`);
  }
  infraStarted = false;
}

function relevantDiffSha256() {
  const diff = spawnSync(
    'git',
    [
      'diff',
      '--',
      '.github/workflows/ci.yml',
      '.github/workflows/deploy.yml',
      'scripts/deploy.sh',
      'apps/api/__tests__/boards-rev.test.ts',
      'apps/api/__tests__/boards-prod-hardening.test.ts',
      'apps/api/__tests__/boards-throttle.test.ts',
      'apps/api/__tests__/shot-plan-prompt.test.ts',
      'apps/api/src/boards.ts',
      'apps/api/src/board-snapshots.ts',
      'apps/api/src/rate-limit.ts',
      'apps/worker/src/board-trash-reaper.ts',
      'apps/web/app/boards',
      'apps/web/e2e/board-graph.spec.ts',
      'apps/web/e2e/board-hardening.spec.ts',
      'apps/web/e2e/mobile.spec.ts',
      'apps/web/e2e/board-shotlist.spec.ts',
      'apps/web/e2e/board-performance.spec.ts',
      'apps/web/e2e/board-release-candidate.spec.ts',
      'apps/web/e2e/prod-floor.sh',
      'apps/web/lib/board-document-graph.ts',
      'apps/web/lib/board-document-graph.test.ts',
      'apps/web/lib/board-persistence.ts',
      'apps/web/lib/board-persistence.test.ts',
      'apps/web/lib/board-recovery.ts',
      'apps/web/lib/board-recovery.test.ts',
      'apps/web/lib/board-autosave-engine.ts',
      'apps/web/lib/board-autosave-engine.test.ts',
      'apps/web/lib/board-graph-commands.ts',
      'apps/web/lib/board-graph-commands.test.ts',
      'apps/web/lib/board-connect-offers.test.ts',
      'apps/web/lib/run-plan.ts',
      'apps/web/lib/run-plan.test.ts',
      'apps/web/lib/shot-list.ts',
      'apps/web/lib/shot-list.test.ts',
      'apps/web/app/boards/[id]/BoardHistoryPanel.tsx',
      'packages/shared/src/board-contract.ts',
      'package.json',
      'scripts/test-boards-release.mjs',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (diff.status !== 0) throw new Error('could not fingerprint Boards diff');
  const hash = createHash('sha256').update(diff.stdout);
  for (const relative of [
    'scripts/test-boards-release.mjs',
    'packages/db/migrations/0106_boards_prod_hardening.sql',
    'packages/db/schema/boards.ts',
    'packages/db/migrations/meta/_journal.json',
    'packages/shared/src/board-contract.ts',
    'packages/shared/src/board-contract.test.ts',
    'packages/shared/src/__fixtures__/board-document.v1.json',
    'apps/api/src/boards.ts',
    'apps/api/src/board-snapshots.ts',
    'apps/api/src/rate-limit.ts',
    'apps/api/src/rate-limit.test.ts',
    'apps/api/src/scripts.ts',
    'apps/api/src/projects.ts',
    'apps/api/src/desk.ts',
    'apps/api/src/shot-plan-prompt.ts',
    'apps/api/__tests__/boards-rev.test.ts',
    'apps/api/__tests__/boards-prod-hardening.test.ts',
    'apps/api/__tests__/boards-throttle.test.ts',
    'apps/api/__tests__/shot-plan-prompt.test.ts',
    'apps/worker/src/board-trash-reaper.ts',
    'apps/worker/src/board-trash-reaper.integration.test.ts',
    'apps/worker/src/index.ts',
    'apps/web/app/boards/[id]/BoardHistoryPanel.tsx',
    'apps/web/app/boards/[id]/BoardRecoveryShell.tsx',
    'apps/web/e2e/board-hardening.spec.ts',
    'apps/web/e2e/mobile.spec.ts',
    'apps/web/lib/board-connect-offers.test.ts',
    'apps/api/__tests__/boards-ownership.test.ts',
    'apps/web/lib/board-diagnostics-cache.ts',
    'apps/web/lib/board-diagnostics-cache.test.ts',
  ]) {
    const file = resolve(root, relative);
    if (existsSync(file)) hash.update(relative).update(readFileSync(file));
  }
  return hash.digest('hex');
}

function writeRunRecord(result, error = null) {
  mkdirSync(evidenceDir, { recursive: true });
  const swap = existsSync('/proc/meminfo')
    ? Object.fromEntries(
        readFileSync('/proc/meminfo', 'utf8')
          .split('\n')
          .filter((line) => /^Swap(Total|Free):/.test(line))
          .map((line) => {
            const [key, value] = line.split(':');
            return [key, Number.parseInt(value, 10) * 1024];
          }),
      )
    : null;
  writeFileSync(
    resolve(evidenceDir, 'run.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        product: 'boards',
        mode,
        runId,
        result,
        error: error ? String(error) : null,
        candidate: {
          headSha: output('git', ['rev-parse', 'HEAD']),
          relevantWorktreeDiffSha256: relevantDiffSha256(),
          immutable: false,
        },
        environment: {
          atStart: hostAtStart,
          atEnd: {
            cpuCount: cpus().length,
            loadAverage: loadavg(),
            totalMemoryBytes: totalmem(),
            freeMemoryBytes: freemem(),
          },
          swap,
          dependencyMode: 'local disposable PostgreSQL/Redis; fixture providers; zero spend',
          productionBuildRequested: process.env.BOARDS_RELEASE_BUILD ?? '1',
        },
        steps,
        cleanup: { verified: !infraStarted },
        limitations: [
          'Shared host is not a controlled performance runner.',
          'Browser engines are Playwright Chromium and a Yandex-compatible Chromium user agent.',
          'No paid provider, physical-device, human, load, canary, or production claim.',
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function runQuick() {
  mkdirSync(evidenceDir, { recursive: true });
  run('web typecheck', 'pnpm', ['--filter', '@seed/web', 'typecheck']);
  run('API typecheck', 'pnpm', ['--filter', '@seed/api', 'typecheck']);
  run('shared typecheck', 'pnpm', ['--filter', '@seed/shared', 'typecheck']);
  run('shared Board contracts', 'pnpm', [
    '--filter',
    '@seed/shared',
    'exec',
    'vitest',
    'run',
    'src/board-contract.test.ts',
    'src/board-diagnostics.test.ts',
    '--reporter=json',
    '--outputFile',
    resolve(evidenceDir, 'shared.json'),
  ]);
  run('web Board units', 'pnpm', [
    '--filter',
    '@seed/web',
    'exec',
    'vitest',
    'run',
    'lib/board-connection-policy.test.ts',
    'lib/board-run-request.test.ts',
    'lib/board-runner.test.ts',
    'lib/board-persistence.test.ts',
    'lib/board-document-graph.test.ts',
    'lib/board-diagnostics-cache.test.ts',
    'lib/board-recovery.test.ts',
    'lib/board-autosave-engine.test.ts',
    'lib/board-graph-commands.test.ts',
    'lib/run-plan.test.ts',
    'lib/shot-list.test.ts',
    'lib/ref-ports.test.ts',
    '--reporter=json',
    '--outputFile',
    resolve(evidenceDir, 'web.json'),
  ]);
  run(
    'API Board integration',
    'pnpm',
    [
      '--filter',
      '@seed/api',
      'exec',
      'vitest',
      'run',
      '__tests__/boards-rev.test.ts',
      '__tests__/boards-ownership.test.ts',
      '__tests__/boards-prod-hardening.test.ts',
      '__tests__/boards-throttle.test.ts',
      '__tests__/boards-node-model-compatibility.test.ts',
      '__tests__/jobs-routes.test.ts',
      '__tests__/scenario-board-handoff.test.ts',
      '__tests__/storyboard-model.test.ts',
      '__tests__/storyboard-throttle.test.ts',
      'src/rate-limit.test.ts',
      '--reporter=json',
      '--outputFile',
      resolve(evidenceDir, 'api.json'),
    ],
    {
      env: {
        DATABASE_URL: dbUrl,
        REDIS_URL: redisUrl,
        // The quick floor does not start MinIO, but it must not inherit the
        // persistent developer endpoint now that DB-backed API tests fail
        // closed on developer services. Board tests use fixture storage.
        MINIO_ENDPOINT: 'http://127.0.0.1:59000',
      },
    },
  );
}

function runBrowser(browserMode) {
  mkdirSync(evidenceDir, { recursive: true });
  const defaults =
    browserMode === 'perf'
      ? ['e2e/board-performance.spec.ts', '--project=chromium', '--project=yandex']
      : [
          'e2e/boards-list-cjm.spec.ts',
          'e2e/board-graph.spec.ts',
          'e2e/board-hardening.spec.ts',
          'e2e/board-shotlist.spec.ts',
          'e2e/board-scenario-source.spec.ts',
          'e2e/board-release-candidate.spec.ts',
          '--project=chromium',
          '--project=yandex',
        ];
  const separator = process.argv.indexOf('--');
  const passthrough = separator >= 0 ? process.argv.slice(separator + 1) : defaults;
  run(
    `Boards ${browserMode} production floor`,
    'bash',
    ['apps/web/e2e/prod-floor.sh', ...passthrough, '--retries=0', '--reporter=json'],
    {
      env: {
        BOARDS_RELEASE: '1',
        BUILD: process.env.BOARDS_RELEASE_BUILD ?? '1',
        TEST_DATABASE_URL: dbUrl,
        // The release-only recovery spec uses the same isolated database from
        // the Playwright worker to poison a fixture row and exercise the real
        // server-rendered recovery shell. Never point this at the developer DB.
        DATABASE_URL: dbUrl,
        TEST_REDIS_URL: redisUrl,
        BOARDS_EVIDENCE_DIR: resolve(evidenceDir, 'screenshots'),
        PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(evidenceDir, 'playwright.json'),
        ...(browserMode === 'perf' ? { BOARDS_PERF_MAX_LOAD: String(performanceMaximumLoad) } : {}),
      },
    },
  );
}

let result = 'FAIL';
let failure = null;
try {
  if (mode === 'cleanup') {
    await cleanup();
    result = 'PASS';
  } else {
    if (mode === 'perf') {
      const currentLoad = loadavg()[0];
      if (currentLoad > performanceMaximumLoad) {
        throw new EnvironmentFailure(
          `performance runner unavailable: load1 ${currentLoad.toFixed(2)} exceeds ${performanceMaximumLoad.toFixed(2)}`,
        );
      }
    }
    for (const port of [pgPort, redisPort, 4310, 4311, 3209]) {
      if (!(await portClosed(port))) {
        throw new Error(`preflight failed: required isolated port ${port} is already open`);
      }
    }
    startInfra();
    if (mode === 'quick') runQuick();
    else runBrowser(mode);
    result = 'PASS';
  }
} catch (error) {
  failure = error;
  if (
    error instanceof EnvironmentFailure ||
    (mode === 'perf' && loadavg()[0] > performanceMaximumLoad)
  ) {
    result = 'ENVIRONMENT_FAILURE';
  }
  process.stderr.write(`[boards-release] FAIL: ${String(error)}\n`);
} finally {
  if (mode !== 'cleanup' && process.env.BOARDS_KEEP_INFRA !== '1') {
    try {
      await cleanup();
    } catch (cleanupError) {
      failure ??= cleanupError;
      result = 'CLEANUP_FAILURE';
      process.stderr.write(`[boards-release] CLEANUP FAIL: ${String(cleanupError)}\n`);
    }
  }
  writeRunRecord(result, failure);
}

process.exit(failure ? 1 : 0);
