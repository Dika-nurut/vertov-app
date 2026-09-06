#!/usr/bin/env node
/**
 * Zero-I/O integrity gate for the Vertov readiness evidence ledger.
 *
 * This deliberately reads only repository files. It prevents the audit from
 * silently losing a segment, drifting from the Phase 1 owner register, or
 * linking to evidence that no longer exists. It does not decide whether an
 * evidence claim is substantively sufficient; that remains a supervisor/owner
 * review gate.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ledgerPath = resolve(
  repoRoot,
  'docs/programs/vertov-readiness-evidence-ledger-2026-08-24.md',
);
const registerPath = resolve(
  repoRoot,
  'docs/evidence/vertov-readiness-phase1/owner-gate-register-2026-08-25.md',
);

const ledger = readFileSync(ledgerPath, 'utf8');
const register = readFileSync(registerPath, 'utf8');

const EXPECTED_SEGMENTS = [
  'Analytics / funnel',
  'Onboarding',
  'Support',
  'Public sharing',
  'Observability',
  'Scenario',
  'SEO',
  'Checkout',
  'Generate',
  'Pricing',
  'Moderation',
  'Boards',
  'Landing',
  'Presets',
  'Legal',
  'Ops',
  'Backups',
  'Studio',
  'Model catalog',
  'Credits economy',
  'Admin cockpit',
];

const EXPECTED_PHASE1 = [
  'Generate',
  'Model catalog',
  'Credits economy',
  'Public sharing',
  'Moderation',
  'Boards',
  'Backups',
];

function markdownTableRows(markdown, width) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .map((line) =>
      line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter(
      (cells) => cells.length >= width && cells[0] !== 'Segment' && !/^[-: ]+$/.test(cells[0]),
    );
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

const ledgerRows = markdownTableRows(ledger, 8);
assert.equal(ledgerRows.length, EXPECTED_SEGMENTS.length, 'ledger must contain 21 data rows');
assert.deepEqual(
  sorted(ledgerRows.map((row) => row[0])),
  sorted(EXPECTED_SEGMENTS),
  'ledger segment names must match the distinguished 21-segment scope',
);
assert.equal(
  new Set(ledgerRows.map((row) => row[0])).size,
  EXPECTED_SEGMENTS.length,
  'ledger segment names must be unique',
);

for (const row of ledgerRows) {
  const score = Number(row[1]);
  assert.ok(Number.isFinite(score) && score >= 0 && score <= 10, `${row[0]} score is invalid`);
  assert.ok(/^\d+(?:\.\d+)?$/.test(row[1]), `${row[0]} score must be numeric`);
  for (const evidence of row.slice(2, 7)) {
    assert.ok(['✓', '~', '—', '!'].includes(evidence), `${row[0]} evidence marker is invalid`);
  }
}

const registerRows = markdownTableRows(register, 5);
assert.equal(
  registerRows.length,
  EXPECTED_PHASE1.length,
  'owner register must contain seven Phase 1 rows',
);
assert.deepEqual(
  sorted(registerRows.map((row) => row[0])),
  sorted(EXPECTED_PHASE1),
  'owner register must cover exactly the seven Phase 1 segments',
);
const ledgerScores = new Map(ledgerRows.map((row) => [row[0], row[1]]));
for (const row of registerRows) {
  assert.equal(row[1], ledgerScores.get(row[0]), `${row[0]} mark drifted from the ledger`);
}

assert.match(ledger, /^> \*\*Last verified:\*\* \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/m);
assert.match(ledger, /public-edge TLS failure remains confirmed/);
assert.match(ledger, /legacy-execution-snapshot-live-count-2026-08-25\.md/);
assert.match(ledger, /moderation-policy-decision-2026-08-25\.md/);

function assertLocalMarkdownLinks(markdown, sourcePath) {
  const links = markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g);
  for (const match of links) {
    const target = match[1].trim().split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const path = resolve(dirname(sourcePath), target);
    assert.ok(existsSync(path), `broken local evidence link: ${target}`);
  }
}

assertLocalMarkdownLinks(ledger, ledgerPath);
assertLocalMarkdownLinks(register, registerPath);

console.log('readiness ledger safety checks: 13/13 passed (zero I/O)');
