import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The official-OpenRouter last-resort leg ships OFF, and stays off until two
 * things are true (migration `0076_official_leg_ships_off`):
 *
 *   1. finance supplies per-rung costs for that leg — today exactly ONE rung is
 *      costed, so the whole spend-cap machinery protects a single price point;
 *   2. the attempt-attribution follow-up lands — settlement currently infers the
 *      attempt from `max(attempt_seq)` and the reaper's sweep can close a
 *      reservation before its submit, so a later invoice cannot correct the row.
 *
 * This test is the tripwire on (2). Arming the leg is an `UPDATE` on
 * `app_settings` — deliberately not a deploy — so nothing in CI would otherwise
 * notice a seed or migration quietly putting a positive cap back.
 *
 * If you are here because this test failed: turning the leg on is a real
 * decision with an owner ruling behind it (`docs/business/
 * finance-answer-model-cogs-2026-08-02.md`, Ask 8). Change this test in the same
 * commit that closes the follow-up, and say which invoice the rung's cost came
 * from.
 */
describe('the official-OpenRouter leg ships off', () => {
  const migrationsDir = join(__dirname, '..', 'migrations');
  const sqlFor = (name: string) => readFileSync(join(migrationsDir, name), 'utf8');

  it('leaves both spend caps at zero after the last migration that touches them', () => {
    // The caps are seeded by 0067 and zeroed by 0071. Replaying them in order is
    // what the DB does, so the last write wins — assert on that, not on 0071
    // alone, or a later migration re-arming the leg would slip through.
    const touching = ['0073_official_leg_budget.sql', '0076_official_leg_ships_off.sql'];
    const lastValueOf = (key: string): string | null => {
      let value: string | null = null;
      for (const file of touching) {
        const sql = sqlFor(file);
        // Seed form: ('key', '3000'::jsonb, …) — insert form: '<value>'::jsonb
        const seeded = new RegExp(`'${key}',\\s*'([^']+)'::jsonb`).exec(sql);
        if (seeded) value = seeded[1]!;
        // Update form: SET "value" = '0'::jsonb WHERE "key" IN (… 'key' …)
        const updated = /SET\s+"value"\s*=\s*'([^']+)'::jsonb/i.exec(sql);
        if (updated && sql.includes(`'${key}'`)) value = updated[1]!;
      }
      return value;
    };

    expect(lastValueOf('official_leg_budget_daily_rub')).toBe('0');
    expect(lastValueOf('official_leg_budget_monthly_rub')).toBe('0');
  });

  it('states in the migration itself what must be true before it is armed', () => {
    // A zeroed cap with no reason attached reads as a mistake and gets "fixed".
    const sql = sqlFor('0076_official_leg_ships_off.sql');
    expect(sql).toMatch(/per-rung/i);
    expect(sql).toMatch(/attempt/i);
  });
});
