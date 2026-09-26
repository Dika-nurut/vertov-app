import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  // Vitest 3 needs the repo-level environment guard explicitly allowed by the
  // package server root before it can transform the setup module.
  server: { fs: { allow: [repoRoot] } },
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
