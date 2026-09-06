#!/usr/bin/env node
// Alertmanager renderer guard: chat_id must render bare-numeric (amtool
// rejects quoted numerics), placeholders must never survive, output stays 0600.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const script = join(repoRoot, 'infra/observability/render-alertmanager-config.sh');

function render(chatId) {
  const dir = mkdtempSync(join(tmpdir(), 'am-render-'));
  const out = join(dir, 'alertmanager.yml');
  const r = spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ALERT_TELEGRAM_BOT_TOKEN: 'DUMMY-LOCAL-ONLY',
      ALERT_TELEGRAM_CHAT_ID: chatId,
      ALERT_TELEGRAM_PROXY_URL: 'http://127.0.0.1:9',
      ALERT_FALLBACK_WEBHOOK_URL: 'http://127.0.0.1:9/hook',
      ALERTMANAGER_CONFIG_OUT: out,
    },
  });
  assert.equal(r.status, 0, `renderer failed for chat ${chatId}: ${r.stderr}`);
  return { out, text: readFileSync(out, 'utf8'), mode: statSync(out).mode & 0o777 };
}

const numeric = render('-123456');
assert.match(numeric.text, /^(\s*)chat_id: -123456$/m);
assert.doesNotMatch(numeric.text, /PLACEHOLDER/);
assert.equal(numeric.mode, 0o600);

const channel = render('@vertov_alerts');
assert.match(channel.text, /^(\s*)chat_id: '@vertov_alerts'$/m);

console.log('alertmanager render checks: 3/3 passed');
