/**
 * seed-beta-invites.ts — mint 30 closed-beta invite codes (W4.Fri).
 *
 * Idempotency: if any beta_invites row already exists the script is a no-op.
 * This prevents re-seeding with new random codes on every deploy and avoids
 * invalidating codes that were already distributed to beta users.
 *
 * Code format: SEED-<12 random base64url uppercase chars>
 * Example: SEED-XQ8K9F2PMLZN
 * — high entropy (72 bits), prefix keeps codes identifiable as Seed invites.
 *
 * Run:
 *   cd /root/seed
 *   pnpm --filter @seed/db exec tsx packages/db/scripts/seed-beta-invites.ts
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { db, pool } from '../src/index';
import { betaInvites } from '../schema/beta-invites';

const COHORT = 'tg-2026-05';
const COUNT = 30;

// Check if ANY beta_invites rows already exist — idempotent guard.
const { rows: existingRows } = await pool.query<{ total: string }>(
  `SELECT COUNT(*) AS total FROM beta_invites`,
);
const existingTotal = Number(existingRows[0]?.total ?? '0');

if (existingTotal > 0) {
  console.log(
    `beta-invites seed: table already has ${existingTotal} rows — skipping re-seed to preserve distributed codes.`,
  );
  await pool.end();
  process.exit(0);
}

function generateCode(): string {
  // 9 random bytes → 12 base64url chars (9 * 8 / 6 = 12, no padding).
  return `SEED-${randomBytes(9).toString('base64url').toUpperCase()}`;
}

const rows = Array.from({ length: COUNT }, () => ({
  code: generateCode(),
  cohort: COHORT,
}));

await db.insert(betaInvites).values(rows).onConflictDoNothing();

// Print all 30 codes so the operator can capture them (they're random — no
// other way to retrieve them after this run). The isolated test harness
// suppresses these one-use credentials from its logs.
if (process.env.BETA_INVITES_SILENT === '1') {
  console.log(`beta-invites seed: created ${COUNT} invite codes (codes suppressed)`);
} else {
  console.log(`\nbeta-invites seed: created ${COUNT} invite codes for cohort '${COHORT}':`);
  console.log('─'.repeat(60));
  for (const row of rows) {
    console.log(`  ${row.code}`);
  }
  console.log('─'.repeat(60));
  console.log('Save these codes — they cannot be recovered after this output.\n');
}

await pool.end();
