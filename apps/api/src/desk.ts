import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  assetPlacements,
  boards,
  db,
  deskIconPositions,
  folders,
  galleryItems,
  hasPaidMediaStorage,
  projectAssets,
  projects,
  scripts,
  studioProjects,
} from '@seed/db';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';
import { availableOwnedAssetCondition } from './asset-references';

interface SessionLike {
  user: { id: string };
}

type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

const DESK_SOURCE_CAP = 500;
const DESK_LAYOUT_BATCH_CAP = 1000;
const deskLayoutKind = z.enum(['system', 'folder', 'media', 'script', 'board', 'studio']);
type DeskLayoutKind = z.infer<typeof deskLayoutKind>;

const deskLayoutWrite = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    positions: z
      .array(
        z.object({
          itemKind: deskLayoutKind,
          itemId: z.string().min(1).max(200),
          x: z.number().int().min(0).max(100_000),
          y: z.number().int().min(0).max(100_000),
        }),
      )
      .min(1)
      .max(DESK_LAYOUT_BATCH_CAP),
  })
  .strict()
  .superRefine(({ positions }, context) => {
    const keys = new Set<string>();
    positions.forEach((position, index) => {
      const key = `${position.itemKind}:${position.itemId}`;
      if (keys.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['positions', index],
          message: 'duplicate_item',
        });
      }
      keys.add(key);
    });
  });

async function validLayoutKeys(
  userId: string,
  projectId: string,
  requested: Array<{ itemKind: DeskLayoutKind; itemId: string }>,
): Promise<Set<string>> {
  const result = new Set<string>();
  for (const item of requested) {
    if (item.itemKind === 'system' && (item.itemId === 'recents' || item.itemId === 'frames')) {
      result.add(`system:${item.itemId}`);
    }
  }

  const ids = (kind: DeskLayoutKind) =>
    requested.filter((item) => item.itemKind === kind).map((item) => item.itemId);
  const now = new Date();
  const [folderRows, mediaRows, scriptRows, boardRows, studioRows] = await Promise.all([
    ids('folder').length
      ? db
          .select({ id: folders.id })
          .from(folders)
          .where(
            and(
              eq(folders.projectId, projectId),
              eq(folders.userId, userId),
              inArray(folders.id, ids('folder')),
            ),
          )
      : [],
    ids('media').length
      ? db
          .select({ id: projectAssets.assetId })
          .from(projectAssets)
          .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
          .where(
            and(
              eq(projectAssets.projectId, projectId),
              eq(projectAssets.userId, userId),
              availableOwnedAssetCondition(userId, now),
              inArray(projectAssets.assetId, ids('media')),
            ),
          )
      : [],
    ids('script').length
      ? db
          .select({ id: scripts.id })
          .from(scripts)
          .where(
            and(
              eq(scripts.projectId, projectId),
              eq(scripts.userId, userId),
              inArray(scripts.id, ids('script')),
            ),
          )
      : [],
    ids('board').length
      ? db
          .select({ id: boards.id })
          .from(boards)
          .where(
            and(
              eq(boards.projectId, projectId),
              eq(boards.userId, userId),
              isNull(boards.trashedAt),
              inArray(boards.id, ids('board')),
            ),
          )
      : [],
    ids('studio').length
      ? db
          .select({ id: studioProjects.id })
          .from(studioProjects)
          .where(
            and(
              eq(studioProjects.projectId, projectId),
              eq(studioProjects.userId, userId),
              inArray(studioProjects.id, ids('studio')),
            ),
          )
      : [],
  ]);
  for (const row of folderRows) result.add(`folder:${row.id}`);
  for (const row of mediaRows) result.add(`media:${row.id}`);
  for (const row of scriptRows) result.add(`script:${row.id}`);
  for (const row of boardRows) result.add(`board:${row.id}`);
  for (const row of studioRows) result.add(`studio:${row.id}`);
  return result;
}

function bounded<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return {
    rows: rows.slice(0, DESK_SOURCE_CAP),
    truncated: rows.length > DESK_SOURCE_CAP,
  };
}

function sourceLine(kind: string | null): string {
  if (kind === 'generation') return 'из Генерации';
  if (kind === 'studio_render') return 'из Студии';
  if (kind === 'upload') return 'загрузка';
  if (kind === 'import') return 'импорт';
  return 'материал проекта';
}

