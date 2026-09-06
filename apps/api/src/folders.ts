import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { Client as MinioClient } from 'minio';
import { z } from 'zod';
import { sredaFolderCreateSchema, sredaFolderPatchSchema } from '@seed/shared/sreda-folders';
import {
  assetDeletionLeases,
  assetPlacements,
  assetReferences,
  db,
  folders,
  hasPaidMediaStorage,
  lockMediaStorageUser,
  mediaExpiresAt,
  galleryItems,
  nid,
  projectAssets,
  projects,
} from '@seed/db';
import { resolveS3ClientOptions } from './s3-config';
import { UPLOAD_MAX_BYTES } from './upload-limits';
import { AssetMembershipError, ensureMembership, releaseKeepIfUnplaced } from './asset-membership';
import { availableOwnedAssetCondition, resolveAvailableOwnedAssets } from './asset-references';

interface SessionLike {
  user: { id: string };
}

type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type FolderStorage = Pick<MinioClient, 'putObject' | 'removeObject'>;

export interface FolderRouteOptions {
  minio?: FolderStorage;
}

const placementSchema = z
  .object({ folderId: z.string().min(1), fromFolderId: z.string().min(1).optional() })
  .strict();
const newFolderPlacementSchema = z
  .object({
    projectId: z.string().min(1),
    name: sredaFolderCreateSchema.shape.name,
    parentId: z.string().min(1).nullable().optional(),
  })
  .strict();
const deleteFolderSchema = z.object({
  recursive: z.enum(['true', 'false']).optional(),
  expectedVersion: z.coerce.number().int().positive().optional(),
});
const listSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});
const preflightSchema = z.object({
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        size: z.number().int().positive(),
        type: z.string().max(100).optional(),
      }),
    )
    .min(1)
    .max(100),
});
const usageBatchSchema = z
  .object({ assetIds: z.array(z.string().min(1)).min(1).max(100) })
  .strict();
const resolveAssetsSchema = z
  .object({ assetIds: z.array(z.string().min(1).max(160)).min(1).max(100) })
  .strict();

const KEEP_REF_ID = 'folder-placement';
const FOLDER_NAME_CONSTRAINTS = new Set([
  'folders_project_root_name_uidx',
  'folders_project_parent_name_uidx',
]);
const USER_CHECKSUM_CONSTRAINT = 'gallery_items_user_checksum_uidx';
const DEFAULT_FOLDER_LIMIT = 24;
const DELETE_UNDO_MS = 15_000;
const RECENTS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SUPPORTED_UPLOADS: Record<string, { mime: string; kind: 'image' | 'video' | 'audio' }> = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  mp4: { mime: 'video/mp4', kind: 'video' },
  mov: { mime: 'video/quicktime', kind: 'video' },
  webm: { mime: 'video/webm', kind: 'video' },
  mp3: { mime: 'audio/mpeg', kind: 'audio' },
  wav: { mime: 'audio/wav', kind: 'audio' },
};

class RouteFailure extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error ?? 'route_failure'));
  }
}

function postgresError(error: unknown): { code?: string; constraint?: string } | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: string; constraint?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

function isUniqueConstraint(error: unknown, constraint: string): boolean {
  const pg = postgresError(error);
  return pg?.code === '23505' && pg.constraint === constraint;
}

function isFolderNameConstraint(error: unknown): boolean {
  const pg = postgresError(error);
  return pg?.code === '23505' && !!pg.constraint && FOLDER_NAME_CONSTRAINTS.has(pg.constraint);
}

function folderLimit(): number {
  const value = Number(process.env.PROJECT_FOLDER_LIMIT ?? DEFAULT_FOLDER_LIMIT);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_FOLDER_LIMIT;
}

async function requireOwnedProject(tx: Transaction, projectId: string, userId: string) {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId), isNull(projects.deletedAt)))
    .limit(1);
  if (!project) throw new RouteFailure(404, { error: 'not_found' });
  return project;
}

async function requireOwnedFolder(tx: Transaction, folderId: string, userId: string) {
  const [folder] = await tx
    .select({
      id: folders.id,
      projectId: folders.projectId,
      userId: folders.userId,
      parentId: folders.parentId,
      name: folders.name,
      ord: folders.ord,
      version: folders.version,
      createdAt: folders.createdAt,
      updatedAt: folders.updatedAt,
    })
    .from(folders)
    .innerJoin(projects, eq(projects.id, folders.projectId))
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.userId, userId),
        eq(projects.userId, userId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!folder) throw new RouteFailure(404, { error: 'not_found' });
  return folder;
}

