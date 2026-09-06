import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, ne } from 'drizzle-orm';
import { db, schema, usersApp } from '@seed/db';

/**
 * /v1/me/accounts + /v1/me/sessions — the account-security surface behind the
 * full-page profile (linked OAuth identities + active sessions).
 *
 * Deliberately our OWN thin endpoints over the Better Auth `account`/`session`
 * tables (not the framework's cookie-bound list/revoke routes) so they fit the
 * repo's stub-session + real-DB test harness and we own the guards — chiefly the
 * "can't unlink your last login method" lockout guard. Every query is scoped to
 * the session's `userId` (INV-4: no IDOR).
 */

type SessionLike = { user: { id: string }; session?: { id?: string | null } | null } | null;
type RequireSession = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike>;

const PROVIDER_LABEL: Record<string, string> = {
  yandex: 'Яндекс',
  vk: 'VK',
  mailru: 'Mail.ru',
  odnoklassniki: 'Одноклассники',
  google: 'Google',
  credential: 'Email и пароль',
  email: 'Email',
  phone: 'Телефон',
};

function providerLabel(id: string): string {
  return PROVIDER_LABEL[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function setupMeAccountRoutes(app: FastifyInstance, requireSession: RequireSession): void {
  // ---- Linked accounts ---------------------------------------------------

  app.get('/v1/me/accounts', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select({
        id: schema.account.id,
        providerId: schema.account.providerId,
        accountId: schema.account.accountId,
        createdAt: schema.account.createdAt,
      })
      .from(schema.account)
      .where(eq(schema.account.userId, session.user.id))
      .orderBy(schema.account.createdAt);

    const items = rows.map((r) => ({
      id: r.id,
      provider: r.providerId,
      label: providerLabel(r.providerId),
      accountId: r.accountId,
      linkedAt: r.createdAt,
    }));
    // canUnlink gates the UI; the unlink route re-checks server-side regardless.
    return { items, canUnlink: items.length > 1 };
  });

  app.post('/v1/me/accounts/unlink', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { providerId?: unknown; accountId?: unknown };
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    const accountId = typeof body.accountId === 'string' ? body.accountId : null;
    if (!providerId) {
      return reply.status(400).send({ error: 'invalid_body' });
    }

    const where = accountId
      ? and(
          eq(schema.account.userId, session.user.id),
          eq(schema.account.providerId, providerId),
          eq(schema.account.accountId, accountId),
        )
      : and(eq(schema.account.userId, session.user.id), eq(schema.account.providerId, providerId));

    // Keep the last-login-method guard and the delete in one transaction. The
    // users_app row is the same per-user serialization point used by credits
    // and billing mutations; without the lock, two concurrent unlink requests
    // could both observe two methods and remove both, locking the user out.
    const result = await db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: usersApp.id })
        .from(usersApp)
        .where(eq(usersApp.id, session.user.id))
        .for('update');
      if (locked.length === 0) return { kind: 'not_found' as const };

      const all = await tx
        .select({ id: schema.account.id })
        .from(schema.account)
        .where(eq(schema.account.userId, session.user.id));
      const targets = await tx.select({ id: schema.account.id }).from(schema.account).where(where);
      if (targets.length === 0) return { kind: 'not_found' as const };
      // The request may omit accountId and target multiple identities for one
      // provider. Guard the post-delete count, not only the pre-delete count:
      // otherwise two same-provider rows could both be removed at once.
      if (all.length - targets.length < 1) return { kind: 'last_login_method' as const };

      const removed = await tx
        .delete(schema.account)
        .where(where)
        .returning({ id: schema.account.id });
      if (removed.length === 0) return { kind: 'not_found' as const };
      return { kind: 'ok' as const, removed: removed.length };
    });

    if (result.kind === 'last_login_method') {
      return reply.status(400).send({ error: result.kind });
    }
    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: result.kind });
    }
    return { ok: true, removed: result.removed };
  });

  // ---- Active sessions ---------------------------------------------------

  app.get('/v1/me/sessions', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const currentId = session.session?.id ?? null;
    const rows = await db
      .select({
        id: schema.session.id,
        ipAddress: schema.session.ipAddress,
        userAgent: schema.session.userAgent,
        createdAt: schema.session.createdAt,
        expiresAt: schema.session.expiresAt,
      })
      .from(schema.session)
      .where(
        and(eq(schema.session.userId, session.user.id), gt(schema.session.expiresAt, new Date())),
      )
      .orderBy(desc(schema.session.createdAt));

    const items = rows.map((r) => ({
      id: r.id,
      current: currentId !== null && r.id === currentId,
      ip: r.ipAddress,
      userAgent: r.userAgent,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }));
    return { items };
  });

  app.post('/v1/me/sessions/revoke', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const body = (req.body ?? {}) as { id?: unknown };
    const id = typeof body.id === 'string' ? body.id : '';
    if (!id) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    const removed = await db
      .delete(schema.session)
      .where(and(eq(schema.session.id, id), eq(schema.session.userId, session.user.id)))
      .returning({ id: schema.session.id });
    if (removed.length === 0) {
      return reply.status(404).send({ error: 'not_found' });
    }
    return { ok: true };
  });

  app.post('/v1/me/sessions/revoke-others', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const currentId = session.session?.id ?? null;
    // Without a known current session we can't safely keep one — revoke nothing
    // rather than log the caller out unexpectedly.
    if (!currentId) {
      return { ok: true, removed: 0 };
    }
    const removed = await db
      .delete(schema.session)
      .where(and(eq(schema.session.userId, session.user.id), ne(schema.session.id, currentId)))
      .returning({ id: schema.session.id });
    return { ok: true, removed: removed.length };
  });
}
