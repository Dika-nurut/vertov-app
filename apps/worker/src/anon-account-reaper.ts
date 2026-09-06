import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { assetPlacements, db, folders, user, usersApp } from '@seed/db';
import { reaperReapedTotal } from './metrics';
import { AssetStorage } from './storage';

/**
 * Pre-paywall anonymous browsing (2026-07-07) mints a real Better Auth
 * anonymous() session on first touch of Generate/Boards/Scenario/Studio —
 * a `user` row (isAnonymous=true) + a `users_app` row, so the visitor can
 * own real boards/scripts/studio_projects before ever signing up. Most
 * never come back to claim it (`onLinkAccount` in packages/auth). Left
 * alone this grows storage forever. Two account classes are swept. Their raw
 * object prefixes are removed before the DB rows, then the existing cascades
 * remove the database records.
 *
 * 1. **Never-claimed accounts past a grace TTL** — `user.isAnonymous=true`
 *    AND `created_at` older than the TTL. Deleting the `users_app` row
 *    cascades to boards/scripts/studio_projects/jobs/credit_transactions/
 *    users_pii/etc (every FK into `users_app.id` is `onDelete: 'cascade'` —
 *    see packages/db/schema/*.ts). Deleting the `user` row cascades
 *    session/account/member/invitation/two_factor (same reason, Better
 *    Auth's own schema, packages/db/schema/auth.ts).
 * 2. **Orphaned `users_app` rows with no matching `user` row at all** —
 *    the anonymous() plugin's own `onLinkAccount` hook already moved all
 *    real content (boards/scripts/studio_projects) to the new real userId
 *    BEFORE deleting the old anon `user` row (see claimAnonymousWork,
 *    packages/auth/src/index.ts) — there's no DB-level FK from `user` to
 *    `users_app` to cascade that deletion backwards, so the now-empty shell
 *    `users_app`/`users_pii` row for the claimed anon id lingers forever.
 *    No TTL needed here — account deletion leaves a `users_app` tombstone
 *    (`status='deleted'`) after removing the Better Auth `user` row (see
 *    DELETE /v1/me). Deleted tombstones are excluded below because their
 *    cascaded financial/audit rows must remain queryable; the only rows safe
 *    to reap are non-deleted shells left by the anonymous-account claim hook.
 *
 * Leader-elected via Redis SET NX PX, same pattern as reaper.ts /
 * gallery-reaper.ts.
 */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LEADER_KEY = 'seed:anon-account-reaper:leader';

type DbLike = typeof db;
type Tx = Parameters<Parameters<DbLike['transaction']>[0]>[0];
type DbRunner = DbLike | Tx;

export interface AnonAccountReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  ttlMs?: number;
  firstTickDelayMs?: number;
  /** Override for tests; defaults to a fresh `AssetStorage()` reading env. */
  storage?: AssetStorage;
}

export interface AnonAccountReaperHandle {
  stop(): void;
  tick(): Promise<{ neverClaimed: number; orphaned: number }>;
}

async function deletePlacementsForUsers(userIds: string[], runner: DbRunner = db): Promise<void> {
  if (userIds.length === 0) return;
  await runner
    .delete(assetPlacements)
    .where(
      inArray(
        assetPlacements.folderId,
        runner.select({ id: folders.id }).from(folders).where(inArray(folders.userId, userIds)),
      ),
    );
}

type ObjectStorage = Pick<AssetStorage, 'listKeys' | 'removeObjects'>;

/**
 * Remove raw objects before an anonymous account's DB rows are hard-deleted.
 * The rows are the only durable owner pointer, so a list/delete failure keeps
 * the account eligible for the next reaper tick. This covers direct Studio
 * uploads and resumable chunks that never received a gallery row.
 */
async function sweepOwnedObjects(
  log: Logger,
  storage: ObjectStorage,
  userId: string,
): Promise<boolean> {
  let complete = true;
  for (const prefix of [`${userId}/`, `_mp/${userId}/`]) {
    try {
      const keys = await storage.listKeys(prefix);
      if (keys.length > 0) await storage.removeObjects(keys);
    } catch (err) {
      complete = false;
      log.warn(
        { err, prefix },
        'anon-account-reaper: object cleanup failed — account rows retained for retry',
      );
    }
  }
  return complete;
}

/**
 * Recheck and remove one stale anonymous account while holding the same
 * transaction advisory lock used by the auth claim hook. The lock must span
 * object deletion and DB cleanup: otherwise signup could move the account's
 * rows while this reaper deletes the old prefix.
 */
