import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Vitest setup for the mock-gateway integration harness (T3). Runs BEFORE any
 * `@seed/db` / storage import, so it can redirect the process at the EPHEMERAL
 * test DB + local-fetchable asset URLs + the zero-spend mock gateway. This is
 * what fixes the dev/test DB bleed: integration tests never touch dev data.
 *
 * Pre-req: `pnpm db:test-db:reset` created + migrated the test DB first
 * (the test:all orchestrator and the worker `test:integration` script do this).
 */
const here = fileURLToPath(new URL('.', import.meta.url));
loadDotenv({ path: resolve(here, '../../../../.env') });

const TEST_DB = process.env['TEST_DB_NAME'] ?? 'seed_test';
if (process.env['DATABASE_URL']) {
  const u = new URL(process.env['DATABASE_URL']);
  if (u.pathname !== `/${TEST_DB}`) {
    u.pathname = `/${TEST_DB}`;
    process.env['DATABASE_URL'] = u.toString();
  }
}

// Mint asset URLs that point straight at local MinIO so a test can ffprobe a
// render output directly (the prod ASSET_PUBLIC_URL is browser-only).
process.env['ASSET_PUBLIC_URL'] = process.env['MINIO_PUBLIC_URL'] ?? 'http://127.0.0.1:9000';

// Any unset/unknown gateway resolves to the zero-spend mock.
process.env['PROVIDER_GATEWAY'] = process.env['PROVIDER_GATEWAY'] ?? 'mock';
