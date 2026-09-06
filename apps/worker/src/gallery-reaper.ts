import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { assetPlacements, db, galleryItems, usersApp } from '@seed/db';
import { AssetStorage } from './storage';

/**
 * Gallery items on the free tier carry `expires_at = now() + 30d` at
 * insert time (see job-runner). This reaper deletes the row + the
 * associated MinIO objects once expired.
 *
 * Leader-elected via Redis SET NX PX on `seed:gallery-reaper:leader`.
 * Object deletion happens before the row is removed. A storage failure leaves
 * the expired row in place so the next leader tick retries it; deleting the
 * row first would lose the only durable pointer to the blob. The object batch
 * also includes a gallery thumbnail and the Studio waveform/filmstrip
 * sidecars derived from the main key when they exist.
 */
// Cleanup cadence is deliberately separate from the access predicate: expiry
// blocks reads immediately, while an hourly pass bounds orphaned storage and
// placement metadata without making the reaper part of authorization.
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_BATCH_SIZE = 100;
const ERASURE_USER_BATCH_SIZE = 100;
const LEADER_KEY = 'seed:gallery-reaper:leader';

export interface GalleryReaperOptions {
  log: Logger;
  redis: Redis;
  intervalMs?: number;
  firstTickDelayMs?: number;
  batchSize?: number;
  /** Override for tests; defaults to a fresh `AssetStorage()` reading env. */
  storage?: AssetStorage;
}

export interface GalleryReaperHandle {
  stop(): void;
  tick(): Promise<{ deleted: number; objectsRemoved: number }>;
}

/**
 * Remove every object owned by a soft-deleted account, including raw Studio
 * uploads and resumable-upload chunks that never receive a gallery row. The
 * deleted `users_app` row is the durable retry pointer: a list/remove failure
 * is logged and the same prefix is revisited on the next leader tick.
 */
async function sweepDeletedAccountObjects(log: Logger, storage: AssetStorage): Promise<number> {
  const deletedUsers = await db
    .select({ id: usersApp.id })
    .from(usersApp)
    .where(and(eq(usersApp.status, 'deleted'), isNull(usersApp.erasureObjectsClearedAt)))
    .orderBy(asc(usersApp.deletedAt), asc(usersApp.id))
    .limit(ERASURE_USER_BATCH_SIZE);
  let removed = 0;
  for (const user of deletedUsers) {
    let accountSweepComplete = true;
    // Generated assets and direct Studio uploads use `<userId>/…`; multipart
    // chunks intentionally live under `_mp/<userId>/…` until completion.
    for (const prefix of [`${user.id}/`, `_mp/${user.id}/`]) {
      let attempted = 0;
      try {
        const keys = await storage.listKeys(prefix);
        attempted = keys.length;
        if (keys.length === 0) continue;
        await storage.removeObjects(keys);
        removed += keys.length;
      } catch (err) {
        accountSweepComplete = false;
        log.warn(
          { err, prefix, attempted },
          'gallery-reaper: deleted-account object cleanup failed — prefix retained for retry',
        );
      }
    }
    if (accountSweepComplete) {
      await db
        .update(usersApp)
        .set({ erasureObjectsClearedAt: new Date() })
        .where(
          and(
            eq(usersApp.id, user.id),
            eq(usersApp.status, 'deleted'),
            isNull(usersApp.erasureObjectsClearedAt),
          ),
        );
    }
  }
  return removed;
}