async function reapStaleAnonymousAccount(
  log: Logger,
  storage: ObjectStorage,
  userId: string,
  cutoff: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const [candidate] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), eq(user.isAnonymous, true), lt(user.createdAt, cutoff)))
      .for('update')
      .limit(1);
    if (!candidate || !(await sweepOwnedObjects(log, storage, userId))) return false;

    await deletePlacementsForUsers([userId], tx);
    await tx.delete(usersApp).where(eq(usersApp.id, userId));
    const deleted = await tx.delete(user).where(eq(user.id, userId)).returning({ id: user.id });
    return deleted.length > 0;
  });
}

/** Remove an orphaned claimed-anonymous shell only after its raw prefix clears. */
async function reapOrphanedAppRow(
  log: Logger,
  storage: ObjectStorage,
  userId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);
    const [appRow] = await tx
      .select({ id: usersApp.id })
      .from(usersApp)
      // DELETE /v1/me deliberately leaves a `users_app` tombstone so the
      // financial/audit ledger remains queryable. A hard-deleted Better Auth
      // row therefore does NOT imply an orphan that is safe to cascade away.
      .where(and(eq(usersApp.id, userId), ne(usersApp.status, 'deleted')))
      .limit(1)
      .for('update');
    const [authRow] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!appRow || authRow || !(await sweepOwnedObjects(log, storage, userId))) return false;

    await deletePlacementsForUsers([userId], tx);
    const deleted = await tx
      .delete(usersApp)
      // Re-check the tombstone in the same locked transaction: an account
      // deletion may race the candidate scan, and deleting it would cascade
      // orders, credit transactions, subscriptions, jobs, and gallery rows.
      .where(and(eq(usersApp.id, userId), ne(usersApp.status, 'deleted')))
      .returning({ id: usersApp.id });
    return deleted.length > 0;
  });
}

/** Pure sweep (Redis-free, directly testable) — the leader election in
 *  `tick` wraps this. */
export async function sweepAbandonedAnonAccounts(
  log: Logger,
  ttlMs: number,
  storage: ObjectStorage = new AssetStorage(),
): Promise<{ neverClaimed: number; orphaned: number }> {
  const cutoff = new Date(Date.now() - ttlMs);

  const stale = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.isAnonymous, true), lt(user.createdAt, cutoff)));

  let neverClaimed = 0;
  if (stale.length > 0) {
    for (const row of stale) {
      if (await reapStaleAnonymousAccount(log, storage, row.id, cutoff)) neverClaimed += 1;
    }
  }

  const [appRows, userRows] = await Promise.all([
    db.select({ id: usersApp.id }).from(usersApp).where(ne(usersApp.status, 'deleted')),
    db.select({ id: user.id }).from(user),
  ]);
  const liveUserIds = new Set(userRows.map((r) => r.id));
  const orphanedIds = appRows.map((r) => r.id).filter((id) => !liveUserIds.has(id));

  let orphaned = 0;
  if (orphanedIds.length > 0) {
    for (const id of orphanedIds) {
      if (await reapOrphanedAppRow(log, storage, id)) orphaned += 1;
    }
  }

  if (neverClaimed > 0 || orphaned > 0) {
    log.info(
      { neverClaimed, orphaned, ttlMs },
      'anon-account-reaper: swept abandoned anonymous accounts',
    );
  }
  return { neverClaimed, orphaned };
}

export function startAnonAccountReaper(opts: AnonAccountReaperOptions): AnonAccountReaperHandle {
  const intervalMs =
    opts.intervalMs ?? Number(process.env.ANON_ACCOUNT_REAPER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const ttlMs = opts.ttlMs ?? Number(process.env.ANON_ACCOUNT_TTL_MS ?? DEFAULT_TTL_MS);
  const firstDelay = opts.firstTickDelayMs ?? 45_000;
  const instanceId = randomUUID();
  const storage = opts.storage ?? new AssetStorage();
  let stopped = false;

  async function tick(): Promise<{ neverClaimed: number; orphaned: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') return { neverClaimed: 0, orphaned: 0 };

    const result = await sweepAbandonedAnonAccounts(opts.log, ttlMs, storage);
    const total = result.neverClaimed + result.orphaned;
    if (total > 0) reaperReapedTotal.labels('anon-account').inc(total);
    return result;
  }

  async function loop(): Promise<void> {
    await new Promise((r) => setTimeout(r, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'anon-account-reaper: tick failed');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, ttlMs, instanceId }, 'anon-account-reaper started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
