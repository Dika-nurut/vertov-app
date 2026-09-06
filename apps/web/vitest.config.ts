import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirror tsconfig's `"@/*": ["./*"]`. Unit specs that import an app component
  // inherit that component's own `@/...` imports, which vitest cannot resolve
  // without the alias. Vite defines `__dirname` inside config files.
  resolve: {
    alias: { '@': __dirname },
  },
  // Next compiles the app with the automatic JSX runtime, so components here do
  // not import React. tsconfig says `jsx: "preserve"`, which esbuild reads as
  // the classic transform and emits a bare `React.createElement` — fine while a
  // component is only imported, a ReferenceError the moment one is rendered.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    environment: 'node',
  },
});