export function startGalleryReaper(opts: GalleryReaperOptions): GalleryReaperHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelay = opts.firstTickDelayMs ?? 30_000;
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE));
  const instanceId = randomUUID();
  const storage = opts.storage ?? new AssetStorage();
  let stopped = false;

  async function tick(): Promise<{ deleted: number; objectsRemoved: number }> {
    const lockTtl = Math.max(1_000, Math.floor(intervalMs * 0.8));
    const acquired = await opts.redis.set(LEADER_KEY, instanceId, 'PX', lockTtl, 'NX');
    if (acquired !== 'OK') return { deleted: 0, objectsRemoved: 0 };

    const now = new Date();
    // Keep the per-asset advisory lock through object deletion. The owner
    // undo path takes the same lock, so it cannot restore a row after its
    // object was removed but before the expiry predicate is checked again.
    // Candidate selection itself is unlocked; each row is re-read after its
    // advisory lock so a concurrent restore or prior reaper wins cleanly.
    const result = await db.transaction(async (tx) => {
      const candidates = await tx
        .select({ id: galleryItems.id })
        .from(galleryItems)
        .where(lt(galleryItems.expiresAt, now))
        .orderBy(galleryItems.id)
        .limit(batchSize);
      if (candidates.length === 0) return { deleted: 0, objectsRemoved: 0 };

      const rows: {
        id: string;
        assetUrl: string;
        thumbnailUrl: string | null;
        kind: (typeof galleryItems.$inferSelect)['kind'];
      }[] = [];
      for (const candidate of candidates) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.id}))`);
        const [row] = await tx
          .select({
            id: galleryItems.id,
            assetUrl: galleryItems.assetUrl,
            thumbnailUrl: galleryItems.thumbnailUrl,
            kind: galleryItems.kind,
          })
          .from(galleryItems)
          .where(and(eq(galleryItems.id, candidate.id), lt(galleryItems.expiresAt, now)))
          .for('update')
          .limit(1);
        if (row) rows.push(row);
      }
      if (rows.length === 0) return { deleted: 0, objectsRemoved: 0 };

      // Map asset URLs back to bucket keys. Skip foreign URLs (anything not
      // minted by our AssetStorage) so we never issue a delete on someone
      // else's bucket key by accident. Studio's waveform/filmstrip caches are
      // deterministic sidecars of the source key, so include them here too.
      const keys: string[] = [];
      for (const row of rows) {
        const key = storage.keyFromUrl(row.assetUrl);
        if (key) {
          keys.push(key);
          if (row.kind === 'video' || row.kind === 'audio') keys.push(`${key}.peaks.json`);
          if (row.kind === 'video') keys.push(`${key}.strip.jpg`);
        }
        const thumbnailKey = row.thumbnailUrl ? storage.keyFromUrl(row.thumbnailUrl) : null;
        if (thumbnailKey) keys.push(thumbnailKey);
      }
      const uniqueKeys = [...new Set(keys)];
      try {
        await storage.removeObjects(uniqueKeys);
      } catch (err) {
        opts.log.warn(
          { err, attempted: uniqueKeys.length, rows: rows.length },
          'gallery-reaper: MinIO removeObjects failed — expired rows retained for retry',
        );
        return { deleted: 0, objectsRemoved: 0 };
      }

      await tx.delete(assetPlacements).where(
        inArray(
          assetPlacements.assetId,
          rows.map((r) => r.id),
        ),
      );
      const deleted = await tx
        .delete(galleryItems)
        .where(
          and(
            inArray(
              galleryItems.id,
              rows.map((row) => row.id),
            ),
            lt(galleryItems.expiresAt, now),
          ),
        )
        .returning({ id: galleryItems.id });
      return { deleted: deleted.length, objectsRemoved: uniqueKeys.length };
    });

    const erasedObjects = await sweepDeletedAccountObjects(opts.log, storage);
    const combined = {
      deleted: result.deleted,
      objectsRemoved: result.objectsRemoved + erasedObjects,
    };

    opts.log.info(
      { rows: combined.deleted, objects: combined.objectsRemoved, erasedObjects },
      'gallery-reaper: tick complete',
    );
    return combined;
  }

  async function loop(): Promise<void> {
    await new Promise((r) => setTimeout(r, firstDelay));
    while (!stopped) {
      try {
        await tick();
      } catch (err) {
        opts.log.error({ err }, 'gallery-reaper: tick failed');
      }
      if (stopped) break;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  void loop();
  opts.log.info({ intervalMs, instanceId }, 'gallery-reaper started');
  return {
    stop(): void {
      stopped = true;
    },
    tick,
  };
}
