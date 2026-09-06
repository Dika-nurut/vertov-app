#!/usr/bin/env node
// Zero-I/O contract checks for the repository backup scripts. Every external
// binary is replaced with a temporary fake, so this never reaches Postgres,
// S3, rclone, YC, or a provider.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname);

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'vertov-backup-safety-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  return { root, bin };
}

function fake(bin, name, body) {
  const path = join(bin, name);
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function run(script, args, { bin, env = {}, unset = [] } = {}) {
  const childEnv = {
    ...process.env,
    PATH: `${bin ?? ''}:${process.env.PATH ?? ''}`,
    DATABASE_URL: 'postgres://seed:password@127.0.0.1:5434/seed_test',
    ...env,
  };
  for (const key of unset) delete childEnv[key];
  const result = spawnSync('bash', [join(ROOT, script), ...args], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
  });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function writeEnvFile(path, lines) {
  writeFileSync(path, `${lines.join('\n')}\n`);
}

function assertStatus(result, status, label) {
  assert.equal(result.status, status, `${label}\n${result.output}`);
}

function mediaBackupChecks() {
  const { root, bin } = sandbox();
  try {
    const envFile = join(root, 'seed.env');
    const marker = join(root, 'rclone-invoked');
    writeEnvFile(envFile, []);
    fake(bin, 'rclone', `touch "$RCLONE_MARKER"; exit "${'${RCLONE_RC:-0}'}"`);

    const missing = run('scripts/media-backup.sh', [], {
      bin,
      env: { MEDIA_BACKUP_ENV_FILE: envFile, RCLONE_MARKER: marker },
      unset: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    });
    assertStatus(missing, 1, 'media backup must reject missing credentials');
    assert.match(missing.output, /AWS_ACCESS_KEY_ID is required/);
    assert.equal(existsSync(marker), false, 'rclone must not start without credentials');

    writeEnvFile(envFile, ['AWS_ACCESS_KEY_ID=test-access', 'AWS_SECRET_ACCESS_KEY=test-secret']);
    const failed = run('scripts/media-backup.sh', [], {
      bin,
      env: {
        MEDIA_BACKUP_ENV_FILE: envFile,
        RCLONE_MARKER: marker,
        RCLONE_RC: '23',
      },
    });
    assertStatus(failed, 23, 'media backup must propagate rclone failure');
    assert.match(failed.output, /rc=23/);

    const passed = run('scripts/media-backup.sh', [], {
      bin,
      env: { MEDIA_BACKUP_ENV_FILE: envFile, RCLONE_MARKER: marker, RCLONE_RC: '0' },
    });
    assertStatus(passed, 0, 'media backup success must remain successful');
    assert.match(passed.output, /rc=0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function restorePreflightChecks() {
  const { root, bin } = sandbox();
  try {
    const marker = join(root, 'unexpected-command');
    for (const command of ['aws', 'docker', 'pg_dump', 'pg_restore', 'psql']) {
      fake(bin, command, `touch "$COMMAND_MARKER"`);
    }
    const valid = run('scripts/pg-restore-drill.sh', ['--preflight'], {
      bin,
      env: { DRILL_DB: 'seed_restore_safety', COMMAND_MARKER: marker },
    });
    assertStatus(valid, 0, 'restore preflight should be no-I/O');
    assert.match(valid.output, /preflight OK/);
    assert.equal(existsSync(marker), false, 'preflight must not invoke external commands');

    const sourceUrl = 'postgres://seed:password@pooler.example:6432/seed';
    const adminUrl = 'postgres://seed:password@pooler.example:6432/seed';
    const pooler = run('scripts/pg-restore-drill.sh', ['--preflight'], {
      bin,
      env: {
        DATABASE_URL: sourceUrl,
        DRILL_ADMIN_DATABASE_URL: adminUrl,
        DRILL_DB: 'seed_restore_pooler',
        COMMAND_MARKER: marker,
      },
    });
    assertStatus(pooler, 0, 'pooler restore preflight should accept an explicit admin URL');
    assert.match(pooler.output, /source=postgres:\/\/pooler\.example:6432\/seed/);
    assert.match(pooler.output, /scratch=seed_restore_pooler/);

    const collision = run('scripts/pg-restore-drill.sh', ['--preflight'], {
      bin,
      env: {
        DATABASE_URL: 'postgres://seed:password@127.0.0.1:5434/seed_restore_safety',
        DRILL_DB: 'seed_restore_safety',
        COMMAND_MARKER: marker,
      },
    });
    assertStatus(collision, 2, 'restore preflight must reject source/scratch collision');
    assert.match(collision.output, /must differ from the source database/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function restoreFailureCleanupCheck() {
  const { root, bin } = sandbox();
  try {
    const psqlLog = join(root, 'psql.log');
    fake(bin, 'pg_dump', 'head -c 2048 /dev/zero');
    fake(
      bin,
      'pg_restore',
      `cat >/dev/null
if [[ " $* " == *" --list "* ]]; then exit 0; fi
exit 42`,
    );
    fake(
      bin,
      'psql',
      `printf '%s\\n' "$*" >> "$PSQL_LOG"
if [[ "$*" == *users_pii* ]]; then echo 0; elif [[ "$*" == *users_app* ]]; then echo '1|1|1|1'; fi`,
    );

    const result = run('scripts/pg-restore-drill.sh', ['--local'], {
      bin,
      env: { DRILL_DB: 'seed_restore_failure', PSQL_LOG: psqlLog },
    });
    assertStatus(result, 42, 'restore drill must preserve the restore error');
    const drops =
      readFileSync(psqlLog, 'utf8').match(/DROP DATABASE IF EXISTS seed_restore_failure;/g) ?? [];
    assert.ok(
      drops.length >= 2,
      `failed restore must attempt initial and trap cleanup drops: ${drops.length}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function s3SelectionCheck() {
  const { root, bin } = sandbox();
  try {
    fake(
      bin,
      'aws',
      `if [[ "$1" == s3 && "$2" == ls ]]; then
  printf '2026-08-25 01:00:00 123 foreign.tar\\n'
  printf '                           PRE nested/\\n'
  printf '2026-08-25 02:00:00 123 seed-20260825T020000Z.dump\\n'
  printf '2026-08-25 03:00:00 123 seed-20260825T030000Z.dump\\n'
elif [[ "$1" == s3 && "$2" == cp ]]; then
  head -c 2048 /dev/zero >"\${!#}"
fi`,
    );
    fake(bin, 'pg_restore', 'cat >/dev/null; exit 0');
    fake(
      bin,
      'psql',
      `if [[ "$*" == *users_pii* ]]; then echo 0; elif [[ "$*" == *users_app* ]]; then echo '1|1|1|1'; fi`,
    );
    const result = run('scripts/pg-restore-drill.sh', [], {
      bin,
      env: { BACKUP_S3_BUCKET: 'seed-dr-backups', DRILL_DB: 'seed_restore_s3_filter' },
    });
    assertStatus(result, 0, 'S3 restore drill should accept a generated dump');
    assert.match(result.output, /newest backup: seed-20260825T030000Z\.dump/);
    assert.match(result.output, /RESTORE DRILL PASSED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function backupRetentionCheck() {
  const { root, bin } = sandbox();
  try {
    const stage = join(root, 'stage');
    const rmLog = join(root, 'aws-rm.log');
    mkdirSync(stage);
    fake(bin, 'pg_dump', 'head -c 2048 /dev/zero');
    fake(bin, 'pg_restore', 'cat >/dev/null; exit 0');
    fake(
      bin,
      'aws',
      `if [[ "$1" == s3 && "$2" == ls ]]; then
  printf '2000-01-01 00:00:00 123 seed-20000101T000000Z.dump\\n'
  printf '2000-01-01 00:00:00 123 unrelated.txt\\n'
elif [[ "$1" == s3 && "$2" == rm ]]; then
  printf '%s\\n' "$*" >> "$AWS_RM_LOG"
fi`,
    );

    const invalid = run('scripts/pg-backup.sh', [], {
      bin,
      env: { BACKUP_S3_BUCKET: 'seed-dr-backups', BACKUP_RETENTION_DAYS: '0' },
    });
    assertStatus(invalid, 2, 'backup must reject non-positive retention');

    const valid = run('scripts/pg-backup.sh', [], {
      bin,
      env: {
        BACKUP_S3_BUCKET: 'seed-dr-backups',
        BACKUP_RETENTION_DAYS: '14',
        BACKUP_STAGE_DIR: stage,
        AWS_RM_LOG: rmLog,
      },
    });
    assertStatus(valid, 0, 'backup should complete with a valid retention window');
    const removals = readFileSync(rmLog, 'utf8');
    assert.match(removals, /seed-20000101T000000Z\.dump/);
    assert.doesNotMatch(removals, /unrelated\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const checks = [
  ['media-backup credential and exit propagation', mediaBackupChecks],
  ['restore preflight no-I/O and collision guard', restorePreflightChecks],
  ['restore failure cleanup and exit preservation', restoreFailureCleanupCheck],
  ['S3 restore dump selection', s3SelectionCheck],
  ['Postgres backup retention filtering', backupRetentionCheck],
];

for (const [label, check] of checks) {
  check();
  console.log(`✓ ${label}`);
}
console.log(`backup safety checks: ${checks.length}/${checks.length} passed`);
