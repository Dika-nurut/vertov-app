import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as archiverModule from 'archiver';
import type archiver from 'archiver';
import { assetPlacements, db, galleryItems, projectAssets } from '@seed/db';
import { availableOwnedAssetCondition } from './asset-references';
import { validateOwnedLiveProject, workspaceProjectIdSchema } from './project-context';
import { decodeProjectListCursor, encodeProjectListCursor } from './project-list-cursor';

const BULK_DOWNLOAD_CAP = 100;
const ZipArchive = (
  archiverModule as unknown as {
    ZipArchive: new (options?: archiver.ArchiverOptions) => archiver.Archiver;
  }
).ZipArchive;

interface SessionLike {
  user: { id: string };
}
type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

const moveSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(500),
  folder: z.string().min(1).max(100).nullable(),
});

const tagSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(500),
  add: z.array(z.string().min(1).max(40)).max(20).default([]),
  remove: z.array(z.string().min(1).max(40)).max(20).default([]),
});

const listQuerySchema = z.object({
  projectId: workspaceProjectIdSchema.optional(),
  folder: z.string().min(1).max(100).optional(),
  /** Special sentinel: 'folder=__none__' → IS NULL. */
  noFolder: z.boolean().optional(),
  tag: z.string().min(1).max(40).optional(),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().max(2_048).optional(),
});
const facetQuerySchema = z.object({ projectId: workspaceProjectIdSchema.optional() }).strict();

// #15 audit: cap enforced at Zod parse time so the 414 fires before the
// DB SELECT rather than after fetching up to 500 rows.
const bulkDownloadSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(100),
});

