import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  boards,
  assetPlacements,
  db,
  folders,
  galleryItems,
  nid,
  projectAssets,
  projects,
  PROJECT_TRASH_RETENTION_DAYS,
  PROJECT_TRASH_RETENTION_MS,
  scripts,
  studioProjects,
  type ProjectTrashManifest,
  type ProductionFormat,
} from '@seed/db';
import { ensureMembership, releaseKeepIfUnplaced } from './asset-membership';
import { availableOwnedAssetCondition } from './asset-references';

interface SessionLike {
  user: { id: string };
}

type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;
type ResourceType = 'script' | 'board' | 'studio' | 'asset';
type ProjectReader = Pick<typeof db, 'select'>;

const titleSchema = z.string().trim().min(1).max(120);
const formatSchema = z.object({
  aspect: z.string().trim().min(1).max(20),
  note: z.string().trim().max(500).optional(),
});
const createSchema = z.object({ title: titleSchema.optional() }).strict();
const restoreSchema = z.object({ title: titleSchema.optional() }).strict();
const permanentDeleteSchema = z.object({ confirmation: z.string().max(120) }).strict();
const patchSchema = z
  .object({ title: titleSchema.optional(), productionFormat: formatSchema.optional() })
  .strict()
  .refine((body) => body.title !== undefined || body.productionFormat !== undefined);
const resourceSchema = z.object({
  type: z.enum(['script', 'board', 'studio', 'asset']),
  id: z.string().min(1),
});
const attachSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    create: z.object({ title: titleSchema }).strict().optional(),
    resources: z.array(resourceSchema).min(1).max(200),
  })
  .strict()
  .refine(
    (body) => Number(body.projectId !== undefined) + Number(body.create !== undefined) === 1,
    {
      message: 'Provide exactly one of projectId or create',
    },
  );

export interface ProjectMismatch {
  error: 'project_mismatch';
  resource: { type: ResourceType; id: string };
  expectedProjectId: string;
  actualProjectId: string;
}

/** Shared Phase-1 guard: null is attachable; a different non-null project is not. */
export function crossProjectMismatch(
  expectedProjectId: string,
  resource: { type: ResourceType; id: string; projectId: string | null },
): ProjectMismatch | null {
  if (resource.projectId === null || resource.projectId === expectedProjectId) return null;
  return {
    error: 'project_mismatch',
    resource: { type: resource.type, id: resource.id },
    expectedProjectId,
    actualProjectId: resource.projectId,
  };
}

async function roomCounts(projectId: string, userId: string) {
  const [scenario, board, studio, asset] = await Promise.all([
    db.select({ value: count() }).from(scripts).where(eq(scripts.projectId, projectId)),
    db
      .select({ value: count() })
      .from(boards)
      .where(and(eq(boards.projectId, projectId), isNull(boards.trashedAt))),
    db
      .select({ value: count() })
      .from(studioProjects)
      .where(eq(studioProjects.projectId, projectId)),
    db
      .select({ value: count() })
      .from(projectAssets)
      .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
      .where(
        and(
          eq(projectAssets.projectId, projectId),
          eq(projectAssets.userId, userId),
          availableOwnedAssetCondition(userId, new Date()),
        ),
      ),
  ]);
  return {
    scenario: scenario[0]?.value ?? 0,
    boards: board[0]?.value ?? 0,
    studio: studio[0]?.value ?? 0,
    assets: asset[0]?.value ?? 0,
  };
}

function manifestCounts(manifest: ProjectTrashManifest) {
  return {
    scenario: manifest.scripts.length,
    boards: manifest.boards.length,
    studio: manifest.studio.length,
    assets: manifest.assets.length,
  };
}

function suggestedRestoreTitle(title: string): string {
  const suffix = ' (восстановлен)';
  return `${title.slice(0, Math.max(1, 120 - suffix.length)).trimEnd()}${suffix}`;
}

