#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const harness = readFileSync(resolve(repoRoot, 'scripts/test-all.mjs'), 'utf8');
const compose = readFileSync(resolve(repoRoot, 'docker/docker-compose.test.yml'), 'utf8');

assert.match(harness, /docker\/docker-compose\.test\.yml/);
assert.doesNotMatch(harness, /docker\/docker-compose\.yml/);
assert.match(harness, /developerPorts/);
assert.match(harness, /must not target a developer-stack port/);
assert.match(harness, /TEST_PG_PORT/);
assert.match(harness, /DATABASE_URL: testDatabaseBaseUrl/);
assert.match(harness, /seed isolated test DB/);
assert.match(harness, /seed isolated beta invites/);
assert.match(harness, /restore canonical test catalog/);
assert.match(harness, /BETA_INVITES_SILENT/);
assert.doesNotMatch(compose, /\/root\/seed-prod\/data/);
assert.doesNotMatch(compose, /container_name:/);
assert.match(compose, /tmpfs:/);
assert.match(compose, /TEST_MINIO_PORT/);
assert.match(harness, /SEED_TEST_ALL_LOCKED/);
assert.match(harness, /worktreeSlug/);
assert.match(harness, /resolveTestPorts/);
assert.match(harness, /refreshTestInfra/);

console.log('test-all safety checks: 17/17 passed');
