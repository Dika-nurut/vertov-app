#!/usr/bin/env node
/**
 * Zero-I/O contract checks for the migration/readiness/rollback deploy gates.
 *
 * The real deploy script is executed with disposable fake `docker`, `pnpm`, and
 * `curl` commands. No Docker daemon, registry, database, network, or production
 * host is touched. This protects the failure behavior that shell inspection
 * alone cannot prove: migration failure never calls Compose, and an unhealthy
 * new tag restores the last successful tag while still failing the deploy job.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploySource = resolve(repoRoot, 'scripts/deploy.sh');
const deployWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/deploy.yml'), 'utf8');

// A broken image build must prevent the production job from becoming runnable.
// Keep this as a zero-I/O structural assertion alongside the shell contract.
assert.match(deployWorkflow, /fail-fast:\s*true/);
assert.match(deployWorkflow, /deploy:\n    needs: \[resolve, build-and-push\]/);
assert.match(
  deployWorkflow,
  /DEPLOY_PATH: \$\{\{ secrets\.DEPLOY_PATH \}\}\n\s+SEED_SITE_ADDRESS: \$\{\{ secrets\.SEED_SITE_ADDRESS \}\}/,
);
assert.doesNotMatch(deployWorkflow, /script_stop:/);

function executable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'seed-deploy-safety-'));
  const bin = resolve(root, 'bin');
  mkdirSync(bin);
  const deploy = resolve(root, 'deploy.sh');
  const log = resolve(root, 'calls.log');
  const ready = resolve(root, 'ready');
  writeFileSync(log, '');
  copyFileSync(deploySource, deploy);
  return { root, bin, deploy, log, ready };
}

function installFakes(ctx, { migrationFails = false } = {}) {
  executable(
    resolve(ctx.bin, 'docker'),
    `#!/usr/bin/env bash
set -u
printf 'docker tag=%s args=%s\\n' "\${SEED_IMAGE_TAG:-}" "$*" >>"${ctx.log}"
if [[ " $* " == *" up "* ]] && [[ "\${SEED_IMAGE_TAG:-}" == "old-sha" ]]; then
  touch "${ctx.ready}"
fi
if [[ " $* " == *" up "* ]] && [[ "\${SEED_IMAGE_TAG:-}" != "old-sha" ]] && [[ "\${FAKE_COMPOSE_START_FAIL:-0}" == "1" ]]; then
  exit 1
fi
exit 0
`,
  );
  executable(
    resolve(ctx.bin, 'pnpm'),
    `#!/usr/bin/env bash
printf 'pnpm %s\\n' "$*" >>"${ctx.log}"
${migrationFails ? 'exit 1' : 'exit 0'}
`,
  );
  executable(
    resolve(ctx.bin, 'curl'),
    `#!/usr/bin/env bash
test -f "${ctx.ready}"
`,
  );
}

function run(ctx, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SEED_REGISTRY;
  env.PATH = `${ctx.bin}:${process.env.PATH}`;
  return spawnSync('bash', [ctx.deploy], {
    cwd: ctx.root,
    env,
    encoding: 'utf8',
  });
}

function finish(ctx) {
  rmSync(ctx.root, { recursive: true, force: true });
}

// 1) The TLS/site guard fails before any fake command can run.
{
  const ctx = setup();
  try {
    installFakes(ctx);
    const env = {
      SEED_IMAGE_TAG: 'new-sha',
      SEED_LAST_DEPLOYED_TAG_FILE: '.last-deployed-tag',
      DEPLOY_READY_ATTEMPTS: '2',
      DEPLOY_READY_INTERVAL_SECONDS: '0',
    };
    const result = run(ctx, env);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /SEED_SITE_ADDRESS is required/);
    assert.equal(readFileSync(ctx.log, 'utf8'), '');
  } finally {
    finish(ctx);
  }
}

// 2) A migration failure never calls Compose and leaves the old pointer intact.
{
  const ctx = setup();
  try {
    installFakes(ctx, { migrationFails: true });
    writeFileSync(resolve(ctx.root, '.last-deployed-tag'), 'old-sha\n');
    const result = run(ctx, {
      SEED_SITE_ADDRESS: 'staging.invalid',
      SEED_IMAGE_TAG: 'new-sha',
      SEED_LAST_DEPLOYED_TAG_FILE: '.last-deployed-tag',
      DEPLOY_READY_ATTEMPTS: '2',
      DEPLOY_READY_INTERVAL_SECONDS: '0',
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(readFileSync(ctx.log, 'utf8'), /args=.* up /);
    assert.equal(readFileSync(resolve(ctx.root, '.last-deployed-tag'), 'utf8'), 'old-sha\n');
  } finally {
    finish(ctx);
  }
}

// 3) An unhealthy new tag is rolled back to the old tag, but the deploy remains
// failed so CI/operations cannot mistake recovery for a successful release.
{
  const ctx = setup();
  try {
    installFakes(ctx);
    writeFileSync(resolve(ctx.root, '.last-deployed-tag'), 'old-sha\n');
    const result = run(ctx, {
      SEED_SITE_ADDRESS: 'staging.invalid',
      SEED_IMAGE_TAG: 'new-sha',
      SEED_LAST_DEPLOYED_TAG_FILE: '.last-deployed-tag',
      DEPLOY_READY_ATTEMPTS: '2',
      DEPLOY_READY_INTERVAL_SECONDS: '0',
    });
    assert.notEqual(result.status, 0);
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /docker tag=new-sha args=.* up /);
    assert.match(calls, /docker tag=old-sha args=.* up /);
    assert.equal(readFileSync(resolve(ctx.root, '.last-deployed-tag'), 'utf8'), 'old-sha\n');
    assert.match(`${result.stdout}\n${result.stderr}`, /service restored to old-sha/);
  } finally {
    finish(ctx);
  }
}

// 4) A Compose start failure follows the same recovery path as a readiness
// failure, because an in-place replacement can be partial before Compose exits.
{
  const ctx = setup();
  try {
    installFakes(ctx);
    writeFileSync(resolve(ctx.root, '.last-deployed-tag'), 'old-sha\n');
    const result = run(ctx, {
      SEED_SITE_ADDRESS: 'staging.invalid',
      SEED_IMAGE_TAG: 'new-sha',
      SEED_LAST_DEPLOYED_TAG_FILE: '.last-deployed-tag',
      DEPLOY_READY_ATTEMPTS: '2',
      DEPLOY_READY_INTERVAL_SECONDS: '0',
      FAKE_COMPOSE_START_FAIL: '1',
    });
    assert.notEqual(result.status, 0);
    const calls = readFileSync(ctx.log, 'utf8');
    assert.match(calls, /docker tag=new-sha args=.* up /);
    assert.match(calls, /docker tag=old-sha args=.* up /);
    assert.equal(readFileSync(resolve(ctx.root, '.last-deployed-tag'), 'utf8'), 'old-sha\n');
    assert.match(`${result.stdout}\n${result.stderr}`, /service restored to old-sha/);
  } finally {
    finish(ctx);
  }
}

console.log('deploy safety checks: 5/5 passed (zero I/O)');