export function setupDeskRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  app.get<{ Params: { id: string } }>('/v1/projects/:id/desk-layout', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, req.params.id),
          eq(projects.userId, session.user.id),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!project) return reply.status(404).send({ error: 'not_found' });

    const positions = await db
      .select({
        itemKind: deskIconPositions.itemKind,
        itemId: deskIconPositions.itemId,
        x: deskIconPositions.x,
        y: deskIconPositions.y,
        writeRevision: deskIconPositions.writeRevision,
        updatedAt: deskIconPositions.updatedAt,
      })
      .from(deskIconPositions)
      .where(
        and(
          eq(deskIconPositions.userId, session.user.id),
          eq(deskIconPositions.projectId, project.id),
        ),
      );
    return {
      revision: positions.reduce((latest, position) => Math.max(latest, position.writeRevision), 0),
      positions: positions.map(({ writeRevision: _writeRevision, ...position }) => position),
    };
  });

  app.put<{ Params: { id: string } }>('/v1/projects/:id/desk-layout', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = deskLayoutWrite.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_layout', issues: parsed.error.issues });
    }

    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, req.params.id),
          eq(projects.userId, session.user.id),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    if (!project) return reply.status(404).send({ error: 'not_found' });

    const valid = await validLayoutKeys(session.user.id, project.id, parsed.data.positions);
    const invalid = parsed.data.positions
      .map((position) => `${position.itemKind}:${position.itemId}`)
      .filter((key) => !valid.has(key));
    if (invalid.length > 0) {
      return reply.status(409).send({ error: 'invalid_layout_items', items: invalid.sort() });
    }

    const now = new Date();
    const intent = `desk-layout:${session.user.id}:${project.id}`;
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${intent}))`);
      const [current] = await tx
        .select({ revision: sql<number>`coalesce(max(${deskIconPositions.writeRevision}), 0)` })
        .from(deskIconPositions)
        .where(
          and(
            eq(deskIconPositions.userId, session.user.id),
            eq(deskIconPositions.projectId, project.id),
          ),
        );
      const stored = Number(current?.revision ?? 0);
      if (parsed.data.revision < stored) return { kind: 'stale' as const, stored };
      if (parsed.data.revision === stored) return { kind: 'conflict' as const, stored };

      await tx
        .insert(deskIconPositions)
        .values(
          parsed.data.positions.map((position) => ({
            userId: session.user.id,
            projectId: project.id,
            ...position,
            writeRevision: parsed.data.revision,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [
            deskIconPositions.userId,
            deskIconPositions.projectId,
            deskIconPositions.itemKind,
            deskIconPositions.itemId,
          ],
          set: {
            x: sql`excluded.x`,
            y: sql`excluded.y`,
            writeRevision: sql`excluded.write_revision`,
            updatedAt: now,
          },
        });
      return { kind: 'applied' as const, stored };
    });
    if (outcome.kind === 'conflict') {
      return reply.status(409).send({ error: 'layout_rev_conflict', revision: outcome.stored });
    }
    return {
      ok: true,
      persisted: outcome.kind === 'applied' ? parsed.data.positions.length : 0,
      // A stale write reports the revision that actually stands, not the one it
      // arrived with: answering with the caller's own superseded number would
      // tell a client that adopted it to go backwards.
      revision: outcome.kind === 'applied' ? parsed.data.revision : outcome.stored,
      updatedAt: now,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/projects/:id/desk-items', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const userId = session.user.id;
    const projectId = req.params.id;
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.userId, userId), isNull(projects.deletedAt)),
      )
      .limit(1);
    if (!project) return reply.status(404).send({ error: 'not_found' });

    const now = new Date();
    const [mediaRows, scriptRows, boardRows, studioRows, isPaid] = await Promise.all([
      db
        .select({
          asset: {
            id: galleryItems.id,
            assetUrl: galleryItems.assetUrl,
            thumbnailUrl: galleryItems.thumbnailUrl,
            kind: galleryItems.kind,
            title: galleryItems.title,
            originalName: galleryItems.originalName,
            sourceKind: galleryItems.sourceKind,
            mimeType: galleryItems.mimeType,
          },
          addedAt: projectAssets.addedAt,
        })
        .from(projectAssets)
        .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
        .where(
          and(
            eq(projectAssets.projectId, projectId),
            eq(projectAssets.userId, userId),
            availableOwnedAssetCondition(userId, now),
            notExists(
              db
                .select({ assetId: assetPlacements.assetId })
                .from(assetPlacements)
                .innerJoin(folders, eq(folders.id, assetPlacements.folderId))
                .where(
                  and(
                    eq(assetPlacements.assetId, galleryItems.id),
                    eq(folders.projectId, projectId),
                    eq(folders.userId, userId),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(projectAssets.addedAt), desc(galleryItems.id))
        .limit(DESK_SOURCE_CAP + 1),
      db
        .select({
          id: scripts.id,
          title: scripts.title,
          createdAt: scripts.createdAt,
          updatedAt: scripts.updatedAt,
        })
        .from(scripts)
        .where(and(eq(scripts.projectId, projectId), eq(scripts.userId, userId)))
        .orderBy(desc(scripts.updatedAt), desc(scripts.id))
        .limit(DESK_SOURCE_CAP + 1),
      db
        .select({
          id: boards.id,
          title: boards.title,
          createdAt: boards.createdAt,
          updatedAt: boards.updatedAt,
        })
        .from(boards)
        .where(
          and(eq(boards.projectId, projectId), eq(boards.userId, userId), isNull(boards.trashedAt)),
        )
        .orderBy(desc(boards.updatedAt), desc(boards.id))
        .limit(DESK_SOURCE_CAP + 1),
      db
        .select({
          id: studioProjects.id,
          title: studioProjects.title,
          createdAt: studioProjects.createdAt,
          updatedAt: studioProjects.updatedAt,
        })
        .from(studioProjects)
        .where(and(eq(studioProjects.projectId, projectId), eq(studioProjects.userId, userId)))
        .orderBy(desc(studioProjects.updatedAt), desc(studioProjects.id))
        .limit(DESK_SOURCE_CAP + 1),
      hasPaidMediaStorage(db, userId, now),
    ]);

    const mediaPage = bounded(mediaRows);
    const scriptPage = bounded(scriptRows);
    const boardPage = bounded(boardRows);
    const studioPage = bounded(studioRows);
    const media = mediaPage.rows.map(({ asset, addedAt }) => ({
      type: 'media' as const,
      id: asset.id,
      sortAt: addedAt,
      asset: {
        id: asset.id,
        assetUrl: asset.assetUrl,
        thumbnailUrl: asset.thumbnailUrl,
        kind: asset.kind,
        title: asset.title,
        originalName: asset.originalName,
        sourceLine: sourceLine(asset.sourceKind),
        mimeType: asset.mimeType,
      },
    }));
    const scenario = scriptPage.rows.map((script) => ({
      type: 'script' as const,
      ...script,
      href: `/scenario/${script.id}`,
    }));
    const boardsApp = boardPage.rows.map((board) => ({
      type: 'board' as const,
      ...board,
      href: `/boards/${board.id}`,
    }));
    const studio = studioPage.rows.map((composition) => ({
      type: 'studio' as const,
      ...composition,
      href: `/studio/${composition.id}`,
    }));
    const items = [
      ...media,
      ...scenario.map((item) => ({ ...item, sortAt: item.createdAt })),
      ...boardsApp.map((item) => ({ ...item, sortAt: item.createdAt })),
      ...studio.map((item) => ({ ...item, sortAt: item.createdAt })),
    ].sort((left, right) => {
      const chronological = right.sortAt.getTime() - left.sortAt.getTime();
      if (chronological !== 0) return chronological;
      return `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`);
    });

    return {
      items,
      apps: { scenario, boards: boardsApp, studio },
      truncated: {
        media: mediaPage.truncated,
        scenario: scriptPage.truncated,
        boards: boardPage.truncated,
        studio: studioPage.truncated,
      },
      retention: !isPaid
        ? { mode: 'expiring' as const, reminder: FREE_MEDIA_RETENTION_COPY }
        : { mode: 'permanent' as const, reminder: null },
    };
  });

  app.get<{ Params: { id: string; assetId: string } }>(
    '/v1/projects/:id/media/:assetId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;

      const now = new Date();
      const [row] = await db
        .select({
          asset: {
            id: galleryItems.id,
            assetUrl: galleryItems.assetUrl,
            thumbnailUrl: galleryItems.thumbnailUrl,
            kind: galleryItems.kind,
            title: galleryItems.title,
            originalName: galleryItems.originalName,
            sourceKind: galleryItems.sourceKind,
            mimeType: galleryItems.mimeType,
          },
        })
        .from(projectAssets)
        .innerJoin(projects, eq(projects.id, projectAssets.projectId))
        .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
        .where(
          and(
            eq(projectAssets.projectId, req.params.id),
            eq(projectAssets.assetId, req.params.assetId),
            eq(projectAssets.userId, session.user.id),
            eq(projects.userId, session.user.id),
            isNull(projects.deletedAt),
            availableOwnedAssetCondition(session.user.id, now),
          ),
        )
        .limit(1);

      if (!row) return reply.status(404).send({ error: 'not_found' });
      return {
        asset: {
          id: row.asset.id,
          assetUrl: row.asset.assetUrl,
          thumbnailUrl: row.asset.thumbnailUrl,
          kind: row.asset.kind,
          title: row.asset.title,
          originalName: row.asset.originalName,
          sourceLine: sourceLine(row.asset.sourceKind),
          mimeType: row.asset.mimeType,
        },
      };
    },
  );
}
