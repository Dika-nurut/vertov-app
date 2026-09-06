#!/usr/bin/env node
/**
 * Zero-I/O contract checks for the explicit Phase 5 production browser walk.
 *
 * The walk can create a disposable account and real script/Board rows, so it
 * must be opt-in and must bind its assertions to the exact release served by
 * /ready. This guard checks those safety properties without launching a
 * browser or contacting a production host.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = readFileSync(
  resolve(repoRoot, 'apps/web/e2e/_phase5-production-browser.mjs'),
  'utf8',
);

assert.match(source, /PHASE5_PROD_RUN/);
assert.match(source, /process\.env\.PHASE5_EXPECTED_RELEASE\?\.trim\(\)/);
assert.match(source, /\^\[0-9a-f\]\{40\}\$/u);
assert.doesNotMatch(source, /7d075be237569012756cc22856014e048b12747b/);
assert.doesNotMatch(source, /vertov-phase5-prod-browser-20260827/);
assert.match(source, /PHASE5_PROD_VIEWPORT/);
assert.match(source, /viewport,\n\s*ignoreHTTPSErrors/);
assert.match(source, /https:\/\//);
assert.match(source, /Paid AI endpoints are\n\/\/ intercepted/);

console.log('Phase 5 production browser safety checks: 10/10 passed (zero I/O)');
