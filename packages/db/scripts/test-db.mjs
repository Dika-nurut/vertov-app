#!/usr/bin/env node
// Ephemeral test database for the zero-spend integration harness (T3/T10).
//
// The dev DB currently DOUBLES as the test DB, so integration tests mutate dev
// data (the beta-invite/model-seed assertions already broke on this). This
// script stands up a SEPARATE database on the same postgres server, freshly
// migrated, that tests point DATABASE_URL at — so a run never touches dev data
// and is reproducible from a clean schema every time.
//
// Usage (from repo root):
//   pnpm --filter @seed/db test-db:reset   # drop + recreate seed_test, migrate
//   pnpm --filter @seed/db test-db:url      # print the test DATABASE_URL
//
// Idempotent: `reset` can run before every suite. Zero provider spend.
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const dbPkg = resolve(here, '..'); // packages/db
const repoRoot = resolve(dbPkg, '../..');
loadDotenv({ path: resolve(repoRoot, '.env') });

const TEST_DB = process.env.TEST_DB_NAME ?? 'seed_test';
const base = process.env.DATABASE_URL;
if (!base) {
  console.error('test-db: DATABASE_URL is required (set in repo-root .env)');
  process.exit(1);
}

// This command drops and recreates TEST_DB. Refuse the persistent developer
// stack before opening an admin connection; the top-level test-all harness
// supplies an alternate tmpfs Postgres endpoint and passes this guard.
process.env.TEST_DB_ADMIN_MODE = '1';
const { assertSafeTestEnvironment } = await import('../../../scripts/test-env-guard.mjs');
assertSafeTestEnvironment();

const baseUrl = new URL(base);
const adminUrl = new URL(base);
adminUrl.pathname = '/postgres'; // connect to the always-present admin db
const testUrl = new URL(base);
testUrl.pathname = `/${TEST_DB}`;

function testDatabaseUrl() {
  return testUrl.toString();
}

async function reset() {
  if (baseUrl.pathname === `/${TEST_DB}`) {
    throw new Error(`refusing to reset: dev DATABASE_URL already points at ${TEST_DB}`);
  }
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }
  console.log(`test-db: recreated ${TEST_DB}`);

  // Run drizzle migrations into the fresh DB via the existing migrate script,
  // with DATABASE_URL overridden for the child process only.
  const res = spawnSync('pnpm', ['--filter', '@seed/db', 'migrate'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });
  if (res.status !== 0) {
    throw new Error(`test-db: migrations failed (exit ${res.status})`);
  }
  console.log(`test-db: migrated ${TEST_DB}`);
}

const cmd = process.argv[2] ?? 'reset';
if (cmd === 'url') {
  process.stdout.write(testDatabaseUrl());
} else if (cmd === 'reset') {
  await reset();
} else {
  console.error(`test-db: unknown command '${cmd}' (reset|url)`);
  process.exit(1);
}
