import { defineConfig } from 'vitest/config';

/**
 * Default (unit) project — pure logic, no infra. The integration specs
 * (`*.integration.test.ts`) are excluded here and run by the separate
 * vitest.integration.config.ts so `pnpm test` stays fast and infra-free.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