export function setupGalleryRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  /**
   * Library list. Optional filters: folder (or noFolder=1 for items
   * outside any folder), tag (single — clients OR-combine client-side
   * if they need multi-tag). Keyset cursor on createdAt-desc + id-desc.
   */
  app.get<{
    Querystring: {
      projectId?: string;
      folder?: string;
      tag?: string;
      limit?: string;
      cursor?: string;
    };
  }>('/v1/gallery', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const q = listQuerySchema.safeParse({
      projectId: req.query.projectId,
      folder: req.query.folder === '__none__' ? undefined : req.query.folder,
      noFolder: req.query.folder === '__none__',
      tag: req.query.tag,
      limit: req.query.limit ? Number(req.query.limit) : 24,
      cursor: req.query.cursor,
    });
    if (!q.success) {
      return reply.status(400).send({ error: 'invalid_query', issues: q.error.issues });
    }
    const { projectId, folder, noFolder, tag, limit, cursor } = q.data;
    if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
      return reply.status(404).send({ error: 'not_found' });
    }

    const now = new Date();
    const conds = [availableOwnedAssetCondition(session.user.id, now)];
    if (noFolder) conds.push(isNull(galleryItems.folder));
    else if (folder) conds.push(eq(galleryItems.folder, folder));
    if (tag) conds.push(sql`${tag} = ANY(${galleryItems.tags})`);
    const context = JSON.stringify({
      projectId: projectId ?? null,
      folder: folder ?? null,
      noFolder: noFolder ?? false,
      tag: tag ?? null,
    });
    const parsedCursor = cursor
      ? decodeProjectListCursor(cursor, {
          scope: 'gallery',
          ownerId: session.user.id,
          context,
        })
      : null;
    if (cursor && !parsedCursor) {
      return reply.status(400).send({ error: 'invalid_cursor' });
    }
    if (parsedCursor) {
      conds.push(
        sql`(${galleryItems.createdAt}, ${galleryItems.id}) < (${parsedCursor.updatedAt.toISOString()}::timestamptz, ${parsedCursor.id})`,
      );
    }
    const projection = {
      id: galleryItems.id,
      jobId: galleryItems.jobId,
      assetUrl: galleryItems.assetUrl,
      thumbnailUrl: galleryItems.thumbnailUrl,
      kind: galleryItems.kind,
      title: galleryItems.title,
      originalName: galleryItems.originalName,
      folder: galleryItems.folder,
      tags: galleryItems.tags,
      isPublic: galleryItems.isPublic,
      publicSlug: galleryItems.publicSlug,
      expiresAt: galleryItems.expiresAt,
      createdAt: galleryItems.createdAt,
    };
    const rows = projectId
      ? await db
          .select(projection)
          .from(galleryItems)
          .innerJoin(
            projectAssets,
            and(
              eq(projectAssets.assetId, galleryItems.id),
              eq(projectAssets.projectId, projectId),
              eq(projectAssets.userId, session.user.id),
            ),
          )
          .where(and(...conds))
          .orderBy(sql`${galleryItems.createdAt} desc, ${galleryItems.id} desc`)
          .limit(limit + 1)
      : await db
          .select(projection)
          .from(galleryItems)
          .where(and(...conds))
          .orderBy(sql`${galleryItems.createdAt} desc, ${galleryItems.id} desc`)
          .limit(limit + 1);

    const more = rows.length > limit;
    const sliced = more ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor =
      more && last
        ? encodeProjectListCursor({
            scope: 'gallery',
            ownerId: session.user.id,
            context,
            updatedAt: last.createdAt,
            id: last.id,
          })
        : null;
    return { rows: sliced, nextCursor };
  });

  /** All distinct folder names this user has used — for the sidebar tree. */
  app.get<{ Querystring: { projectId?: string } }>('/v1/gallery/folders', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = facetQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
    const { projectId } = parsed.data;
    if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
      return reply.status(404).send({ error: 'not_found' });
    }
    reply.header('deprecation', 'true');
    reply.header('link', '</v1/projects/{id}/folders>; rel="successor-version"');
    const projection = { folder: galleryItems.folder, count: sql<number>`count(*)::int` };
    const where = availableOwnedAssetCondition(session.user.id, new Date());
    const rows = projectId
      ? await db
          .select(projection)
          .from(galleryItems)
          .innerJoin(
            projectAssets,
            and(
              eq(projectAssets.assetId, galleryItems.id),
              eq(projectAssets.projectId, projectId),
              eq(projectAssets.userId, session.user.id),
            ),
          )
          .where(where)
          .groupBy(galleryItems.folder)
          .orderBy(sql`coalesce(${galleryItems.folder}, '')`)
      : await db
          .select(projection)
          .from(galleryItems)
          .where(where)
          .groupBy(galleryItems.folder)
          .orderBy(sql`coalesce(${galleryItems.folder}, '')`);
    return rows;
  });

  /** All distinct tags — for the tag chips strip. */
  app.get<{ Querystring: { projectId?: string } }>('/v1/gallery/tags', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = facetQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
    const { projectId } = parsed.data;
    if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const rows = await db.execute<{ tag: string; count: number }>(sql`
      SELECT unnest(${galleryItems.tags}) AS tag, count(*)::int AS count
      FROM ${galleryItems}
      ${
        projectId
          ? sql`INNER JOIN ${projectAssets}
              ON ${projectAssets.assetId} = ${galleryItems.id}
             AND ${projectAssets.projectId} = ${projectId}
             AND ${projectAssets.userId} = ${session.user.id}`
          : sql``
      }
      WHERE ${galleryItems.userId} = ${session.user.id}
        AND ${galleryItems.deletedAt} IS NULL
        AND (${galleryItems.expiresAt} IS NULL OR ${galleryItems.expiresAt} > ${new Date()})
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `);
    return rows.rows;
  });

  app.post('/v1/gallery/move', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    reply.header('deprecation', 'true');
    reply.header('link', '</v1/assets/{id}/placements>; rel="successor-version"');
    const parsed = moveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { itemIds, folder } = parsed.data;
    const now = new Date();
    const updated = await db
      .update(galleryItems)
      .set({ folder })
      .where(
        and(
          eq(galleryItems.userId, session.user.id),
          inArray(galleryItems.id, itemIds),
          availableOwnedAssetCondition(session.user.id, now),
        ),
      )
      .returning({ id: galleryItems.id });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, moved: updated.length };
  });

  app.post('/v1/gallery/tag', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = tagSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { itemIds, add, remove } = parsed.data;
    const now = new Date();
    // #9 audit: single UPDATE statement using Postgres array functions
    // instead of N+1 SELECT+UPDATE loop. array_append/array_remove are
    // applied sequentially in a reduce so all adds and removes land in
    // one round-trip regardless of how many tags are supplied.
    //
    // Build the SQL expression: start with the existing tags column,
    // then chain array_remove(<col>, tag) for each remove and
    // array_append(<col>, tag) for each add — ensuring no duplicates
    // and no ordering dependency between add/remove lists.
    let expr: ReturnType<typeof sql> = sql`${galleryItems.tags}`;
    for (const r of remove) {
      expr = sql`array_remove(${expr}, ${r})`;
    }
    for (const a of add) {
      // array_remove before array_append prevents duplicates.
      expr = sql`array_append(array_remove(${expr}, ${a}), ${a})`;
    }
    const result = await db
      .update(galleryItems)
      .set({ tags: expr })
      .where(
        and(
          eq(galleryItems.userId, session.user.id),
          inArray(galleryItems.id, itemIds),
          availableOwnedAssetCondition(session.user.id, now),
        ),
      )
      .returning({ id: galleryItems.id });
    if (result.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, updated: result.length };
  });

  /**
   * Stream a ZIP of selected items. Caps at BULK_DOWNLOAD_CAP (100) to
   * keep response memory bounded and protect MinIO against accidental
   * giga-downloads. Over-cap → 414 URI Too Long. We use Fastify's raw
   * stream to bypass JSON serialisation.
   */
  app.post('/v1/gallery/bulk-download', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = bulkDownloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (parsed.data.itemIds.length > BULK_DOWNLOAD_CAP) {
      return reply.status(414).send({ error: 'too_many_items', cap: BULK_DOWNLOAD_CAP });
    }
    const rows = await db
      .select({ id: galleryItems.id, assetUrl: galleryItems.assetUrl })
      .from(galleryItems)
      .where(
        and(
          availableOwnedAssetCondition(session.user.id, new Date()),
          inArray(galleryItems.id, parsed.data.itemIds),
        ),
      );
    if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });

    // Hijack so Fastify stops managing the response — we write status,
    // headers, and body directly to the raw Node response.
    reply.hijack();
    const raw = reply.raw;
    raw.statusCode = 200;
    raw.setHeader('content-type', 'application/zip');
    raw.setHeader('content-disposition', `attachment; filename="seed-library-${Date.now()}.zip"`);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', (err) => {
      req.log.error({ err }, 'bulk-download: archive error');
    });
    archive.pipe(raw);

    for (const row of rows) {
      try {
        const res = await fetch(row.assetUrl);
        if (!res.ok || !res.body) continue;
        // #7 audit: stream directly into archiver instead of buffering the
        // entire asset in memory with Buffer.from(arrayBuffer()). The Node
        // Readable adapter lets archiver pull chunks lazily so heap stays
        // bounded even when downloading 100 items at once.
        const { Readable } = await import('node:stream');
        const nodeStream = Readable.fromWeb(
          res.body as import('node:stream/web').ReadableStream<Uint8Array>,
        );
        const name = `${row.id}.${guessExt(row.assetUrl)}`;
        archive.append(nodeStream, { name });
      } catch (err) {
        req.log.warn({ err, itemId: row.id }, 'bulk-download: asset fetch failed');
      }
    }
    await archive.finalize();
    return;
  });
}

function guessExt(url: string): string {
  const m = url.match(/\.([a-zA-Z0-9]{2,5})(\?|$)/);
  return m?.[1]?.toLowerCase() ?? 'bin';
}

/** Reaper hook used by the worker (apps/worker/src/gallery-reaper.ts). */
export async function reapExpiredGalleryItems(
  now: Date = new Date(),
): Promise<{ deleted: number }> {
  const rows = await db.transaction(async (tx) => {
    const expired = await tx
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(lt(galleryItems.expiresAt, now))
      .for('update');
    const ids = expired.map((item) => item.id);
    if (ids.length === 0) return [];
    // Placements are organization metadata and use ON DELETE RESTRICT so a
    // free account cannot turn its 30-day asset clock into permanence.
    await tx.delete(assetPlacements).where(inArray(assetPlacements.assetId, ids));
    return tx
      .delete(galleryItems)
      .where(and(inArray(galleryItems.id, ids), lt(galleryItems.expiresAt, now)))
      .returning({ id: galleryItems.id });
  });
  return { deleted: rows.length };
}
