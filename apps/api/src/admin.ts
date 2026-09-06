import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, db, galleryItems, nid } from '@seed/db';
import { publicReportRateLimit } from './public-rate-limits';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

/**
 * Global-admin allowlist (audit M7). There is no global role table yet, so admins
 * are an explicit env list of account ids (`ADMIN_USER_IDS`, comma-separated). Keep
 * it small; migrate to a roles column when the operator team grows.
 */
export function isAdminUser(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId);
}

const takedownSchema = z.object({
  itemId: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export function setupAdminRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  // M7: operator takedown of ANY published gallery item (abuse report, court order,
  // 152-ФЗ/Roskomnadzor removal). Deliberately NOT owner-scoped — that's the whole
  // point: the owner can already unpublish their own. Removes the item from both
  // public surfaces and writes an immutable audit row.
  app.post('/v1/admin/gallery/takedown', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (!isAdminUser(session.user.id)) {
      return reply.status(403).send({ error: 'forbidden' });
    }
    const parsed = takedownSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const now = new Date();
    // Pull it from BOTH public surfaces and write the immutable operator trail
    // in the same transaction. A successful takedown without its audit row is
    // an unsafe moderation state: the content is gone, but nobody can explain
    // who removed it or why.
    const result = await db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: galleryItems.id,
          userId: galleryItems.userId,
          isPublic: galleryItems.isPublic,
          featuredAt: galleryItems.featuredAt,
        })
        .from(galleryItems)
        .where(eq(galleryItems.id, parsed.data.itemId))
        .limit(1);
      const item = rows[0];
      if (!item) return null;

      const updated = await tx
        .update(galleryItems)
        .set({ isPublic: false, featuredAt: null, moderationTakedownAt: now })
        .where(eq(galleryItems.id, item.id))
        .returning({ id: galleryItems.id });
      if (updated.length === 0) return null;

      await tx.insert(auditLog).values({
        id: nid(),
        userId: session.user.id, // the acting admin, not the content owner
        action: 'gallery.takedown',
        payload: {
          itemId: item.id,
          ownerId: item.userId,
          reason: parsed.data.reason ?? null,
          wasPublic: item.isPublic,
          wasFeatured: item.featuredAt !== null,
          moderationTakedownAt: now.toISOString(),
        },
        ip: req.ip ?? null,
        ua: req.headers['user-agent'] ?? null,
      });

      return { itemId: item.id };
    });
    if (!result) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, itemId: result.itemId };
  });
}

const reportSchema = z
  .object({
    itemId: z.string().min(1).max(128).optional(),
    slug: z.string().min(1).max(128).optional(),
    reason: z.string().min(3).max(1000),
    category: z.enum(['nsfw', 'csae', 'copyright', 'violence', 'other']).optional(),
  })
  .refine((v) => Boolean(v.itemId || v.slug), { message: 'itemId or slug required' });

/**
 * Public abuse-report intake (M7 completeness). Anyone can flag public content; the
 * report lands in the immutable audit log for an operator to action via the
 * takedown route. Rate-limited (public surface); stores no PII beyond ip/ua.
 */
export function setupReportRoutes(app: FastifyInstance): void {
  app.post('/v1/report', { config: publicReportRateLimit() }, async (req, reply) => {
    const parsed = reportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    await db.insert(auditLog).values({
      id: nid(),
      userId: null,
      action: 'content.report',
      payload: {
        itemId: parsed.data.itemId ?? null,
        slug: parsed.data.slug ?? null,
        reason: parsed.data.reason,
        category: parsed.data.category ?? 'other',
      },
      ip: req.ip ?? null,
      ua: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  });
}
