#!/usr/bin/env node
/**
 * Zero-I/O consistency gate for the current Vertov readiness audit.
 *
 * The ledger is the authoritative score table. The audit deliberately keeps a
 * dated historical table as well, so this guard extracts only its current
 * conservative checkpoint and makes sure the two 21-row views cannot drift.
 * It also checks that the parent plan, active goal, and audit name the same
 * deployed release before a final decision is written.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = {
  ledger: resolve(repoRoot, 'docs/programs/vertov-readiness-evidence-ledger-2026-08-24.md'),
  audit: resolve(repoRoot, 'docs/programs/vertov-readiness-audit-2026-08-24.md'),
  parent: resolve(repoRoot, 'docs/programs/vertov-readiness-closure-plan-2026-08-24.md'),
  goal: resolve(repoRoot, 'docs/programs/goals/vertov-readiness-phases-3-6-2026-08-26.md'),
};

const documents = Object.fromEntries(
  Object.entries(paths).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
);

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

function tableRows(markdown, width) {
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

function rowsInSection(markdown, heading, width) {
  const start = markdown.indexOf(heading);
  assert.notEqual(start, -1, `missing section: ${heading}`);
  const after = markdown.slice(start + heading.length);
  const end = after.search(/^## /m);
  return tableRows(end === -1 ? after : after.slice(0, end), width);
}

const ledgerRows = tableRows(documents.ledger, 8);
assert.equal(ledgerRows.length, EXPECTED_SEGMENTS.length, 'ledger must contain 21 rows');
assert.deepEqual(
  ledgerRows.map((row) => row[0]),
  EXPECTED_SEGMENTS,
  'ledger order must match the distinguished 21-segment scope',
);

const auditRows = rowsInSection(
  documents.audit,
  '## Current conservative checkpoint — 2026-08-26',
  3,
);
assert.equal(auditRows.length, EXPECTED_SEGMENTS.length, 'current audit must contain 21 rows');
assert.deepEqual(
  auditRows.map((row) => row[0]),
  EXPECTED_SEGMENTS,
  'current audit order must match the ledger scope',
);

const ledgerScores = new Map(ledgerRows.map((row) => [row[0], row[1]]));
for (const row of auditRows) {
  assert.equal(row[1], ledgerScores.get(row[0]), `${row[0]} score drifted from the ledger`);
}

const currentFreezeRows = rowsInSection(
  documents.audit,
  '## Current rating freeze — 2026-08-28',
  3,
);
assert.equal(
  currentFreezeRows.length,
  EXPECTED_SEGMENTS.length,
  'current rating freeze must contain 21 rows',
);
assert.deepEqual(
  currentFreezeRows.map((row) => row[0]),
  EXPECTED_SEGMENTS,
  'current rating freeze order must match the distinguished 21-segment scope',
);
for (const row of currentFreezeRows) {
  assert.equal(
    row[1],
    ledgerScores.get(row[0]),
    `${row[0]} current freeze score drifted from the ledger`,
  );
}

const CURRENT_RELEASE = 'cee71db9485e17c7ca08ab6f56667b4389823313';
for (const [name, markdown] of Object.entries(documents)) {
  assert.match(
    markdown,
    new RegExp(CURRENT_RELEASE),
    `${name} must name the current deployed release`,
  );
}
assert.match(documents.audit, /This is an interim audit, not a final release decision/);
assert.match(documents.goal, /all 21 rows are 8\+ or have an explicit approved/);
assert.match(documents.parent, /every one of the 21 distinguished readiness segments/);

console.log(
  'readiness audit consistency: 21/21 scores aligned; release identity aligned; zero I/O',
);
