#!/usr/bin/env node
/**
 * Pre-push check for Project Seed.
 * The heavy stuff pre-commit used to run (full typecheck) lives here instead.
 * Non-doc pushes use the repository's official isolated zero-spend pyramid so
 * the hook never falls back to the persistent developer database.
 *
 * Escape hatch: SEED_SKIP_PREPUSH=1 for emergencies (state the reason in the PR).
 */
import { execSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';

// Every run tees its output to a log file so a flaky/silent channel (or a
// detached run) never loses the verdict again. Override with SEED_PREPUSH_LOG.
// Append-only with a per-run header; compacted to the last ~2000 lines past 5 MB.
const LOG_PATH = process.env.SEED_PREPUSH_LOG ?? '/tmp/seed-prepush.log';
function appendLog(line) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 5_000_000) {
      const tail = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-2000).join('\n');
      truncateSync(LOG_PATH);
      appendFileSync(LOG_PATH, tail);
    }
    appendFileSync(LOG_PATH, line + '\n');
  } catch {
    // logging must never break the hook
  }
}
function emit(line) {
  if (line === '') {
    process.stderr.write('\n');
  } else {
    process.stderr.write(line + '\n');
  }
  appendLog(line);
}

if (process.env.SEED_SKIP_PREPUSH === '1') {
  emit(`[prepush] SEED_SKIP_PREPUSH=1 — skipping typecheck/test. (log: ${LOG_PATH})`);
  process.exit(0);
}

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

const ZERO_SHA_RE = /^0+$/;

// git feeds pre-push one "<local-ref> <local-sha> <remote-ref> <remote-sha>"
// line per pushed ref on stdin. A manual `node scripts/prepush-check.mjs` run
// has no stdin (TTY) — fall back to treating HEAD as the single pushed ref.
function readPushedRefs() {
  if (process.stdin.isTTY) {
    return [{ localRef: 'HEAD', localSha: sh('git rev-parse HEAD') }];
  }
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) {
    return [{ localRef: 'HEAD', localSha: sh('git rev-parse HEAD') }];
  }
  return lines.map((line) => {
    const [localRef, localSha] = line.split(' ');
    return { localRef, localSha };
  });
}

const refs = readPushedRefs();
const pushedRefs = refs.filter(
  (r) => !ZERO_SHA_RE.test(r.localSha) && !r.localRef.startsWith('refs/tags/'),
);

if (!pushedRefs.length) {
  emit('[prepush] all pushed refs are deletions/tags — skipping checks.');
  process.exit(0);
}

// Union the changed-file set across every pushed sha's diff against origin/main.
const changedSet = new Set();
let filterBase = null;
for (const { localSha } of pushedRefs) {
  let base;
  try {
    base = sh(`git merge-base ${localSha} origin/main`);
  } catch {
    emit('[prepush] could not find a merge-base with origin/main.');
    emit('  -> fetch origin main first (git fetch origin main)');
    process.exit(1);
  }
  filterBase = filterBase ?? base;
  const files = sh(`git diff --name-only ${base}...${localSha}`).split('\n').filter(Boolean);
  for (const f of files) changedSet.add(f);
}

const changed = [...changedSet];

const isDocsOnly =
  changed.length === 0 ||
  changed.every((f) => /^(docs|research|mockups)\//.test(f) || f.endsWith('.md'));

if (isDocsOnly) {
  emit('[prepush] docs-only push, skipping checks');
  process.exit(0);
}

// Tests run against the working tree the hook executes in, not the exact
// pushed commit — warn (don't block) if tracked files are dirty so a stale
// local edit doesn't get mistaken for having been verified.
const dirtyTracked = sh('git status --porcelain')
  .split('\n')
  .filter(Boolean)
  .filter((l) => !l.startsWith('??'));
if (dirtyTracked.length) {
  emit(
    `[prepush] warning: ${dirtyTracked.length} tracked file(s) have uncommitted changes — tests run against the working tree, not the pushed commit.`,
  );
}

emit(
  `[prepush] ${changed.length} file(s) changed since ${filterBase.slice(0, 8)} — running isolated typecheck + no-E2E pyramid.`,
);

function runTeeed(cmd, args, runTag) {
  appendLog(`[prepush] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // Full output goes to a per-run file (the shared log keeps verdicts only);
  // on failure, the matching FAIL lines are copied into the shared log too.
  const runLog = `/tmp/seed-prepush-${runTag}.log`;
  try {
    writeFileSync(runLog, out);
  } catch {
    // logging must never break the hook
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  appendLog(`[prepush] exit=${r.status ?? -1} (${cmd} ${args.join(' ')}) full output: ${runLog}`);
  if ((r.status ?? 1) !== 0) {
    const fails = out
      .split('\n')
      .filter((l) => /FAIL |✗ FAIL|AssertionError|timed out in|ECONNREFUSED/.test(l))
      .slice(0, 25);
    for (const line of fails) appendLog(`[prepush][fail] ${line.trim()}`);
  }
  return r;
}

const RUN_TAG = sh('git rev-parse HEAD').slice(0, 8);
emit(
  `[prepush] run started ${new Date().toISOString()} at HEAD ${RUN_TAG} — full log: ${LOG_PATH}`,
);
const typecheck = runTeeed('pnpm', ['typecheck'], RUN_TAG);
const result = typecheck.status === 0 ? runTeeed('pnpm', ['test:all:no-e2e'], RUN_TAG) : typecheck;

if (result.status !== 0) {
  try {
    const tail = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-40);
    for (const line of tail) process.stderr.write(`[prepush][log] ${line}\n`);
  } catch {
    // no log to tail — still report the block
  }
  emit('');
  emit('[prepush] blocked. Emergency bypass: `SEED_SKIP_PREPUSH=1 git push` —');
  emit('state the reason in the commit/PR description.');
  process.exit(result.status ?? 1);
}
emit(`[prepush] OK — full log: ${LOG_PATH}`);
