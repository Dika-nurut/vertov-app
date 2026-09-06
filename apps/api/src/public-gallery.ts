import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { customAlphabet } from 'nanoid';
import { and, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, galleryItems, jobs, models, usersApp, workflows } from '@seed/db';
import { publicFeedRateLimit } from './public-rate-limits';

interface SessionLike {
  user: { id: string };
}
type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

// 12-char URL-safe slug (62^12 = ~3e21 keyspace — collisions are
// astronomically unlikely so we don't loop-retry on duplicate insert).
const slugAlphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const newSlug = customAlphabet(slugAlphabet, 12);

const publishSchema = z.object({ itemId: z.string().min(1) });

export function setupPublicGalleryRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
): void {
  app.post('/v1/gallery/publish', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const now = new Date();
    const rows = await db
      .select()
      .from(galleryItems)
      .where(
        and(
          eq(galleryItems.id, parsed.data.itemId),
          eq(galleryItems.userId, session.user.id),
          isNull(galleryItems.deletedAt),
          isNull(galleryItems.moderationTakedownAt),
          or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
        ),
      )
      .limit(1);
    const item = rows[0];
    if (!item) return reply.status(404).send({ error: 'not_found' });
    // Audit H2: the worker stamps provider-flagged output with the 'nsfw' tag
    // (job-runner.ts). Featuring gates /showcase, but a direct /g/:slug link is
    // public + no-auth — so the publish path itself must refuse flagged content,
    // otherwise a user can mint a stable public URL serving NSFW under the brand.
    if (item.tags.includes('nsfw')) {
      return reply.status(403).send({ error: 'nsfw_blocked' });
    }
    // Reuse the existing slug when republishing — keeps shared URLs alive.
    const slug = item.publicSlug ?? newSlug();
    const updated = await db
      .update(galleryItems)
      .set({ isPublic: true, publicSlug: slug, publishedAt: now })
      .where(
        and(
          eq(galleryItems.id, item.id),
          eq(galleryItems.userId, session.user.id),
          isNull(galleryItems.deletedAt),
          // An operator takedown is a durable moderation decision. Keeping this
          // predicate in the UPDATE closes the race where a takedown lands
          // between the SELECT above and this write.
          isNull(galleryItems.moderationTakedownAt),
          // Retention is checked again in the UPDATE, not only in the initial
          // SELECT: expiry can be stamped between those two statements.
          or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
        ),
      )
      .returning({ id: galleryItems.id });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, slug };
  });

  app.post('/v1/gallery/unpublish', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = publishSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // Keep slug intact for un-link safety: a stranger who bookmarked the
    // URL gets 404 instead of stumbling onto a different item if the
    // owner later republishes and we recycle the slug.
    const updated = await db
      .update(galleryItems)
      .set({ isPublic: false })
      .where(
        and(
          eq(galleryItems.id, parsed.data.itemId),
          eq(galleryItems.userId, session.user.id),
          isNull(galleryItems.deletedAt),
        ),
      )
      .returning({ id: galleryItems.id });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });

  /**
   * Curated public showcase feed. No auth. Only items a human marked as
   * featured (featured_at) AND that are still published appear — curation
   * is the anti-slop lever for everything outward-facing.
   */
  app.get<{ Querystring: { limit?: string } }>(
    '/v1/showcase',
    { config: publicFeedRateLimit() },
    async (req, reply) => {
      // SF-13: curated feed changes rarely — let the edge/browser cache it so a
      // burst of unauth hits doesn't re-run the query each time. (Served by the
      // `(featured_at)` index + is_public filter.)
      reply.header('cache-control', 'public, max-age=60');
      const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 36));
      const now = new Date();
      const rows = await db
        .select({
          slug: galleryItems.publicSlug,
          assetUrl: galleryItems.assetUrl,
          thumbnailUrl: galleryItems.thumbnailUrl,
          kind: galleryItems.kind,
          title: galleryItems.title,
          featuredAt: galleryItems.featuredAt,
        })
        .from(galleryItems)
        .where(
          and(
            eq(galleryItems.isPublic, true),
            isNotNull(galleryItems.featuredAt),
            isNotNull(galleryItems.publicSlug),
            isNull(galleryItems.deletedAt),
            isNull(galleryItems.moderationTakedownAt),
            // A provider flag may arrive after publication. The direct-slug
            // route has the same defense-in-depth check below; keep the
            // curated feed fail-closed too so a late flag cannot leak a
            // featured asset through a different public surface.
            sql`NOT (${galleryItems.tags} @> ARRAY['nsfw']::text[])`,
            or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
          ),
        )
        .orderBy(desc(galleryItems.featuredAt))
        .limit(limit);
      return { items: rows };
    },
  );

  /**
   * Public projection of an item by slug. No auth. Returns 404 when the
   * item is private or missing. Used by the SSG `/g/[slug]` page.
   */
  app.get<{ Params: { slug: string } }>(
    '/v1/g/:slug',
    { config: publicFeedRateLimit() },
    async (req, reply) => {
      const now = new Date();
      const rows = await db
        .select({
          id: galleryItems.id,
          assetUrl: galleryItems.assetUrl,
          kind: galleryItems.kind,
          tags: galleryItems.tags,
          createdAt: galleryItems.createdAt,
          jobId: galleryItems.jobId,
          modelId: jobs.modelId,
          presetSlug: jobs.presetSlug,
          params: workflows.params,
          modelFamily: models.family,
          modelVariant: models.variant,
          modelDisplayName: models.displayName,
          displayName: usersApp.displayName,
        })
        .from(galleryItems)
        .innerJoin(jobs, eq(jobs.id, galleryItems.jobId))
        .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
        .innerJoin(models, eq(models.id, jobs.modelId))
        .innerJoin(usersApp, eq(usersApp.id, galleryItems.userId))
        .where(
          and(
            eq(galleryItems.publicSlug, req.params.slug),
            eq(galleryItems.isPublic, true),
            isNull(galleryItems.deletedAt),
            isNull(galleryItems.moderationTakedownAt),
            or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return reply.status(404).send({ error: 'not_found' });
      // Audit H2 (defense-in-depth): never serve a flagged item even if it was
      // published before it got tagged — 404 to keep the asset out of the public
      // surface, matching the publish-time gate above.
      if (row.tags.includes('nsfw')) return reply.status(404).send({ error: 'not_found' });
      // #3 audit: ensure CDN / proxies never cache private gallery items.
      reply.header('cache-control', 'private, no-store');
      const prompt =
        typeof row.params['prompt'] === 'string' ? (row.params['prompt'] as string) : '';
      return {
        id: row.id,
        jobId: row.jobId,
        assetUrl: row.assetUrl,
        kind: row.kind,
        modelId: row.modelId,
        modelDisplayName: row.modelDisplayName,
        modelFamily: row.modelFamily,
        modelVariant: row.modelVariant,
        prompt,
        presetSlug: row.presetSlug,
        createdAt: row.createdAt,
        // `||` rather than `??` — better-auth can set empty-string display
        // names from email-only sign-ups, and we want those to fall back too.
        displayName: row.displayName || 'Аноним',
      };
    },
  );

  /**
   * J-2 follow-up (2026-09-02): public remix prefill for logged-out visitors.
   * `/v1/g/:slug` above serves the showcase page but withholds the job's
   * generation params — and `GET /v1/jobs/:id` is owner-scoped, so a visitor who
   * follows «Повторить стиль» gets the preset but not the recipe. This endpoint
   * returns the SAFE slice of that recipe: generation params, reference URLs
   * (the same already-public assets this item displays), model and preset. No
   * user identity, no credit data, no job status. Same visibility predicate as
   * the showcase route — a private/taken-down/expired item 404s here too.
   */
  app.get<{ Params: { slug: string } }>(
    '/v1/g/:slug/prefill',
    { config: publicFeedRateLimit() },
    async (req, reply) => {
      const now = new Date();
      const rows = await db
        .select({
          jobId: jobs.id,
          modelId: jobs.modelId,
          presetSlug: jobs.presetSlug,
          params: workflows.params,
          referenceAssets: workflows.referenceAssets,
          modelKind: models.kind,
          tags: galleryItems.tags,
        })
        .from(galleryItems)
        .innerJoin(jobs, eq(jobs.id, galleryItems.jobId))
        .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
        .innerJoin(models, eq(models.id, jobs.modelId))
        .where(
          and(
            eq(galleryItems.publicSlug, req.params.slug),
            eq(galleryItems.isPublic, true),
            isNull(galleryItems.deletedAt),
            isNull(galleryItems.moderationTakedownAt),
            or(isNull(galleryItems.expiresAt), gt(galleryItems.expiresAt, now)),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return reply.status(404).send({ error: 'not_found' });
      // Same H2 defense-in-depth as the showcase route above.
      if (row.tags.includes('nsfw')) return reply.status(404).send({ error: 'not_found' });
      reply.header('cache-control', 'private, no-store');
      const p = row.params;
      const pick = (key: string): unknown =>
        p[key] === undefined || p[key] === null ? null : p[key];
      return {
        jobId: row.jobId,
        modelId: row.modelId,
        modelKind: row.modelKind,
        presetSlug: row.presetSlug,
        params: {
          prompt: pick('prompt'),
          size: pick('size'),
          n: pick('n'),
          seed: pick('seed'),
          duration_seconds: pick('duration_seconds'),
          resolution: pick('resolution'),
          aspect_ratio: pick('aspect_ratio'),
        },
        referenceAssets: row.referenceAssets ?? [],
      };
    },
  );
}