async function lockProjectFolders(tx: Transaction, projectId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`sreda-folders:${projectId}`}))`);
}

async function requireParentInProject(
  tx: Transaction,
  parentId: string,
  projectId: string,
  userId: string,
) {
  const parent = await requireOwnedFolder(tx, parentId, userId);
  if (parent.projectId !== projectId) {
    throw new RouteFailure(409, { error: 'cross_project_parent' });
  }
  return parent;
}

async function nextFolderOrd(
  tx: Transaction,
  projectId: string,
  parentId: string | null,
): Promise<number> {
  const [last] = await tx
    .select({ ord: folders.ord })
    .from(folders)
    .where(
      and(
        eq(folders.projectId, projectId),
        parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
      ),
    )
    .orderBy(desc(folders.ord))
    .limit(1);
  return (last?.ord ?? -1) + 1;
}

async function createFolder(
  tx: Transaction,
  projectId: string,
  userId: string,
  name: string,
  options: { reuseExisting?: boolean; parentId?: string | null } = {},
) {
  await requireOwnedProject(tx, projectId, userId);
  await lockProjectFolders(tx, projectId);
  const parentId = options.parentId ?? null;
  if (parentId !== null) await requireParentInProject(tx, parentId, projectId, userId);
  if (options.reuseExisting) {
    const [existing] = await tx
      .select()
      .from(folders)
      .where(
        and(
          eq(folders.projectId, projectId),
          eq(folders.userId, userId),
          eq(folders.name, name),
          parentId === null ? isNull(folders.parentId) : eq(folders.parentId, parentId),
        ),
      )
      .limit(1);
    if (existing) return existing;
  }
  const [total] = await tx
    .select({ value: count() })
    .from(folders)
    .where(eq(folders.projectId, projectId));
  if ((total?.value ?? 0) >= folderLimit()) {
    throw new RouteFailure(400, { error: 'limit_exceeded', limit: folderLimit() });
  }
  try {
    const [folder] = await tx
      .insert(folders)
      .values({
        id: nid(),
        projectId,
        userId,
        parentId,
        name,
        ord: await nextFolderOrd(tx, projectId, parentId),
      })
      .returning();
    return folder!;
  } catch (error) {
    if (isFolderNameConstraint(error)) {
      throw new RouteFailure(409, { error: 'folder_name_exists' });
    }
    throw error;
  }
}

async function assertAcyclicParent(
  tx: Transaction,
  folderId: string,
  projectId: string,
  parentId: string | null,
): Promise<void> {
  if (parentId === null) return;
  if (parentId === folderId) throw new RouteFailure(409, { error: 'self_parent' });
  const result = await tx.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id
      FROM folders
      WHERE id = ${parentId} AND project_id = ${projectId}
      UNION ALL
      SELECT candidate.id, candidate.parent_id
      FROM folders candidate
      INNER JOIN ancestors ON candidate.id = ancestors.parent_id
      WHERE candidate.project_id = ${projectId}
    )
    SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ${folderId}) AS cycle
  `);
  if ((result.rows[0] as { cycle?: boolean } | undefined)?.cycle) {
    throw new RouteFailure(409, { error: 'folder_cycle' });
  }
}

async function folderSubtreeIds(
  tx: Transaction,
  folderId: string,
  projectId: string,
): Promise<string[]> {
  const result = await tx.execute(sql`
    WITH RECURSIVE subtree AS (
      SELECT id
      FROM folders
      WHERE id = ${folderId} AND project_id = ${projectId}
      UNION ALL
      SELECT child.id
      FROM folders child
      INNER JOIN subtree parent ON child.parent_id = parent.id
      WHERE child.project_id = ${projectId}
    )
    SELECT id FROM subtree
  `);
  return result.rows.map((row) => String((row as { id: string }).id));
}

async function ensureKeepLease(tx: Transaction, assetId: string, userId: string): Promise<void> {
  if (!(await hasPaidMediaStorage(tx, userId))) return;
  await tx
    .update(galleryItems)
    .set({ expiresAt: null })
    .where(and(eq(galleryItems.id, assetId), eq(galleryItems.userId, userId)));
  await tx
    .insert(assetReferences)
    .values({ id: nid(), galleryItemId: assetId, userId, refType: 'keep', refId: KEEP_REF_ID })
    .onConflictDoNothing();
}

