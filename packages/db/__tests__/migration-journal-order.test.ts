import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Drizzle's migrator does NOT diff the applied set — it reads the single newest
 * `created_at` in `drizzle.__drizzle_migrations` and runs only journal entries whose
 * `when` is strictly greater. A migration authored with an older timestamp than one
 * already applied is therefore skipped FOREVER, silently, with the deploy still
 * reporting success.
 *
 * That happened on 2026-07-29: `0060_pricing_v14_catalogue` was renumbered 0057 → 0060
 * to dodge a filename collision, but kept its original `when` (1785360000000), which sat
 * behind 0058/0059. Prod pulled the right image, the migration gate passed, and the whole
 * v14 price catalogue never reached the database — /generate showed no quality control
 * because `capabilities.resolutions` stayed empty.
 */

const entries = () =>
  (
    JSON.parse(readFileSync(join(__dirname, '../migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[];
    }
  ).entries;

const sqlTags = () =>
  readdirSync(join(__dirname, '../migrations'))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ''));

describe('migration journal', () => {
  /**
   * The mirror failure, found 2026-08-04: `0066` was written, committed and asserted by
   * a parity test — and never listed in the journal at all. Drizzle applies the tags the
   * journal names, so the file would have reached no database anywhere while
   * `db:migrate` reported success. The parity test read the DIRECTORY, so it happily
   * verified a migration that could not run.
   *
   * A file on disk is not a step that executes.
   */
  it('journals every .sql file, exactly once', () => {
    const journalled = entries().map((e) => e.tag);
    const unjournalled = sqlTags().filter((t) => !journalled.includes(t));
    expect(unjournalled, 'these .sql files would never execute').toEqual([]);

    const duplicated = journalled.filter((t, i) => journalled.indexOf(t) !== i);
    expect(duplicated, 'a tag listed twice would apply twice').toEqual([]);
  });

  it('has a file for every journal entry', () => {
    // A tag whose file was renamed or deleted fails at DEPLOY time rather than review
    // time, which is the expensive end to find it.
    const missing = entries()
      .map((e) => e.tag)
      .filter((t) => !sqlTags().includes(t));
    expect(missing, 'the journal names a migration with no file').toEqual([]);
  });

  it('timestamps strictly increase, so no migration can be silently skipped', () => {
    const journal = JSON.parse(
      readFileSync(join(__dirname, '../migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string; when: number }[] };

    const outOfOrder = journal.entries
      .map((entry, position) => ({ entry, previous: journal.entries[position - 1] }))
      .filter(({ entry, previous }) => previous !== undefined && entry.when <= previous.when)
      .map(
        ({ entry, previous }) =>
          `${entry.tag} (when=${entry.when}) does not come after ${previous!.tag} (when=${previous!.when})`,
      );

    expect(outOfOrder).toEqual([]);
  });
});
