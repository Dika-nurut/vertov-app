#!/usr/bin/env node
/**
 * Pre-commit guard for Project Seed.
 * Blocks commits that introduce known footguns.
 *
 * Code-file patterns enforced on STAGED .ts/.tsx (excluding tests + node_modules):
 *   1. No hardcoded production IP (109.199.97.163).
 *   2. No deep workspace imports from "@seed/<pkg>/src/...".
 *   3. No `void <identifier>;` unused-import suppression hack.
 *   4. No `session.user.id.slice(...)` (truncates Better Auth IDs -> collisions).
 *   5. No `process.env.X!` non-null assertions on env reads.
 *
 * Repo-wide checks on ANY staged file:
 *   A. pnpm-workspace.yaml must not contain pnpm placeholder `allowBuilds:` entries (value "set this to true or false").
 *   B. No *.tsbuildinfo may be staged (incremental build cache should not be committed).
 *   C. Migrations under packages/db/migrations/ are append-only (no edit/delete/rename of applied migrations).
 *   D. apps/web/next-env.d.ts must stay the real Next-generated stub, not a DIST_DIR-floor-build rewrite.
 *   E. No .env* files (secrets never enter git); .env.example is fine.
 *   F. No high-precision secret shapes (private keys, ghp_/AKIA/sk-/Yandex AQVN tokens) in staged bodies.
 *   G. No raw #hex/rgba() color literal on a NEWLY ADDED line in a .tsx under apps/web (design-bible §Colors).
 *   H. No backdrop-blur/backdrop-filter on a newly added line under apps/web (design-bible §Blur).
 *   I. No staged blob over 5MB (10MB under mockups/ and docs/evidence/); media
 *      belongs in object storage, not git.
 *
 * All checks read the STAGED blob (git show :<path>), never the working tree,
 * and fail closed if a staged regular file can't be read that way.
 */
import { execSync, execFileSync } from 'node:child_process';