async function restorationState(
  reader: ProjectReader,
  projectId: string,
  userId: string,
  manifest: ProjectTrashManifest,
  now: Date,
) {
  const [scriptRows, boardRows, studioRows, membershipRows] = await Promise.all([
    manifest.scripts.length === 0
      ? []
      : reader
          .select({ id: scripts.id })
          .from(scripts)
          .where(
            and(
              eq(scripts.userId, userId),
              eq(scripts.projectId, projectId),
              inArray(scripts.id, manifest.scripts),
            ),
          ),
    manifest.boards.length === 0
      ? []
      : reader
          .select({ id: boards.id })
          .from(boards)
          .where(
            and(
              eq(boards.userId, userId),
              eq(boards.projectId, projectId),
              inArray(boards.id, manifest.boards),
            ),
          ),
    manifest.studio.length === 0
      ? []
      : reader
          .select({ id: studioProjects.id })
          .from(studioProjects)
          .where(
            and(
              eq(studioProjects.userId, userId),
              eq(studioProjects.projectId, projectId),
              inArray(studioProjects.id, manifest.studio),
            ),
          ),
    manifest.assets.length === 0
      ? []
      : reader
          .select({
            id: projectAssets.assetId,
            deletedAt: galleryItems.deletedAt,
            expiresAt: galleryItems.expiresAt,
          })
          .from(projectAssets)
          .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
          .where(
            and(
              eq(projectAssets.projectId, projectId),
              eq(projectAssets.userId, userId),
              eq(galleryItems.userId, userId),
              inArray(projectAssets.assetId, manifest.assets),
            ),
          ),
  ]);
  const validMedia = membershipRows.filter(
    (row) => row.deletedAt === null && (row.expiresAt === null || row.expiresAt > now),
  );
  const restored = {
    scripts: scriptRows.length,
    boards: boardRows.length,
    studio: studioRows.length,
    media: validMedia.length,
  };
  const unavailable = {
    scripts: manifest.scripts.length - restored.scripts,
    boards: manifest.boards.length - restored.boards,
    studio: manifest.studio.length - restored.studio,
    media: manifest.assets.length - restored.media,
  };
  return {
    expected: {
      scripts: manifest.scripts.length,
      boards: manifest.boards.length,
      studio: manifest.studio.length,
      media: manifest.assets.length,
    },
    restored,
    unavailable,
    partial: Object.values(unavailable).some((value) => value > 0),
  };
}

