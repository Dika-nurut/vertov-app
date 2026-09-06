import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // API files share the same integration database and several assert global
    // counts. Running files concurrently lets unrelated cleanup race those
    // assertions, so keep file-level execution deterministic.
    fileParallelism: false,
    setupFiles: ['../../scripts/test-env-guard.mjs'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