async function addPlacement(tx: Transaction, assetId: string, folderId: string, userId: string) {
  await lockMediaStorageUser(tx, userId);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${assetId}))`);
  const [folder] = await tx
    .select({ id: folders.id, projectId: folders.projectId })
    .from(folders)
    .innerJoin(projects, eq(projects.id, folders.projectId))
    .where(
      and(
        eq(folders.id, folderId),
        eq(folders.userId, userId),
        eq(projects.userId, userId),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!folder) throw new RouteFailure(404, { error: 'not_found' });
  await ensureMembership(tx, folder.projectId, assetId, userId);
  await ensureKeepLease(tx, assetId, userId);
  const inserted = await tx
    .insert(assetPlacements)
    .values({ assetId, folderId })
    .onConflictDoNothing()
    .returning({ assetId: assetPlacements.assetId });
  return { created: inserted.length === 1, folder };
}

function parseCursor(
  raw: string | undefined,
): { createdAt: Date; id: string; seen: number } | null {
  if (!raw) return null;
  try {
    const parsed = z
      .object({
        createdAt: z.string().datetime(),
        id: z.string().min(1),
        seen: z.number().int().min(0).max(100),
      })
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(parsed.createdAt), id: parsed.id, seen: parsed.seen };
  } catch {
    throw new RouteFailure(400, { error: 'invalid_cursor' });
  }
}

function makeCursor(row: { createdAt: Date; id: string }, seen: number): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id, seen }),
  ).toString('base64url');
}

function parseRecentCursor(
  raw: string | undefined,
): { addedAt: Date; id: string; seen: number } | null {
  if (!raw) return null;
  try {
    const parsed = z
      .object({
        addedAt: z.string().datetime(),
        id: z.string().min(1),
        seen: z.number().int().min(0).max(100),
      })
      .parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { addedAt: new Date(parsed.addedAt), id: parsed.id, seen: parsed.seen };
  } catch {
    throw new RouteFailure(400, { error: 'invalid_cursor' });
  }
}

function makeRecentCursor(row: { addedAt: Date; id: string }, seen: number): string {
  return Buffer.from(
    JSON.stringify({ addedAt: row.addedAt.toISOString(), id: row.id, seen }),
  ).toString('base64url');
}

function sourceLine(kind: string | null): string {
  if (kind === 'generation') return 'из Генерации';
  if (kind === 'studio_render') return 'из Студии';
  if (kind === 'upload') return 'загрузка';
  if (kind === 'import') return 'импорт';
  return 'материал проекта';
}

function uploadExt(name: string): string {
  return (
    name
      .split('.')
      .at(-1)
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') ?? ''
  );
}

function uploadRejection(file: { name: string; size: number }): string | null {
  if (!SUPPORTED_UPLOADS[uploadExt(file.name)]) return 'Неподдерживаемый формат';
  if (file.size > UPLOAD_MAX_BYTES) return 'Файл больше 64 МБ';
  return null;
}

function mediaSignatureMatches(ext: string, body: Buffer): boolean {
  if (ext === 'png')
    return body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (ext === 'jpg' || ext === 'jpeg') return body[0] === 0xff && body[1] === 0xd8;
  if (ext === 'webp')
    return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
  if (ext === 'wav')
    return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WAVE';
  if (ext === 'webm') return body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === 'mp3')
    return (
      body.toString('ascii', 0, 3) === 'ID3' || (body[0] === 0xff && (body[1]! & 0xe0) === 0xe0)
    );
  if (ext === 'mp4' || ext === 'mov') return body.toString('ascii', 4, 8) === 'ftyp';
  return false;
}

function publicAssetBase(): string {
  return (
    process.env.ASSET_PUBLIC_URL ??
    process.env.API_PUBLIC_URL ??
    process.env.MINIO_PUBLIC_URL ??
    process.env.MINIO_ENDPOINT ??
    'http://127.0.0.1:9000'
  ).replace(/\/$/, '');
}

function routeFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof AssetMembershipError) return reply.status(error.status).send(error.body);
  if (error instanceof RouteFailure) return reply.status(error.status).send(error.body);
  throw error;
}

export function setupFolderRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: FolderRouteOptions = {},
): void {
  const minio = options.minio ?? new MinioClient(resolveS3ClientOptions(process.env));
  const bucket = process.env.MINIO_BUCKET ?? 'seed-assets';

  app.get<{ Params: { id: string } }>('/v1/projects/:id/folders', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    try {
      return await db.transaction(async (tx) => {
        await requireOwnedProject(tx, req.params.id, session.user.id);
        const now = new Date();
        const rows = await tx
          .select({
            id: folders.id,
            projectId: folders.projectId,
            parentId: folders.parentId,
            name: folders.name,
            ord: folders.ord,
            version: folders.version,
            createdAt: folders.createdAt,
            updatedAt: folders.updatedAt,
            count: sql<number>`count(${galleryItems.id})::int`,
            childCount: sql<number>`(SELECT count(*)::int FROM folders child WHERE child.parent_id = ${folders.id})`,
          })
          .from(folders)
          .leftJoin(assetPlacements, eq(assetPlacements.folderId, folders.id))
          .leftJoin(
            galleryItems,
            and(
              eq(galleryItems.id, assetPlacements.assetId),
              availableOwnedAssetCondition(session.user.id, now),
            ),
          )
          .where(eq(folders.projectId, req.params.id))
          .groupBy(folders.id)
          .orderBy(asc(folders.ord), asc(folders.createdAt));
        return { folders: rows, limit: folderLimit() };
      });
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/projects/:id/folders', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = sredaFolderCreateSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const folder = await db.transaction((tx) =>
        createFolder(tx, req.params.id, session.user.id, parsed.data.name, {
          parentId: parsed.data.parentId ?? null,
        }),
      );
      return reply.status(201).send(folder);
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>('/v1/folders/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = sredaFolderPatchSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const row = await db.transaction(async (tx) => {
        const initial = await requireOwnedFolder(tx, req.params.id, session.user.id);
        await lockProjectFolders(tx, initial.projectId);
        const owned = await requireOwnedFolder(tx, req.params.id, session.user.id);
        if (
          parsed.data.expectedVersion !== undefined &&
          parsed.data.expectedVersion !== owned.version
        ) {
          throw new RouteFailure(409, {
            error: 'stale_folder',
            currentVersion: owned.version,
          });
        }
        const parentId = parsed.data.parentId === undefined ? owned.parentId : parsed.data.parentId;
        if (parentId !== null) {
          await requireParentInProject(tx, parentId, owned.projectId, session.user.id);
        }
        await assertAcyclicParent(tx, owned.id, owned.projectId, parentId);
        const ord =
          parsed.data.ord ??
          (parsed.data.parentId !== undefined && parsed.data.parentId !== owned.parentId
            ? await nextFolderOrd(tx, owned.projectId, parentId)
            : owned.ord);
        const [updated] = await tx
          .update(folders)
          .set({
            ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
            ...(parsed.data.parentId !== undefined ? { parentId } : {}),
            ord,
            version: owned.version + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(folders.id, owned.id), eq(folders.version, owned.version)))
          .returning();
        if (!updated) throw new RouteFailure(409, { error: 'stale_folder' });
        return updated;
      });
      return row;
    } catch (error) {
      if (isFolderNameConstraint(error))
        return reply.status(409).send({ error: 'folder_name_exists' });
      return routeFailure(reply, error);
    }
  });

  app.delete<{
    Params: { id: string };
    Querystring: { recursive?: string; expectedVersion?: string };
  }>('/v1/folders/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = deleteFolderSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    try {
      return await db.transaction(async (tx) => {
        const initial = await requireOwnedFolder(tx, req.params.id, session.user.id);
        await lockProjectFolders(tx, initial.projectId);
        const folder = await requireOwnedFolder(tx, req.params.id, session.user.id);
        if (
          parsed.data.expectedVersion !== undefined &&
          parsed.data.expectedVersion !== folder.version
        ) {
          throw new RouteFailure(409, {
            error: 'stale_folder',
            currentVersion: folder.version,
          });
        }
        const subtree = await folderSubtreeIds(tx, folder.id, folder.projectId);
        const assets = await tx
          .select({ assetId: assetPlacements.assetId })
          .from(assetPlacements)
          .where(inArray(assetPlacements.folderId, subtree));
        if (parsed.data.recursive !== 'true' && (subtree.length > 1 || assets.length > 0)) {
          throw new RouteFailure(409, {
            error: 'folder_not_empty',
            childFolders: subtree.length - 1,
            placements: assets.length,
            recursiveRequired: true,
          });
        }
        const assetIds = [...new Set(assets.map((row) => row.assetId))].sort();
        for (const assetId of assetIds) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${assetId}))`);
        }
        const removed = await tx
          .delete(folders)
          .where(eq(folders.id, folder.id))
          .returning({ id: folders.id });
        if (removed.length !== 1) throw new RouteFailure(409, { error: 'stale_folder' });
        for (const assetId of assetIds) await releaseKeepIfUnplaced(tx, assetId);
        return {
          ok: true,
          foldersDeleted: subtree.length,
          placementsRemoved: assets.length,
          assetsDeleted: 0,
        };
      });
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/v1/folders/:id/assets',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listSchema.safeParse({
        limit: req.query.limit ? Number(req.query.limit) : 50,
        cursor: req.query.cursor,
      });
      if (!parsed.success)
        return reply.status(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      try {
        const cursor = parseCursor(parsed.data.cursor);
        const [folder] = await db
          .select({ id: folders.id })
          .from(folders)
          .innerJoin(projects, eq(projects.id, folders.projectId))
          .where(
            and(
              eq(folders.id, req.params.id),
              eq(folders.userId, session.user.id),
              eq(projects.userId, session.user.id),
              isNull(projects.deletedAt),
            ),
          )
          .limit(1);
        if (!folder) throw new RouteFailure(404, { error: 'not_found' });
        const now = new Date();
        const cursorCondition = cursor
          ? or(
              lt(assetPlacements.createdAt, cursor.createdAt),
              and(
                eq(assetPlacements.createdAt, cursor.createdAt),
                lt(assetPlacements.assetId, cursor.id),
              ),
            )
          : undefined;
        const rows = await db
          .select({ asset: galleryItems, placedAt: assetPlacements.createdAt })
          .from(assetPlacements)
          .innerJoin(galleryItems, eq(galleryItems.id, assetPlacements.assetId))
          .where(
            and(
              eq(assetPlacements.folderId, folder.id),
              availableOwnedAssetCondition(session.user.id, now),
              cursorCondition,
            ),
          )
          .orderBy(desc(assetPlacements.createdAt), desc(assetPlacements.assetId))
          .limit(parsed.data.limit + 1);
        const more = rows.length > parsed.data.limit;
        const items = more ? rows.slice(0, parsed.data.limit) : rows;
        const last = items.at(-1);
        return {
          items,
          nextCursor:
            more && last ? makeCursor({ createdAt: last.placedAt, id: last.asset.id }, 0) : null,
        };
      } catch (error) {
        return routeFailure(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string } }>('/v1/assets/:id/placements', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = placementSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const result = await db.transaction(async (tx) => {
        const placement = await addPlacement(
          tx,
          req.params.id,
          parsed.data.folderId,
          session.user.id,
        );
        let moved = false;
        if (parsed.data.fromFolderId && parsed.data.fromFolderId !== parsed.data.folderId) {
          const [source] = await tx
            .select({ id: folders.id, projectId: folders.projectId })
            .from(folders)
            .innerJoin(projects, eq(projects.id, folders.projectId))
            .where(
              and(
                eq(folders.id, parsed.data.fromFolderId),
                eq(folders.userId, session.user.id),
                eq(projects.userId, session.user.id),
                isNull(projects.deletedAt),
              ),
            )
            .limit(1);
          if (!source) throw new RouteFailure(404, { error: 'source_folder_not_found' });
          // The source was checked for OWNER and a live project — but never that
          // it is the SAME project as the destination. Without this, one crafted
          // request adds membership+placement in project B while deleting the
          // placement from project A: organization state crossing a boundary
          // contract §2 says is closed, and §5's "a move is between folders in
          // the current project". Same user, so not a leak — but the isolation
          // rule was simply not enforced here. The UI never sends this.
          if (source.projectId !== placement.folder.projectId) {
            throw new RouteFailure(409, { error: 'cross_project_move' });
          }
          const removed = await tx
            .delete(assetPlacements)
            .where(
              and(
                eq(assetPlacements.assetId, req.params.id),
                eq(assetPlacements.folderId, source.id),
              ),
            )
            .returning({ assetId: assetPlacements.assetId });
          moved = removed.length === 1;
        }
        return { ...placement, moved };
      });
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        moved: result.moved,
        destination: { id: result.folder.id },
      });
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    '/v1/assets/:id/placements/new-folder',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = newFolderPlacementSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        const result = await db.transaction(async (tx) => {
          const folder = await createFolder(
            tx,
            parsed.data.projectId,
            session.user.id,
            parsed.data.name,
            { parentId: parsed.data.parentId ?? null },
          );
          await addPlacement(tx, req.params.id, folder.id, session.user.id);
          return folder;
        });
        return reply.status(201).send({ ok: true, folder: result });
      } catch (error) {
        return routeFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/v1/assets/:id/usage', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [asset] = await db
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(
        and(
          eq(galleryItems.id, req.params.id),
          eq(galleryItems.userId, session.user.id),
          isNull(galleryItems.deletedAt),
        ),
      )
      .limit(1);
    if (!asset) return reply.status(404).send({ error: 'not_found' });
    const [production, placementRows] = await Promise.all([
      db
        .select({ type: assetReferences.refType, refId: assetReferences.refId })
        .from(assetReferences)
        .where(
          and(eq(assetReferences.galleryItemId, asset.id), ne(assetReferences.refType, 'keep')),
        ),
      db
        .select({ id: folders.id, name: folders.name })
        .from(assetPlacements)
        .innerJoin(folders, eq(folders.id, assetPlacements.folderId))
        .where(eq(assetPlacements.assetId, asset.id)),
    ]);
    const sites = [
      ...production.map((usage) => ({
        kind: usage.type,
        id: usage.refId,
        label:
          usage.type === 'board_node'
            ? 'Кадры'
            : usage.type === 'studio_clip'
              ? 'Студия'
              : usage.type,
      })),
      ...placementRows.map((folder) => ({
        kind: 'folder',
        id: folder.id,
        label: folder.name,
      })),
    ];
    return { sites, productionReferences: production.length, canDelete: production.length === 0 };
  });

  app.post('/v1/assets/resolve', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = resolveAssetsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const requested = [...new Set(parsed.data.assetIds)];
    const resolved = await resolveAvailableOwnedAssets(db, session.user.id, requested);
    return {
      assets: requested.map((id) => {
        const asset = resolved.get(id);
        return asset
          ? {
              id,
              available: true as const,
              assetUrl: asset.assetUrl,
              thumbnailUrl: asset.thumbnailUrl,
              kind: asset.kind,
              title: asset.title,
              expiresAt: asset.expiresAt?.toISOString() ?? null,
            }
          : { id, available: false as const };
      }),
    };
  });

  app.post('/v1/assets/usage', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = usageBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const owned = await db
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(
        and(
          eq(galleryItems.userId, session.user.id),
          inArray(galleryItems.id, parsed.data.assetIds),
          isNull(galleryItems.deletedAt),
        ),
      );
    const ownedIds = owned.map((asset) => asset.id);
    const usages: Record<string, string[]> = Object.fromEntries(ownedIds.map((id) => [id, []]));
    if (ownedIds.length === 0) return { usages };
    const [production, placementRows] = await Promise.all([
      db
        .select({ assetId: assetReferences.galleryItemId, type: assetReferences.refType })
        .from(assetReferences)
        .where(
          and(
            inArray(assetReferences.galleryItemId, ownedIds),
            ne(assetReferences.refType, 'keep'),
          ),
        ),
      db
        .select({ assetId: assetPlacements.assetId, name: folders.name })
        .from(assetPlacements)
        .innerJoin(folders, eq(folders.id, assetPlacements.folderId))
        .where(inArray(assetPlacements.assetId, ownedIds)),
    ]);
    for (const usage of production) {
      usages[usage.assetId]?.push(
        usage.type === 'board_node'
          ? 'Кадры'
          : usage.type === 'studio_clip'
            ? 'Студия'
            : usage.type,
      );
    }
    for (const placement of placementRows) usages[placement.assetId]?.push(placement.name);
    return { usages };
  });

  app.delete<{ Params: { id: string; folderId: string } }>(
    '/v1/assets/:id/placements/:folderId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      try {
        return await db.transaction(async (tx) => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
          const [asset] = await tx
            .select({ id: galleryItems.id })
            .from(galleryItems)
            .where(
              and(
                eq(galleryItems.id, req.params.id),
                eq(galleryItems.userId, session.user.id),
                isNull(galleryItems.deletedAt),
              ),
            )
            .limit(1);
          const [folder] = await tx
            .select({ id: folders.id })
            .from(folders)
            .innerJoin(projects, eq(projects.id, folders.projectId))
            .where(
              and(
                eq(folders.id, req.params.folderId),
                eq(folders.userId, session.user.id),
                eq(projects.userId, session.user.id),
                isNull(projects.deletedAt),
              ),
            )
            .limit(1);
          if (!asset || !folder) throw new RouteFailure(404, { error: 'not_found' });
          const removed = await tx
            .delete(assetPlacements)
            .where(
              and(eq(assetPlacements.assetId, asset.id), eq(assetPlacements.folderId, folder.id)),
            )
            .returning({ assetId: assetPlacements.assetId });
          await releaseKeepIfUnplaced(tx, asset.id);
          return {
            ok: true,
            removed: removed.length === 1,
            undo: removed.length === 1 ? { assetId: asset.id, folderId: folder.id } : null,
          };
        });
      } catch (error) {
        return routeFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    '/v1/projects/:id/recents',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listSchema.safeParse({
        limit: req.query.limit ? Number(req.query.limit) : 50,
        cursor: req.query.cursor,
      });
      if (!parsed.success)
        return reply.status(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      try {
        const cursor = parseRecentCursor(parsed.data.cursor);
        const seen = cursor?.seen ?? 0;
        const remaining = Math.max(0, 100 - seen);
        if (remaining === 0) return { items: [], nextCursor: null };
        await db.transaction((tx) => requireOwnedProject(tx, req.params.id, session.user.id));
        const now = new Date();
        const cursorCondition = cursor
          ? or(
              lt(projectAssets.addedAt, cursor.addedAt),
              and(eq(projectAssets.addedAt, cursor.addedAt), lt(galleryItems.id, cursor.id)),
            )
          : undefined;
        const take = Math.min(parsed.data.limit, remaining);
        const rows = await db
          .select({ asset: galleryItems, addedAt: projectAssets.addedAt })
          .from(projectAssets)
          .innerJoin(galleryItems, eq(galleryItems.id, projectAssets.assetId))
          .where(
            and(
              eq(projectAssets.projectId, req.params.id),
              eq(projectAssets.userId, session.user.id),
              availableOwnedAssetCondition(session.user.id, now),
              gt(projectAssets.addedAt, new Date(now.getTime() - RECENTS_WINDOW_MS)),
              cursorCondition,
            ),
          )
          .orderBy(desc(projectAssets.addedAt), desc(galleryItems.id))
          .limit(take + 1);
        const more = rows.length > take && seen + take < 100;
        const items = (more ? rows.slice(0, take) : rows.slice(0, remaining)).map((row) => ({
          ...row.asset,
          addedAt: row.addedAt,
          sourceLine: sourceLine(row.asset.sourceKind),
        }));
        const last = items.at(-1);
        return {
          items,
          nextCursor: more && last ? makeRecentCursor(last, seen + items.length) : null,
        };
      } catch (error) {
        return routeFailure(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/assets/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
        const [asset] = await tx
          .select({ id: galleryItems.id, expiresAt: galleryItems.expiresAt })
          .from(galleryItems)
          .where(
            and(
              eq(galleryItems.id, req.params.id),
              eq(galleryItems.userId, session.user.id),
              isNull(galleryItems.deletedAt),
            ),
          )
          .limit(1);
        if (!asset) throw new RouteFailure(404, { error: 'not_found' });
        const usages = await tx
          .select({ type: assetReferences.refType, refId: assetReferences.refId })
          .from(assetReferences)
          .where(
            and(eq(assetReferences.galleryItemId, asset.id), ne(assetReferences.refType, 'keep')),
          );
        if (usages.length > 0) {
          throw new RouteFailure(409, { error: 'asset_in_use', count: usages.length, usages });
        }
        const placementRows = await tx
          .select({ folderId: assetPlacements.folderId })
          .from(assetPlacements)
          .where(eq(assetPlacements.assetId, asset.id));
        const folderIds = placementRows.map((row) => row.folderId);
        await tx.delete(assetPlacements).where(eq(assetPlacements.assetId, asset.id));
        await tx
          .delete(assetReferences)
          .where(
            and(eq(assetReferences.galleryItemId, asset.id), eq(assetReferences.refType, 'keep')),
          );
        const now = new Date();
        const deleteAfter = new Date(now.getTime() + DELETE_UNDO_MS);
        await tx
          .insert(assetDeletionLeases)
          .values({
            assetId: asset.id,
            userId: session.user.id,
            previousExpiresAt: asset.expiresAt,
            folderIds,
            deleteAfter,
          })
          .onConflictDoUpdate({
            target: assetDeletionLeases.assetId,
            set: { previousExpiresAt: asset.expiresAt, folderIds, deleteAfter },
          });
        await tx
          .update(galleryItems)
          .set({ deletedAt: now, expiresAt: deleteAfter })
          .where(eq(galleryItems.id, asset.id));
        return { ok: true, undoUntil: deleteAfter.toISOString() };
      });
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/assets/:id/restore', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    try {
      return await db.transaction(async (tx) => {
        await lockMediaStorageUser(tx, session.user.id);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`);
        const [lease] = await tx
          .select()
          .from(assetDeletionLeases)
          .where(
            and(
              eq(assetDeletionLeases.assetId, req.params.id),
              eq(assetDeletionLeases.userId, session.user.id),
            ),
          )
          .limit(1);
        if (!lease || lease.deleteAfter <= new Date())
          throw new RouteFailure(410, { error: 'undo_expired' });
        const recordedFolderIds = Array.isArray(lease.folderIds)
          ? lease.folderIds.filter((id): id is string => typeof id === 'string')
          : [];
        const survivingFolders =
          recordedFolderIds.length === 0
            ? []
            : await tx
                .select({ id: folders.id })
                .from(folders)
                .innerJoin(projects, eq(projects.id, folders.projectId))
                .where(
                  and(
                    inArray(folders.id, recordedFolderIds),
                    eq(folders.userId, session.user.id),
                    eq(projects.userId, session.user.id),
                    isNull(projects.deletedAt),
                  ),
                );
        const paidStorage = await hasPaidMediaStorage(tx, session.user.id);
        await tx
          .update(galleryItems)
          .set({
            deletedAt: null,
            expiresAt: paidStorage ? null : (lease.previousExpiresAt ?? mediaExpiresAt(false)),
          })
          .where(eq(galleryItems.id, lease.assetId));
        if (survivingFolders.length > 0) {
          await tx
            .insert(assetPlacements)
            .values(
              survivingFolders.map((folder) => ({ assetId: lease.assetId, folderId: folder.id })),
            )
            .onConflictDoNothing();
          await ensureKeepLease(tx, lease.assetId, session.user.id);
        }
        await tx.delete(assetDeletionLeases).where(eq(assetDeletionLeases.assetId, lease.assetId));
        return { ok: true, placementsRestored: survivingFolders.length };
      });
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/v1/projects/:id/assets/preflight', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = preflightSchema.safeParse(req.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      await db.transaction((tx) => requireOwnedProject(tx, req.params.id, session.user.id));
      const accepted: Array<{ index: number; name: string }> = [];
      const rejected: Array<{ index: number; name: string; reason: string }> = [];
      parsed.data.files.forEach((file, index) => {
        const reason = uploadRejection(file);
        if (reason) rejected.push({ index, name: file.name, reason });
        else accepted.push({ index, name: file.name });
      });
      return { accepted, rejected, canUpload: rejected.length === 0 };
    } catch (error) {
      return routeFailure(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Querystring: { name?: string; folderId?: string; newFolderName?: string };
  }>('/v1/projects/:id/assets', { bodyLimit: UPLOAD_MAX_BYTES }, async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const name = (req.query.name ?? '').trim().slice(0, 255);
    const body = req.body as Buffer | undefined;
    if (!name || !Buffer.isBuffer(body) || body.length === 0)
      return reply.status(400).send({ error: 'invalid_upload' });
    const reason = uploadRejection({ name, size: body.length });
    if (reason) return reply.status(415).send({ error: 'unsupported_file', reason });
    const ext = uploadExt(name);
    if (!mediaSignatureMatches(ext, body))
      return reply.status(415).send({ error: 'invalid_media_type' });
    if (req.query.folderId && req.query.newFolderName)
      return reply.status(400).send({ error: 'ambiguous_destination' });
    const parsedNewName = req.query.newFolderName
      ? sredaFolderCreateSchema.shape.name.safeParse(req.query.newFolderName)
      : null;
    if (parsedNewName && !parsedNewName.success)
      return reply.status(400).send({ error: 'invalid_folder_name' });
    const checksum = createHash('sha256').update(body).digest('hex');
    let storedKey: string | null = null;
    try {
      // Ownership must be established before either dedupe disclosure or an
      // object-store write. A later in-transaction check still closes a race
      // with project soft-delete and triggers object cleanup on failure.
      await db.transaction((tx) => requireOwnedProject(tx, req.params.id, session.user.id));
      const [duplicate] = await db
        .select({ id: galleryItems.id })
        .from(galleryItems)
        .where(
          and(
            eq(galleryItems.userId, session.user.id),
            eq(galleryItems.checksum, checksum),
            isNull(galleryItems.deletedAt),
          ),
        )
        .limit(1);
      const assetId = duplicate?.id ?? nid();
      if (!duplicate) {
        const media = SUPPORTED_UPLOADS[ext]!;
        storedKey = `${session.user.id}/${media.kind}/${randomUUID()}.${ext}`;
        await minio.putObject(bucket, storedKey, body, body.length, { 'Content-Type': media.mime });
      }

      const resolveDestination = async (tx: Transaction): Promise<string | undefined> => {
        let destinationId = req.query.folderId;
        if (!destinationId && parsedNewName?.success) {
          destinationId = (
            await createFolder(tx, req.params.id, session.user.id, parsedNewName.data, {
              reuseExisting: true,
            })
          ).id;
        }
        return destinationId;
      };

      const persist = (id: string, insertAsset: boolean) =>
        db.transaction(async (tx) => {
          await lockMediaStorageUser(tx, session.user.id);
          await requireOwnedProject(tx, req.params.id, session.user.id);
          // Folder-name idempotency is resolved before the checksum insert, so
          // a retry always has a stable destination even when dedupe also wins.
          const destinationId = await resolveDestination(tx);
          const paidStorage = await hasPaidMediaStorage(tx, session.user.id);
          if (insertAsset) {
            const media = SUPPORTED_UPLOADS[ext]!;
            const [sameName] = await tx
              .select({ value: count() })
              .from(galleryItems)
              .where(
                and(
                  eq(galleryItems.userId, session.user.id),
                  eq(galleryItems.originalName, name),
                  isNull(galleryItems.deletedAt),
                ),
              );
            const ordinal = (sameName?.value ?? 0) + 1;
            await tx.insert(galleryItems).values({
              id,
              userId: session.user.id,
              originProjectId: req.params.id,
              assetUrl: `${publicAssetBase()}/${bucket}/${storedKey!}`,
              kind: media.kind,
              sourceKind: 'upload',
              originalName: name,
              title: ordinal > 1 ? `${name} (${ordinal})` : name,
              mimeType: media.mime,
              checksum,
              sizeBytes: body.length,
              expiresAt: mediaExpiresAt(paidStorage),
            });
          } else if (paidStorage) {
            await tx
              .update(galleryItems)
              .set({ expiresAt: null })
              .where(and(eq(galleryItems.id, id), eq(galleryItems.userId, session.user.id)));
          } else {
            await tx
              .update(galleryItems)
              .set({ expiresAt: mediaExpiresAt(false) })
              .where(
                and(
                  eq(galleryItems.id, id),
                  eq(galleryItems.userId, session.user.id),
                  isNull(galleryItems.expiresAt),
                ),
              );
          }
          const [membership] = await tx
            .select({ assetId: projectAssets.assetId })
            .from(projectAssets)
            .where(and(eq(projectAssets.projectId, req.params.id), eq(projectAssets.assetId, id)))
            .limit(1);
          await ensureMembership(tx, req.params.id, id, session.user.id);
          if (destinationId) await addPlacement(tx, id, destinationId, session.user.id);
          return {
            assetId: id,
            destinationId: destinationId ?? null,
            alreadyMember: Boolean(membership),
          };
        });

      let reused = Boolean(duplicate);
      let result: { assetId: string; destinationId: string | null; alreadyMember: boolean };
      try {
        result = await persist(assetId, !duplicate);
      } catch (error) {
        if (!duplicate && isUniqueConstraint(error, USER_CHECKSUM_CONSTRAINT)) {
          if (storedKey) {
            const losingKey = storedKey;
            await minio.removeObject(bucket, losingKey);
            storedKey = null;
          }
          result = await db.transaction(async (tx) => {
            await lockMediaStorageUser(tx, session.user.id);
            await requireOwnedProject(tx, req.params.id, session.user.id);
            // Preserve the required conflict order on the recovery path too.
            const destinationId = await resolveDestination(tx);
            const [winner] = await tx
              .select({ id: galleryItems.id })
              .from(galleryItems)
              .where(
                and(
                  eq(galleryItems.userId, session.user.id),
                  eq(galleryItems.checksum, checksum),
                  isNull(galleryItems.deletedAt),
                ),
              )
              .limit(1);
            if (!winner) throw error;
            const [membership] = await tx
              .select({ assetId: projectAssets.assetId })
              .from(projectAssets)
              .where(
                and(
                  eq(projectAssets.projectId, req.params.id),
                  eq(projectAssets.assetId, winner.id),
                ),
              )
              .limit(1);
            await ensureMembership(tx, req.params.id, winner.id, session.user.id);
            if (destinationId) await addPlacement(tx, winner.id, destinationId, session.user.id);
            return {
              assetId: winner.id,
              destinationId: destinationId ?? null,
              alreadyMember: Boolean(membership),
            };
          });
          reused = true;
        } else {
          throw error;
        }
      }
      return reply.status(reused ? 200 : 201).send({
        ...result,
        reused,
        receipt: reused
          ? result.alreadyMember
            ? 'Уже в этом проекте'
            : 'Уже есть в библиотеке'
          : 'Материал загружен',
      });
    } catch (error) {
      if (storedKey) await minio.removeObject(bucket, storedKey).catch(() => {});
      return routeFailure(reply, error);
    }
  });
}
