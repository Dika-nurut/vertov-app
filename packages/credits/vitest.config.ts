import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['../../scripts/test-env-guard.mjs'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
