import { defineConfig } from 'vitest/config';

/**
 * Integration project (T3): mock-gateway canvas lifecycle + editor render over
 * the T2 corpus. Separate from the default `vitest run` (pure unit) because it
 * needs the docker infra (postgres/redis/minio) and the ephemeral test DB.
 *
 * Run via `pnpm --filter @seed/worker test:integration` (which resets the test
 * DB first), or the top-level `test:all` orchestrator.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['../../scripts/test-env-guard.mjs', 'src/test-support/integration-setup.ts'],
    // Real infra + ffmpeg renders — give them room and keep them serial so the
    // shared ephemeral DB isn't mutated by two specs at once.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
