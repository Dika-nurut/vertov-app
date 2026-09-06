#!/usr/bin/env node
/**
 * Fail closed when a DB-backed Vitest project is about to use the persistent
 * developer stack. The zero-spend test pyramid passes explicit alternate ports;
 * this guard protects direct package-test invocations as well.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
try {
  for (const line of readFileSync(resolve(here, '../.env'), 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
} catch {
  // A CI/test environment may intentionally provide all variables explicitly.
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEVELOPER_ENDPOINTS = new Map([
  ['DATABASE_URL', new Set(['5434'])],
  ['REDIS_URL', new Set(['6380'])],
  ['MINIO_ENDPOINT', new Set(['9000', '9001'])],
]);

function endpointLabel(url) {
  const port = url.port || '(default)';
  return `${url.hostname}:${port}`;
}

export function assertSafeTestEnvironment(env = process.env) {
  for (const [name, forbiddenPorts] of DEVELOPER_ENDPOINTS) {
    const raw = env[name];
    if (!raw) continue;

    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`test-env-safety: ${name} is not a valid URL`);
    }

    if (LOCAL_HOSTS.has(url.hostname) && forbiddenPorts.has(url.port)) {
      throw new Error(
        `test-env-safety: refusing ${name}=${endpointLabel(url)}; ` +
          'this is the persistent developer stack. Use test-all or an explicit isolated endpoint.',
      );
    }

    if (
      name === 'DATABASE_URL' &&
      LOCAL_HOSTS.has(url.hostname) &&
      decodeURIComponent(url.pathname).replace(/^\//, '') === 'seed' &&
      (url.port === '' || url.port === '5432')
    ) {
      throw new Error(
        `test-env-safety: refusing ${name} against local database "seed"; use an isolated test database`,
      );
    }
  }

  const expectedDb = env.TEST_DB_NAME;
  const databaseUrl = env.DATABASE_URL;
  if (expectedDb && databaseUrl) {
    const database = new URL(databaseUrl);
    const actual = decodeURIComponent(database.pathname).replace(/^\//, '');
    const isExplicitIsolatedAdmin =
      env.TEST_DB_ADMIN_MODE === '1' &&
      actual === 'seed' &&
      LOCAL_HOSTS.has(database.hostname) &&
      database.port !== '' &&
      database.port !== '5432' &&
      database.port !== '5434';
    if (actual && actual !== expectedDb && !isExplicitIsolatedAdmin) {
      throw new Error(
        `test-env-safety: DATABASE_URL selects "${actual}" but TEST_DB_NAME is "${expectedDb}"`,
      );
    }
  }
}

if (process.env.TEST_ENV_GUARD_AUTO !== '0') assertSafeTestEnvironment();
