import type { FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db as defaultDb, usersApp } from '@seed/db';

type DbLike = typeof defaultDb;

export type AccountSessionStatus = 'active' | 'banned' | 'deleted';

export async function accountSessionStatus(
  userId: string,
  database: DbLike = defaultDb,
): Promise<AccountSessionStatus> {
  const rows = await database
    .select({ status: usersApp.status })
    .from(usersApp)
    .where(eq(usersApp.id, userId))
    .limit(1);
  // No row yet = fresh signup; treat as active (the upsert in
  // ensureUserRows will materialise it on the next call).
  return rows[0]?.status ?? 'active';
}

/**
 * Defence-in-depth check that runs on every authenticated route.
 *
 * Lifted out of server.ts so it can be unit-tested without booting Better Auth.
 * A stale session cookie for a deleted or banned account must NOT see an
 * auth-gated route — Better Auth / Redis caches can return a hit before any
 * separate session-revocation work completes.
 */
export async function isAccountActive(
  userId: string,
  database: DbLike = defaultDb,
): Promise<boolean> {
  return (await accountSessionStatus(userId, database)) === 'active';
}

/** Shared authenticated-route gate. Bans deny both new and existing sessions. */
export async function enforceAccountSessionGate(
  userId: string,
  reply: FastifyReply,
  database: DbLike = defaultDb,
): Promise<boolean> {
  const status = await accountSessionStatus(userId, database);
  if (status === 'deleted') {
    reply.status(401).send({ error: 'account_deleted' });
    return false;
  }
  if (status === 'banned') {
    reply.status(403).send({ error: 'account_banned' });
    return false;
  }
  return true;
}
