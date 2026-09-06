import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/index';
import { nid } from '../src/id';
import { usersApp, usersPii } from '../schema/users';
import { models } from '../schema/models';
import { seedModels } from '../seed/models';

describe('db smoke', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('inserts + reads a users_app + users_pii pair, cascades on delete', async () => {
    const id = nid();
    const email = `smoke+${id}@seed.local`;

    await db.insert(usersApp).values({ id, displayName: 'Smoke', locale: 'ru' });
    await db.insert(usersPii).values({ id, email });

    const app = await db.select().from(usersApp).where(eq(usersApp.id, id));
    const pii = await db.select().from(usersPii).where(eq(usersPii.id, id));
    expect(app).toHaveLength(1);
    expect(pii[0]?.email).toBe(email);

    await db.delete(usersApp).where(eq(usersApp.id, id));

    const piiAfter = await db.select().from(usersPii).where(eq(usersPii.id, id));
    expect(piiAfter).toHaveLength(0); // FK ON DELETE CASCADE
  });

  it('DB active models match the seed catalog (seed reapplied after edits)', async () => {
    // `provider: 'stub'` is test-only — it appears nowhere in the seed catalog and
    // is asserted so below, which keeps this filter from ever hiding a real model.
    // Other packages' suites insert active stub models into this same database
    // (apps/api's jobs-routes fixtures mint `brd3-image-*` and `plan-gate-image-*`
    // with a fresh nid each run) and turbo runs those suites CONCURRENTLY with this
    // one, so a leftover fixture is not a catalog drift and must not read as one.
    // The invariant here is that the seed and the DB agree about OUR models.
    expect(seedModels.filter((m) => m.provider === 'stub')).toEqual([]);

    const active = await db.select().from(models).where(eq(models.isActive, true));
    const ids = active
      .filter((m) => m.provider !== 'stub')
      .map((m) => m.id)
      .sort();
    const expected = seedModels
      .filter((m) => m.isActive)
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(expected);
  });
});