const ALL_STAGED = execSync('git diff --cached --name-only --diff-filter=ACMR', {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

// staged() reads a staged file's body from the index, never the working tree
// (so `git add`-ed content is checked even if later edited on disk).
function staged(path) {
  try {
    return execFileSync('git', ['show', `:${path}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

const CODE_STAGED = ALL_STAGED.filter((f) => /^(apps|packages)\/.+\.(ts|tsx|mts|cts)$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .filter((f) => !f.includes('node_modules'));

const CODE_RULES = [
  {
    id: 'no-hardcoded-prod-ip',
    re: /109\.199\.97\.163/,
    msg: 'Hardcoded production IP. Use process.env.* or a config constant.',
  },
  {
    id: 'no-deep-workspace-import',
    re: /from\s+["'`]@seed\/[^"'`]+\/src\//,
    msg: 'Deep workspace import bypasses the package public API. Import from the package root.',
  },
  {
    id: 'no-void-suppression',
    re: /^\s*void\s+[A-Za-z_$][\w$]*\s*;/m,
    msg: '`void <ident>;` is an unused-import suppression hack. Delete the import instead.',
  },
  {
    id: 'no-session-id-slice',
    re: /session\.user\.id\s*\.\s*slice\s*\(/,
    msg: 'Truncating session.user.id causes user-ID collisions. Make the column text and store it whole.',
  },
  {
    id: 'no-env-bang',
    re: /process\.env\.[A-Z_][A-Z0-9_]*\s*!(?!=)/,
    msg: '`process.env.X!` lies to TypeScript. Use a runtime check or default value.',
  },
];

let failed = false;

for (const file of CODE_STAGED) {
  const body = staged(file);
  if (body == null) {
    console.error(`[guard:staged-read-failed] ${file}`);
    console.error(
      '  -> Could not read staged content for this file. Investigate before committing (fail-closed).',
    );
    failed = true;
    continue;
  }
  for (const rule of CODE_RULES) {
    if (rule.re.test(body)) {
      console.error(`[guard:${rule.id}] ${file}`);
      console.error(`  -> ${rule.msg}`);
      failed = true;
    }
  }
}

// Rule A: pnpm-workspace.yaml `allowBuilds:` block check.
// pnpm 11 writes this when it detects build scripts that need approval.
// Entries with the placeholder value "set this to true or false" are NOT
// real approvals — block those. Entries explicitly set to `true` are fine
// (means a human reviewed and approved the postinstall script).
if (ALL_STAGED.includes('pnpm-workspace.yaml')) {
  const yaml = staged('pnpm-workspace.yaml');
  if (yaml == null) {
    console.error('[guard:staged-read-failed] pnpm-workspace.yaml');
    console.error(
      '  -> Could not read staged content for this file. Investigate before committing (fail-closed).',
    );
    failed = true;
  } else if (/set this to true or false/i.test(yaml)) {
    console.error('[guard:no-allowbuilds-placeholder] pnpm-workspace.yaml');
    console.error('  -> `allowBuilds:` contains pnpm placeholder values. Either:');
    console.error('     (a) Set to `true` if the postinstall is safe (e.g. @sentry/cli download).');
    console.error('     (b) Add the package to `onlyBuiltDependencies:` instead.');
    failed = true;
  }
}

// Rule B: never commit *.tsbuildinfo.
const STALE_BUILDINFO = ALL_STAGED.filter((f) => f.endsWith('.tsbuildinfo'));
if (STALE_BUILDINFO.length) {
  console.error(`[guard:no-tsbuildinfo] ${STALE_BUILDINFO.join(', ')}`);
  console.error('  -> *.tsbuildinfo is incremental build cache. Already gitignored — unstage with');
  console.error(`     git rm --cached ${STALE_BUILDINFO.join(' ')}`);
  failed = true;
}

// Rule C: migrations are forward-only. Editing/deleting/renaming an applied
// migration corrupts anyone who already ran it; write a new migration instead.
// _journal.json is the one file pnpm drizzle-kit legitimately appends to.
// -M collapses a rename to a single "R100\told\tnew" row — check BOTH sides so
// renaming an applied migration out of packages/db/migrations/ can't escape.
const NAME_STATUS = execSync('git diff --cached --name-status -M', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status, paths };
  });

const isMigration = (p) =>
  p.startsWith('packages/db/migrations/') && p !== 'packages/db/migrations/meta/_journal.json';

for (const { status, paths } of NAME_STATUS) {
  if (!/^[MDR]/.test(status)) continue;
  if (!paths.some(isMigration)) continue;
  const label = paths.length > 1 ? paths.join(' -> ') : paths[0];
  console.error(`[guard:migrations-immutable] ${label} (${status})`);
  console.error(
    '  -> Migrations are forward-only (expand->migrate->contract). Write a new migration instead of editing an applied one.',
  );
  failed = true;
}

// Rule D: apps/web/next-env.d.ts is Next-generated; a DIST_DIR-floor build
// (.next-fid / .next-floor) rewrites its reference path — caught us this week.
if (ALL_STAGED.includes('apps/web/next-env.d.ts')) {
  const body = staged('apps/web/next-env.d.ts') ?? '';
  if (!body.includes('./.next/types/routes.d.ts') || /\.next-(fid|floor)/.test(body)) {
    console.error('[guard:next-env-generated] apps/web/next-env.d.ts');
    console.error(
      '  -> This generated file was rewritten by a DIST_DIR floor build; restore with `git checkout -- apps/web/next-env.d.ts`.',
    );
    failed = true;
  }
}

// Rule E: no .env files (secrets never enter git). .env.example is the documented exception.
const ENV_RE = /(^|\/)\.env(\..+)?$/;
for (const file of ALL_STAGED) {
  if (ENV_RE.test(file) && !file.endsWith('.example')) {
    console.error(`[guard:no-env-files] ${file}`);
    console.error('  -> Secrets never enter git. Remove from the index and add to .gitignore.');
    failed = true;
  }
}

// Rule F: high-precision secret shapes only — false positives kill hooks, so no
// generic entropy heuristics. `guard-ok: secret-shaped` on the same line escapes.
const BINARY_EXT_RE = /\.(png|jpe?g|webp|gif|mp4|webm|woff2?|pdf|ico)$/i;
const SECRET_RULES = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{32,}\b/ },
  { id: 'yandex-cloud-key', re: /\bAQVN[A-Za-z0-9_-]{30,}\b/ },
];
for (const file of ALL_STAGED) {
  if (BINARY_EXT_RE.test(file)) continue;
  const body = staged(file);
  if (body == null) continue;
  for (const line of body.split('\n')) {
    if (line.includes('guard-ok: secret-shaped')) continue;
    for (const rule of SECRET_RULES) {
      if (rule.re.test(line)) {
        console.error(`[guard:no-secret-material:${rule.id}] ${file}`);
        console.error(
          '  -> Looks like a real credential. Remove it, rotate it, and use env/secrets manager instead.',
        );
        failed = true;
      }
    }
  }
}

// Rules G/H check only NEWLY ADDED lines (staged diff `+` lines), not the whole
// file body — apps/web has pre-existing bible drift (see docs/design/design-bible.md),
// and blocking every unrelated edit to an already-dirty file would just teach
// people to reach for --no-verify, which defeats the point of a fast hook.
function addedLines(file) {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--cached', '-U0', '--', file], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1));
}

const RAW_COLOR_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?=["'\s;),\]`])|\brgba?\((?!\s*var\()/;
const TSX_STAGED = ALL_STAGED.filter(
  (f) =>
    f.startsWith('apps/web/') &&
    f.endsWith('.tsx') &&
    !f.endsWith('.test.tsx') &&
    f !== 'apps/web/app/_components/landing/HeroSky.tsx' &&
    f !== 'apps/web/app/_components/HeroSky.tsx',
);
for (const file of TSX_STAGED) {
  for (const line of addedLines(file)) {
    if (line.includes('bible-ok')) continue;
    if (RAW_COLOR_RE.test(line)) {
      console.error(`[guard:bible-no-raw-color] ${file}`);
      console.error(`  -> ${line.trim()}`);
      console.error(
        '  -> Colors are tokens in globals.css, never raw literals in .tsx (docs/design/design-bible.md §Colors); add a token or, for the sanctioned exceptions (canvas paint mirrors, <meta name="theme-color">), append `// bible-ok`.',
      );
      failed = true;
    }
  }
}

// Rule H: blur/glassmorphism banned app-wide.
const BLUR_RE = /backdrop-blur|backdrop-filter/;
const BLUR_STAGED = ALL_STAGED.filter((f) => f.startsWith('apps/web/') && /\.(tsx|css)$/.test(f));
for (const file of BLUR_STAGED) {
  for (const line of addedLines(file)) {
    if (line.includes('bible-ok')) continue;
    if (BLUR_RE.test(line)) {
      console.error(`[guard:bible-no-blur] ${file}`);
      console.error(`  -> ${line.trim()}`);
      console.error('  -> Blur/glassmorphism is banned app-wide (docs/design/design-bible.md §Blur).');
      failed = true;
    }
  }
}

// Rule I: no staged blob over the size ceiling — media belongs in object
// storage, not git. mockups/ and docs/evidence/ are expected to carry real
// screenshots/video captures, so they get a looser 10MB ceiling; everything
// else stays at 5MB.
const RAW_DIFF = execSync('git diff --cached --raw -M', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const MAX_BYTES_MEDIA = 10 * 1024 * 1024;
const maxBytesFor = (path) =>
  /^(mockups|docs\/evidence)\//.test(path) ? MAX_BYTES_MEDIA : MAX_BYTES_DEFAULT;
for (const line of RAW_DIFF) {
  // format: :oldmode newmode oldsha newsha status\tpath[\tnewpath]
  const match = line.match(/^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) ([A-Z]\d*)\t(.+)$/);
  if (!match) continue;
  const [, newSha, status, path] = match;
  if (status.startsWith('D') || newSha === '0'.repeat(newSha.length)) continue;
  let size;
  try {
    size = parseInt(execFileSync('git', ['cat-file', '-s', newSha], { encoding: 'utf8' }), 10);
  } catch {
    continue;
  }
  const limit = maxBytesFor(path);
  if (size > limit) {
    console.error(
      `[guard:no-large-binary] ${path} (${(size / 1024 / 1024).toFixed(1)}MB > ${(limit / 1024 / 1024).toFixed(0)}MB limit)`,
    );
    console.error('  -> Media this big belongs in object storage, not git.');
    failed = true;
  }
}

if (failed) {
  console.error('');
  console.error('Commit blocked. Fix the issues, or for a documented exception');
  console.error('bypass with `git commit --no-verify` and explain in the commit message.');
  process.exit(1);
}