export function setupProjectRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  app.get('/v1/projects', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, session.user.id), isNull(projects.deletedAt)))
      .orderBy(desc(projects.updatedAt));
    return {
      items: await Promise.all(
        rows.map(async (row) => ({ ...row, rooms: await roomCounts(row.id, session.user.id) })),
      ),
    };
  });

  app.post('/v1/projects', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const id = nid();
    await db.insert(projects).values({ id, userId: session.user.id, title: parsed.data.title });
    return reply.status(201).send({ id });
  });

  app.get('/v1/projects/trash', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.userId, session.user.id),
          isNotNull(projects.deletedAt),
          isNotNull(projects.purgeAfter),
          isNotNull(projects.trashManifest),
        ),
      )
      .orderBy(desc(projects.deletedAt));
    return {
      retentionDays: PROJECT_TRASH_RETENTION_DAYS,
      items: rows.map((row) => ({
        id: row.id,
        title: row.title,
        productionFormat: row.productionFormat,
        deletedAt: row.deletedAt,
        purgeAfter: row.purgeAfter,
        rooms: manifestCounts(row.trashManifest!),
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/projects/trash/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [row] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, req.params.id),
          eq(projects.userId, session.user.id),
          isNotNull(projects.deletedAt),
          isNotNull(projects.purgeAfter),
          isNotNull(projects.trashManifest),
        ),
      )
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    return {
      id: row.id,
      title: row.title,
      productionFormat: row.productionFormat,
      deletedAt: row.deletedAt,
      purgeAfter: row.purgeAfter,
      retentionDays: PROJECT_TRASH_RETENTION_DAYS,
      recovery: await restorationState(db, row.id, session.user.id, row.trashManifest!, new Date()),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [row] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, req.params.id),
          eq(projects.userId, session.user.id),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    return { ...row, rooms: await roomCounts(row.id, session.user.id) };
  });

  app.patch<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const [row] = await db
      .update(projects)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(
        and(
          eq(projects.id, req.params.id),
          eq(projects.userId, session.user.id),
          isNull(projects.deletedAt),
        ),
      )
      .returning();
    if (!row) return reply.status(404).send({ error: 'not_found' });
    return row;
  });

  app.delete<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
      const [owned] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.id, req.params.id), eq(projects.userId, session.user.id)))
        .limit(1)
        .for('update');
      if (!owned) return null;
      if (owned.deletedAt && owned.purgeAfter && owned.trashManifest) {
        return {
          alreadyTrashed: true,
          deletedAt: owned.deletedAt,
          purgeAfter: owned.purgeAfter,
        };
      }
      const [scriptRows, boardRows, studioRows, assetRows] = await Promise.all([
        tx
          .select({ id: scripts.id })
          .from(scripts)
          .where(and(eq(scripts.projectId, owned.id), eq(scripts.userId, session.user.id))),
        tx
          .select({ id: boards.id })
          .from(boards)
          .where(and(eq(boards.projectId, owned.id), eq(boards.userId, session.user.id))),
        tx
          .select({ id: studioProjects.id })
          .from(studioProjects)
          .where(
            and(eq(studioProjects.projectId, owned.id), eq(studioProjects.userId, session.user.id)),
          ),
        tx
          .select({ id: projectAssets.assetId })
          .from(projectAssets)
          .where(
            and(eq(projectAssets.projectId, owned.id), eq(projectAssets.userId, session.user.id)),
          ),
      ]);
      const deletedAt = owned.deletedAt ?? new Date();
      const purgeAfter = new Date(deletedAt.getTime() + PROJECT_TRASH_RETENTION_MS);
      const trashManifest: ProjectTrashManifest = {
        version: 1,
        scripts: scriptRows.map((row) => row.id),
        boards: boardRows.map((row) => row.id),
        studio: studioRows.map((row) => row.id),
        assets: assetRows.map((row) => row.id),
      };
      await tx
        .update(projects)
        .set({ deletedAt, purgeAfter, trashManifest, updatedAt: deletedAt })
        .where(and(eq(projects.id, owned.id), eq(projects.userId, session.user.id)));
      return { alreadyTrashed: owned.deletedAt !== null, deletedAt, purgeAfter };
    });
    if (!outcome) return reply.status(404).send({ error: 'not_found' });
    return {
      ok: true,
      ...outcome,
      retentionDays: PROJECT_TRASH_RETENTION_DAYS,
    };
  });

  app.post<{ Params: { id: string } }>('/v1/projects/:id/restore', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = restoreSchema.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'project-title:' + session.user.id}))`,
      );
      const [owned] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, req.params.id),
            eq(projects.userId, session.user.id),
            isNotNull(projects.deletedAt),
            isNotNull(projects.purgeAfter),
            isNotNull(projects.trashManifest),
          ),
        )
        .limit(1)
        .for('update');
      if (!owned) return { kind: 'not_found' as const };
      // PostgreSQL now()/CURRENT_TIMESTAMP is fixed at transaction start, which
      // can predate either lock wait. clock_timestamp() is deliberately read
      // only after both advisory locks and the project row lock are held.
      const clock = await tx.execute<{ restoreNowMs: string }>(
        sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "restoreNowMs"`,
      );
      const restoreNowMs = Number(clock.rows[0]?.restoreNowMs);
      if (!Number.isFinite(restoreNowMs)) {
        throw new Error('project restore database clock unavailable');
      }
      const restoreNow = new Date(restoreNowMs);
      if (!owned.purgeAfter || owned.purgeAfter <= restoreNow) {
        return { kind: 'expired' as const, purgeAfter: owned.purgeAfter };
      }
      const title = parsed.data.title ?? owned.title;
      const [collision] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.userId, session.user.id),
            isNull(projects.deletedAt),
            sql`lower(btrim(${projects.title})) = lower(btrim(${title}))`,
          ),
        )
        .limit(1);
      if (collision) {
        return {
          kind: 'collision' as const,
          title,
          suggestedTitle: suggestedRestoreTitle(owned.title),
        };
      }
      const recovery = await restorationState(
        tx,
        owned.id,
        session.user.id,
        owned.trashManifest!,
        restoreNow,
      );
      const [restored] = await tx
        .update(projects)
        .set({
          title,
          deletedAt: null,
          purgeAfter: null,
          trashManifest: null,
          updatedAt: restoreNow,
        })
        .where(
          and(
            eq(projects.id, owned.id),
            eq(projects.userId, session.user.id),
            isNotNull(projects.deletedAt),
          ),
        )
        .returning({ id: projects.id, title: projects.title });
      if (!restored) return { kind: 'not_found' as const };
      return { kind: 'restored' as const, project: restored, recovery };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'expired')
      return reply.status(410).send({ error: 'retention_expired', purgeAfter: outcome.purgeAfter });
    if (outcome.kind === 'collision')
      return reply.status(409).send({
        error: 'name_collision',
        title: outcome.title,
        suggestedTitle: outcome.suggestedTitle,
      });
    return {
      ok: true,
      project: outcome.project,
      recovery: outcome.recovery,
      message: outcome.recovery.partial ? 'restored_partially' : 'restored',
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/projects/:id/permanent', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = permanentDeleteSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
      const [owned] = await tx
        .select({ id: projects.id, title: projects.title, deletedAt: projects.deletedAt })
        .from(projects)
        .where(and(eq(projects.id, req.params.id), eq(projects.userId, session.user.id)))
        .limit(1)
        .for('update');
      if (!owned) return 'not_found' as const;
      if (!owned.deletedAt) return 'not_in_trash' as const;
      if (parsed.data.confirmation !== owned.title) return 'confirmation_mismatch' as const;
      const deleted = await tx
        .delete(projects)
        .where(
          and(
            eq(projects.id, owned.id),
            eq(projects.userId, session.user.id),
            isNotNull(projects.deletedAt),
          ),
        )
        .returning({ id: projects.id });
      return deleted.length === 1 ? ('deleted' as const) : ('not_found' as const);
    });
    if (outcome === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome === 'not_in_trash') return reply.status(409).send({ error: 'not_in_trash' });
    if (outcome === 'confirmation_mismatch')
      return reply.status(400).send({ error: 'confirmation_mismatch' });
    return { ok: true, permanentlyDeleted: true };
  });

  app.delete<{ Params: { id: string; assetId: string } }>(
    '/v1/projects/:id/assets/:assetId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.assetId}))`);
        const [[project], [asset]] = await Promise.all([
          tx
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(
                eq(projects.id, req.params.id),
                eq(projects.userId, session.user.id),
                isNull(projects.deletedAt),
              ),
            )
            .limit(1),
          tx
            .select({ id: galleryItems.id })
            .from(galleryItems)
            .where(
              and(
                eq(galleryItems.id, req.params.assetId),
                eq(galleryItems.userId, session.user.id),
                isNull(galleryItems.deletedAt),
              ),
            )
            .limit(1),
        ]);
        if (!project || !asset) return null;
        const removedPlacements = await tx
          .delete(assetPlacements)
          .where(
            and(
              eq(assetPlacements.assetId, asset.id),
              inArray(
                assetPlacements.folderId,
                tx
                  .select({ id: folders.id })
                  .from(folders)
                  .where(eq(folders.projectId, project.id)),
              ),
            ),
          )
          .returning({ assetId: assetPlacements.assetId });
        const removedMembership = await tx
          .delete(projectAssets)
          .where(
            and(
              eq(projectAssets.projectId, project.id),
              eq(projectAssets.assetId, asset.id),
              eq(projectAssets.userId, session.user.id),
            ),
          )
          .returning({ assetId: projectAssets.assetId });
        await releaseKeepIfUnplaced(tx, asset.id);
        return {
          ok: true as const,
          removed: removedMembership.length === 1,
          placementsRemoved: removedPlacements.length,
        };
      });
      if (!outcome) return reply.status(404).send({ error: 'not_found' });
      return outcome;
    },
  );

  app.post('/v1/projects/attach', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = attachSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const outcome = await db.transaction(async (tx) => {
      const creatingProject = parsed.data.projectId === undefined;
      const projectId = parsed.data.projectId ?? nid();
      if (!creatingProject) {
        const [owned] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.userId, session.user.id),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1);
        if (!owned) return { status: 404 as const, body: { error: 'not_found' as const } };
      }

      const grouped = new Map<ResourceType, string[]>();
      for (const resource of parsed.data.resources) {
        const ids = grouped.get(resource.type) ?? [];
        ids.push(resource.id);
        grouped.set(resource.type, ids);
      }

      const found: Array<{ type: ResourceType; id: string; projectId: string | null }> = [];
      const tables = {
        script: scripts,
        board: boards,
        studio: studioProjects,
        asset: galleryItems,
      } as const;
      for (const [type, ids] of grouped) {
        if (type === 'asset') {
          const rows = await tx
            .select({ id: galleryItems.id, projectId: galleryItems.originProjectId })
            .from(galleryItems)
            .where(
              and(
                eq(galleryItems.userId, session.user.id),
                inArray(galleryItems.id, ids),
                availableOwnedAssetCondition(session.user.id, new Date()),
              ),
            );
          found.push(...rows.map((row) => ({ type, ...row })));
          continue;
        }
        const table = tables[type];
        const rows = await tx
          .select({ id: table.id, projectId: table.projectId })
          .from(table)
          .where(and(eq(table.userId, session.user.id), inArray(table.id, ids)));
        found.push(...rows.map((row) => ({ type, ...row })));
      }
      const foundKeys = new Set(found.map((row) => `${row.type}:${row.id}`));
      const missing = parsed.data.resources.find((row) => !foundKeys.has(`${row.type}:${row.id}`));
      if (missing)
        return { status: 404 as const, body: { error: 'not_found' as const, resource: missing } };
      const mismatch = found
        .filter((row) => row.type !== 'asset')
        .map((row) => crossProjectMismatch(projectId!, row))
        .find(Boolean);
      if (mismatch) return { status: 409 as const, body: mismatch };

      if (creatingProject) {
        await tx
          .insert(projects)
          .values({ id: projectId, userId: session.user.id, title: parsed.data.create!.title });
      }

      let attached = 0;
      for (const [type, ids] of grouped) {
        if (type === 'asset') {
          for (const assetId of ids) {
            if (await ensureMembership(tx, projectId, assetId, session.user.id)) attached += 1;
          }
          continue;
        }
        const table = tables[type];
        const stamped = await tx
          .update(table)
          .set({ projectId })
          .where(
            and(eq(table.userId, session.user.id), inArray(table.id, ids), isNull(table.projectId)),
          )
          .returning({ id: table.id });
        attached += stamped.length;
      }
      return { status: 200 as const, body: { projectId, attached } };
    });
    return reply.status(outcome.status).send(outcome.body);
  });
}
