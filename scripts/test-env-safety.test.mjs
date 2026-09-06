#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const guard = resolve(repoRoot, 'scripts/test-env-guard.mjs');
const importGuard = `import(${JSON.stringify(guard)})`;

function run(args, env) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

const blocked = run(['--input-type=module', '-e', importGuard], {
  DATABASE_URL: 'postgres://seed:password@127.0.0.1:5434/seed',
  REDIS_URL: 'redis://127.0.0.1:6380',
  MINIO_ENDPOINT: 'http://127.0.0.1:9000',
});
assert.notEqual(blocked.status, 0, 'developer endpoints must be rejected');
assert.match(`${blocked.stdout}\n${blocked.stderr}`, /test-env-safety/);

const isolated = run(['--input-type=module', '-e', importGuard], {
  DATABASE_URL: 'postgres://seedtest:password@127.0.0.1:55434/seed_test',
  REDIS_URL: 'redis://127.0.0.1:56380',
  MINIO_ENDPOINT: 'http://127.0.0.1:59000',
  TEST_DB_NAME: 'seed_test',
});
assert.equal(isolated.status, 0, isolated.stderr || isolated.stdout);

const isolatedAdmin = run(['--input-type=module', '-e', importGuard], {
  DATABASE_URL: 'postgres://seedtest:password@127.0.0.1:55434/seed',
  REDIS_URL: 'redis://127.0.0.1:56380',
  MINIO_ENDPOINT: 'http://127.0.0.1:59000',
  TEST_DB_NAME: 'seed_test',
  TEST_DB_ADMIN_MODE: '1',
});
assert.equal(isolatedAdmin.status, 0, isolatedAdmin.stderr || isolatedAdmin.stdout);

const mismatch = run(['--input-type=module', '-e', importGuard], {
  DATABASE_URL: 'postgres://seedtest:password@127.0.0.1:55434/other_db',
  REDIS_URL: 'redis://127.0.0.1:56380',
  MINIO_ENDPOINT: 'http://127.0.0.1:59000',
  TEST_DB_NAME: 'seed_test',
});
assert.notEqual(mismatch.status, 0, 'TEST_DB_NAME mismatch must be rejected');
assert.match(`${mismatch.stdout}\n${mismatch.stderr}`, /TEST_DB_NAME/);

const resetGuard = run([resolve(repoRoot, 'packages/db/scripts/test-db.mjs'), 'reset'], {
  DATABASE_URL: 'postgres://seed:password@127.0.0.1:5434/seed',
  REDIS_URL: 'redis://127.0.0.1:6380',
  MINIO_ENDPOINT: 'http://127.0.0.1:9000',
});
assert.notEqual(resetGuard.status, 0, 'test-db reset must reject developer endpoints');
assert.match(`${resetGuard.stdout}\n${resetGuard.stderr}`, /test-env-safety/);

console.log('test environment safety checks: 5/5 passed');
