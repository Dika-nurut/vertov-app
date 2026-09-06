#!/usr/bin/env node
// Audit-auth-bypass safety guard: the switch must be fail-closed by default,
// loopback-bound, and absent from every committed/provisioned environment.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mw = readFileSync(resolve(repoRoot, 'apps/web/middleware.ts'), 'utf8');

// 1. Fail-closed default: bypass requires a NON-EMPTY env value...
assert.match(mw, /AUDIT_AUTH_BYPASS \?\? ''/);
assert.match(mw, /\.length > 0/);
// ...AND a loopback host (localhost/127.0.0.1 only).
assert.ok(mw.includes('127'), 'loopback IPv4 present');
assert.ok(mw.includes('localhost'), 'loopback hostname present');
assert.ok(mw.includes("req.headers.get('host')"), 'host check present');
// 2. The session redirect still exists for everyone else.
assert.match(mw, /hasSession/);
assert.match(mw, /pathname = '\/login'/);
// 3. No committed env file may set the switch.
for (const f of readdirSync(repoRoot)) {
  if (/^\.env(\.|$)/.test(f) && existsSync(resolve(repoRoot, f))) {
    const text = readFileSync(resolve(repoRoot, f), 'utf8');
    assert.doesNotMatch(text, /AUDIT_AUTH_BYPASS\s*=\s*\S/, `${f} must not set the switch`);
  }
}
// 4. No infra/compose provisioning may reference the switch.
for (const f of ['infra/compute/docker-compose.app.yml', 'docker/docker-compose.test.yml']) {
  const p = resolve(repoRoot, f);
  if (existsSync(p)) assert.doesNotMatch(readFileSync(p, 'utf8'), /AUDIT_AUTH_BYPASS/, f);
}
// 5. Docs that mention it must carry the restore rule.
assert.match(mw, /RESTORE/);

console.log('audit-auth safety checks: 5/5 passed');
