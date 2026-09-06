import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type IORedis from 'ioredis';
import { z } from 'zod';
import { boardSnapshots, boards, db, nid, studioProjects } from '@seed/db';
import {
  BOARD_LIMITS,
  BOARD_SCHEMA_VERSION,
  parseBoardDocument,
  safeParseBoardDocument,
  type BoardDocument,
} from '@seed/shared/board-contract';
import { validateOwnedLiveProject, workspaceProjectIdSchema } from './project-context';
import { resolveAvailableOwnedAssets, syncAssetReferences } from './asset-references';
import { checkSlidingWindowRateLimit } from './rate-limit';
import {
  BOARD_SNAPSHOT_RETENTION,
  BOARD_TRASH_RETENTION_DAYS,
  BOARD_TRASH_RETENTION_MS,
  forceBoardSnapshot,
  writeBoardSnapshot,
} from './board-snapshots';
import {
  decodeProjectListCursor,
  encodeProjectListCursor,
  projectListContext,
} from './project-list-cursor';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

const MAX_BOARDS = 50;
const MAX_STUDIO_PROJECTS = 50;
const MAX_UPDATE_BODY_BYTES = BOARD_LIMITS.stateBytes * 2;
const MAX_BOARD_REV = Number.MAX_SAFE_INTEGER - 1;
const BOARD_SAVE_RATE_LIMIT = 120;
const BOARD_SAVE_RATE_WINDOW_SECONDS = 5 * 60;

const listSchema = z
  .object({
    projectId: workspaceProjectIdSchema.optional(),
    cursor: z.string().max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const createSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  projectId: workspaceProjectIdSchema.optional(),
});
const projectResolverParamsSchema = z.object({ projectId: workspaceProjectIdSchema });
const updateSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  state: z.unknown().optional(),
  rev: z.number().int().nonnegative().max(MAX_BOARD_REV).optional(),
});
const duplicateSchema = z.object({ title: z.string().trim().min(1).max(80).optional() }).strict();
const resetSchema = z.object({ confirmation: z.literal(true) }).strict();
const importBodySchema = z.record(z.unknown());
const studioHandoffSchema = z
  .object({
    destination: z.enum(['new', 'studio']).default('new'),
    studioProjectId: z.string().trim().min(1).max(160).optional(),
    title: z.string().trim().min(1).max(80).optional(),
    idempotencyKey: z.string().trim().min(8).max(128),
    clips: z
      .array(
        z
          .object({
            uid: z.string().trim().min(1).max(160),
            url: z.string().trim().min(1).max(4_096),
            dur: z.number().finite().positive().max(86_400),
            inSec: z.number().finite().nonnegative().max(86_400),
            outSec: z.number().finite().positive().max(86_400),
            speed: z.number().finite().positive().max(8),
            muted: z.boolean(),
            volumeDb: z.number().finite().min(-80).max(40),
            transition: z.string().max(40),
            transitionSec: z.number().finite().nonnegative().max(10),
            filter: z.string().max(40),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.destination === 'studio' && !value.studioProjectId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studioProjectId'],
        message: 'studioProjectId is required',
      });
    }
  });

function storedBoardRevision(state: unknown): number {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return 0;
  const rev = (state as Record<string, unknown>).__rev;
  return Number.isSafeInteger(rev) && (rev as number) >= 0 ? (rev as number) : 0;
}

function boardAssetReferences(state: ReturnType<typeof parseBoardDocument>) {
  return state.nodes.flatMap((node) => {
    if (node.type !== 'media' && node.type !== 'generate') return [];
    const data = node.data as { assetId?: string };
    return data.assetId ? [{ assetId: data.assetId, slotId: node.id }] : [];
  });
}

function boardThumbnailUrl(state: unknown): string | null {
  const parsed = safeParseBoardDocument(state);
  if (!parsed.success) return null;
  for (const node of parsed.data.nodes) {
    if (node.type === 'generate') {
      const data = node.data as {
        status?: string;
        resultUrl?: string;
        takes?: string[];
        lastFrameUrl?: string;
      };
      if (data.status === 'done' && data.takes?.[0]) return data.takes[0];
      if (data.status === 'done' && data.resultUrl) return data.resultUrl;
      if (data.status === 'done' && data.lastFrameUrl) return data.lastFrameUrl;
    }
    if (node.type === 'media') {
      const url = (node.data as { url?: string }).url;
      if (url) return url;
    }
  }
  return null;
}

function boardStateError(
  board: { id: string; title: string; state: unknown },
  recoveryAvailable: boolean,
) {
  return {
    error: 'invalid_board_state',
    code: 'BOARD_STATE_INVALID',
    message: 'Состояние борда повреждено. Восстановите последнюю копию или сбросьте борд.',
    boardId: board.id,
    title: board.title,
    rev: storedBoardRevision(board.state),
    recoveryAvailable,
  };
}

function importedTitle(title: string): string {
  const suffix = ' (импорт)';
  return `${title.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function importedDocumentWithOwnedAssets(
  document: BoardDocument,
  ownedAssets: ReadonlyMap<string, { assetUrl: string; kind: string }>,
): { document: BoardDocument; placeholders: number } {
  let placeholders = 0;
  const nodes = document.nodes.map((node) => {
    if (node.type === 'media') {
      const data = node.data as { assetId?: string; url: string; mediaKind: 'image' | 'video' };
      if (!data.assetId) return node;
      const owned = ownedAssets.get(data.assetId);
      if (owned) {
        return { ...node, data: { ...data, url: owned.assetUrl } };
      }
      placeholders += 1;
      const { assetId: _assetId, ...placeholderData } = data;
      return { ...node, data: { ...placeholderData, url: '' } };
    }
    if (node.type === 'generate') {
      const data = node.data as {
        assetId?: string;
        resultUrl?: string;
        resultKind?: 'image' | 'video';
        lastFrameUrl?: string;
        takes?: string[];
        status: 'idle' | 'running' | 'done' | 'failed';
      };
      if (!data.assetId) return node;
      const owned = ownedAssets.get(data.assetId);
      if (owned) return { ...node, data: { ...data, resultUrl: owned.assetUrl } };
      placeholders += 1;
      const {
        assetId: _assetId,
        resultUrl: _resultUrl,
        resultKind: _resultKind,
        lastFrameUrl: _lastFrameUrl,
        takes: _takes,
        ...placeholderData
      } = data;
      return {
        ...node,
        data: { ...placeholderData, status: 'idle' as const },
      };
    }
    return node;
  });
  return { document: parseBoardDocument({ ...document, nodes }), placeholders };
}

function snapshotCounts(state: unknown): {
  nodeCount: number;
  edgeCount: number;
  trayCount: number;
} {
  const parsed = safeParseBoardDocument(state);
  return parsed.success
    ? {
        nodeCount: parsed.data.nodes.length,
        edgeCount: parsed.data.edges.length,
        trayCount: parsed.data.tray.length,
      }
    : { nodeCount: 0, edgeCount: 0, trayCount: 0 };
}

export interface BoardRoutesOptions {
  redis?: IORedis;
}

/** Борд project workspaces — CRUD over versioned, runtime-validated documents. */
export function setupBoardRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: BoardRoutesOptions = {},
): void {
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/v1/boards',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const { projectId, limit } = parsed.data;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const context = projectListContext(projectId);
      const cursor = parsed.data.cursor
        ? decodeProjectListCursor(parsed.data.cursor, {
            scope: 'boards',
            ownerId: session.user.id,
            context,
          })
        : null;
      if (parsed.data.cursor && !cursor) {
        return reply.status(400).send({ error: 'invalid_cursor' });
      }
      const rows = await db
        .select({
          id: boards.id,
          projectId: boards.projectId,
          title: boards.title,
          createdAt: boards.createdAt,
          updatedAt: boards.updatedAt,
          state: boards.state,
        })
        .from(boards)
        .where(
          and(
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
            ...(projectId ? [eq(boards.projectId, projectId)] : []),
            ...(cursor
              ? [
                  or(
                    lt(boards.updatedAt, cursor.updatedAt),
                    and(eq(boards.updatedAt, cursor.updatedAt), lt(boards.id, cursor.id)),
                  )!,
                ]
              : []),
          ),
        )
        .orderBy(desc(boards.updatedAt), desc(boards.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const items = (more ? rows.slice(0, limit) : rows).map(({ state, ...row }) => ({
        ...row,
        thumbnailUrl: boardThumbnailUrl(state),
      }));
      const last = items[items.length - 1];
      return {
        items,
        nextCursor:
          more && last
            ? encodeProjectListCursor({
                scope: 'boards',
                ownerId: session.user.id,
                context,
                updatedAt: last.updatedAt,
                id: last.id,
              })
            : null,
      };
    },
  );

  app.get<{ Querystring: { projectId?: string; limit?: string } }>(
    '/v1/boards/trash',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const { projectId, limit } = parsed.data;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const rows = await db
        .select({
          id: boards.id,
          projectId: boards.projectId,
          title: boards.title,
          createdAt: boards.createdAt,
          updatedAt: boards.updatedAt,
          trashedAt: boards.trashedAt,
          state: boards.state,
        })
        .from(boards)
        .where(
          and(
            eq(boards.userId, session.user.id),
            isNotNull(boards.trashedAt),
            ...(projectId ? [eq(boards.projectId, projectId)] : []),
          ),
        )
        .orderBy(desc(boards.trashedAt), desc(boards.id))
        .limit(limit);
      return {
        retentionDays: BOARD_TRASH_RETENTION_DAYS,
        items: rows.map(({ state, trashedAt, ...row }) => ({
          ...row,
          trashedAt,
          purgeAfter: trashedAt ? new Date(trashedAt.getTime() + BOARD_TRASH_RETENTION_MS) : null,
          thumbnailUrl: boardThumbnailUrl(state),
        })),
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/resolve/boards',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = projectResolverParamsSchema.safeParse(req.params);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const projectId = parsed.data.projectId;
      const intent = `workspace-resolve:${session.user.id}:${projectId}:boards`;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${intent}))`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`board-capacity:${session.user.id}`}))`,
        );
        if (!(await validateOwnedLiveProject(tx, projectId, session.user.id))) {
          return { kind: 'not_found' as const };
        }
        const [existing] = await tx
          .select({ id: boards.id })
          .from(boards)
          .where(
            and(
              eq(boards.userId, session.user.id),
              eq(boards.projectId, projectId),
              isNull(boards.trashedAt),
            ),
          )
          .orderBy(desc(boards.updatedAt), desc(boards.id))
          .limit(1);
        if (existing) return { kind: 'document' as const, id: existing.id };
        const count = await tx
          .select({ id: boards.id })
          .from(boards)
          .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
        if (count.length >= MAX_BOARDS) return { kind: 'limit' as const };
        const [created] = await tx
          .insert(boards)
          .values({
            id: nid(),
            userId: session.user.id,
            projectId,
            state: parseBoardDocument({ __rev: 0 }),
          })
          .returning({ id: boards.id });
        return { kind: 'document' as const, id: created!.id };
      });
      if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (outcome.kind === 'limit') return { destination: 'list' as const };
      return { destination: 'document' as const, id: outcome.id };
    },
  );

  app.post('/v1/boards', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`board-capacity:${session.user.id}`}))`,
      );
      if (
        parsed.data.projectId &&
        !(await validateOwnedLiveProject(tx, parsed.data.projectId, session.user.id))
      ) {
        return { kind: 'not_found' as const };
      }
      const existing = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
      if (existing.length >= MAX_BOARDS) return { kind: 'limit' as const };
      const [row] = await tx
        .insert(boards)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: parsed.data.projectId ?? null,
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          state: parseBoardDocument({ __rev: 0 }),
        })
        .returning();
      return { kind: 'created' as const, row };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_boards', max: MAX_BOARDS });
    }
    return reply.status(201).send(outcome.row);
  });

  app.post<{ Params: { id: string } }>('/v1/boards/:id/studio-handoff', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = studioHandoffSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const input = parsed.data;
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          boardId: req.params.id,
          destination: input.destination,
          studioProjectId: input.studioProjectId ?? null,
          title: input.title ?? null,
          clips: input.clips,
        }),
      )
      .digest('hex');

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${session.user.id}:board-studio:${input.idempotencyKey}`}))`,
      );
      const [board] = await tx
        .select({ id: boards.id, projectId: boards.projectId, title: boards.title })
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1);
      if (!board) return { kind: 'not_found' as const };
      if (!board.projectId) return { kind: 'standalone_board' as const };
      if (!(await validateOwnedLiveProject(tx, board.projectId, session.user.id))) {
        return { kind: 'project_unavailable' as const };
      }

      const [keyReplay] = await tx
        .select({
          id: studioProjects.id,
          projectId: studioProjects.projectId,
          title: studioProjects.title,
          timeline: studioProjects.timeline,
        })
        .from(studioProjects)
        .where(
          and(
            eq(studioProjects.userId, session.user.id),
            sql`${studioProjects.timeline}->'__boardHandoff'->>'idempotencyKey' = ${input.idempotencyKey}`,
          ),
        )
        .limit(1);
      if (keyReplay) {
        const metadata = (keyReplay.timeline as { __boardHandoff?: unknown }).__boardHandoff as
          | { requestHash?: unknown }
          | undefined;
        if (metadata?.requestHash !== requestHash) {
          return { kind: 'idempotency_mismatch' as const };
        }
        return {
          kind: 'replayed' as const,
          studio: keyReplay,
          workspaceProjectId: board.projectId,
        };
      }

      const metadata = {
        idempotencyKey: input.idempotencyKey,
        requestHash,
        sourceBoardId: board.id,
        clipCount: input.clips.length,
      };
      const timeline = {
        schemaVersion: 2,
        tracks: [{ id: 'track-0', kind: 'video', clips: input.clips }],
        texts: [],
        popText: null,
        music: null,
        voiceover: null,
        sfx: [],
        formatId: '9:16',
        bgColor: null,
        __boardHandoff: metadata,
      };

      if (input.destination === 'studio') {
        const [studio] = await tx
          .select({
            id: studioProjects.id,
            projectId: studioProjects.projectId,
            title: studioProjects.title,
          })
          .from(studioProjects)
          .where(
            and(
              eq(studioProjects.id, input.studioProjectId!),
              eq(studioProjects.userId, session.user.id),
            ),
          )
          .limit(1);
        if (!studio) return { kind: 'studio_not_found' as const };
        if (studio.projectId !== board.projectId) {
          return {
            kind: 'project_mismatch' as const,
            boardProjectId: board.projectId,
            studioProjectId: studio.projectId,
          };
        }
        await tx
          .update(studioProjects)
          .set({ timeline, updatedAt: new Date() })
          .where(eq(studioProjects.id, studio.id));
        return {
          kind: 'updated' as const,
          studio,
          workspaceProjectId: board.projectId,
        };
      }

      const count = await tx
        .select({ id: studioProjects.id })
        .from(studioProjects)
        .where(eq(studioProjects.userId, session.user.id));
      if (count.length >= MAX_STUDIO_PROJECTS) return { kind: 'limit' as const };
      const [studio] = await tx
        .insert(studioProjects)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: board.projectId,
          title: input.title ?? `${board.title.slice(0, 68)} · Монтаж`,
          timeline,
        })
        .returning({
          id: studioProjects.id,
          projectId: studioProjects.projectId,
          title: studioProjects.title,
        });
      return {
        kind: 'created' as const,
        studio: studio!,
        workspaceProjectId: board.projectId,
      };
    });

    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'standalone_board') {
      return reply.status(409).send({ error: 'board_not_project_scoped' });
    }
    if (outcome.kind === 'project_unavailable') {
      return reply.status(404).send({ error: 'project_context_unavailable' });
    }
    if (outcome.kind === 'studio_not_found') {
      return reply.status(404).send({ error: 'studio_project_not_found' });
    }
    if (outcome.kind === 'project_mismatch') {
      return reply.status(409).send({
        error: 'project_mismatch',
        boardProjectId: outcome.boardProjectId,
        studioProjectId: outcome.studioProjectId,
      });
    }
    if (outcome.kind === 'idempotency_mismatch') {
      return reply.status(409).send({ error: 'idempotency_payload_mismatch' });
    }
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_projects', max: MAX_STUDIO_PROJECTS });
    }
    const body = {
      studioProjectId: outcome.studio.id,
      title: outcome.studio.title,
      workspaceProjectId: outcome.workspaceProjectId,
      created: outcome.kind === 'created',
      replayed: outcome.kind === 'replayed',
      clipCount: input.clips.length,
    };
    return outcome.kind === 'created' ? reply.status(201).send(body) : body;
  });

  app.patch<{ Params: { id: string } }>('/v1/boards/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success || parsed.data.title === undefined || parsed.data.state !== undefined) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    const updated = await db
      .update(boards)
      .set({ title: parsed.data.title, updatedAt: new Date() })
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .returning({ id: boards.id, title: boards.title });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, title: updated[0]!.title };
  });

  app.post<{ Params: { id: string } }>('/v1/boards/:id/duplicate', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = duplicateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`board-capacity:${session.user.id}`}))`,
      );
      const [source] = await tx
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1);
      if (!source) return { kind: 'not_found' as const };
      const count = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
      if (count.length >= MAX_BOARDS) return { kind: 'limit' as const };
      const state = safeParseBoardDocument(source.state);
      if (!state.success) return { kind: 'corrupt' as const };
      const copiedState = parseBoardDocument({ ...state.data, __rev: 0 });
      const [copy] = await tx
        .insert(boards)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: source.projectId,
          title: parsed.data.title ?? `${source.title.slice(0, 73)} (копия)`,
          state: copiedState,
          shareToken: null,
        })
        .returning();
      await syncAssetReferences(tx, {
        userId: session.user.id,
        refType: 'board_node',
        resourceId: copy!.id,
        references: boardAssetReferences(copiedState),
      });
      return { kind: 'created' as const, row: copy! };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_boards', max: MAX_BOARDS });
    }
    if (outcome.kind === 'corrupt') {
      return reply.status(409).send({
        error: 'invalid_board_state',
        code: 'BOARD_STATE_INVALID',
        message: 'Сначала восстановите или сбросьте повреждённый борд.',
      });
    }
    return reply.status(201).send(outcome.row);
  });

  app.post<{ Params: { id: string } }>('/v1/boards/:id/restore', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const now = new Date();
    const result = await db.transaction(async (tx) => {
      // Serialize restore/create/import/duplicate capacity checks for this user.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`board-capacity:${session.user.id}`}))`,
      );
      const [trashed] = await tx
        .select({ trashedAt: boards.trashedAt })
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNotNull(boards.trashedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!trashed) return { kind: 'not_found' as const };
      if (
        !trashed.trashedAt ||
        trashed.trashedAt.getTime() <= now.getTime() - BOARD_TRASH_RETENTION_MS
      ) {
        return { kind: 'expired' as const };
      }
      const active = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
      if (active.length >= MAX_BOARDS) return { kind: 'limit' as const };
      await tx
        .update(boards)
        .set({ trashedAt: null, updatedAt: now })
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNotNull(boards.trashedAt),
          ),
        );
      return { kind: 'restored' as const };
    });
    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (result.kind === 'expired') return reply.status(410).send({ error: 'trash_expired' });
    if (result.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_boards', max: MAX_BOARDS });
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/v1/boards/:id/export.json', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [board] = await db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .limit(1);
    if (!board) return reply.status(404).send({ error: 'not_found' });
    const state = safeParseBoardDocument(board.state);
    if (!state.success) {
      return reply.status(409).send(boardStateError(board, false));
    }
    reply.header('content-disposition', `attachment; filename="${board.id}.json"`);
    return {
      manifest: {
        format: 'vertov-board',
        formatVersion: 1,
        schemaVersion: BOARD_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        title: board.title,
        assetPolicy: 'references-only',
      },
      document: state.data,
    };
  });

  app.post('/v1/boards/import', { bodyLimit: MAX_UPDATE_BODY_BYTES }, async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsedBody = importBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) return reply.status(400).send({ error: 'invalid_import' });
    const body = parsedBody.data;
    const source = isRecord(body.export) ? body.export : body;
    const manifest = isRecord(source.manifest) ? source.manifest : null;
    const rawDocument = source.document ?? source.state;
    const requestedSchema =
      manifest?.schemaVersion ?? (isRecord(rawDocument) ? rawDocument.schemaVersion : undefined);
    if (requestedSchema !== BOARD_SCHEMA_VERSION) {
      return reply.status(400).send({
        error: 'unsupported_schema_version',
        message: `Этот файл использует неподдерживаемую версию схемы (${String(requestedSchema ?? 'не указана')}).`,
        supportedSchemaVersions: [BOARD_SCHEMA_VERSION],
      });
    }
    const normalized = safeParseBoardDocument(rawDocument);
    if (!normalized.success) {
      return reply.status(400).send({
        error: 'invalid_import',
        message: 'Файл не содержит корректный документ борда.',
        issues: normalized.error.issues,
      });
    }
    const requestedProject = body.projectId;
    const projectId =
      requestedProject === undefined
        ? null
        : workspaceProjectIdSchema.safeParse(requestedProject).success
          ? String(requestedProject)
          : undefined;
    if (projectId === undefined)
      return reply.status(400).send({ error: 'invalid_project_context' });
    const assetIds = normalized.data.nodes.flatMap((node) => {
      if (node.type !== 'media' && node.type !== 'generate') return [];
      const assetId = (node.data as { assetId?: string }).assetId;
      return assetId ? [assetId] : [];
    });
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`board-capacity:${session.user.id}`}))`,
      );
      if (projectId && !(await validateOwnedLiveProject(tx, projectId, session.user.id))) {
        return { kind: 'not_found' as const };
      }
      const count = await tx
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
      if (count.length >= MAX_BOARDS) return { kind: 'limit' as const };
      const owned = await resolveAvailableOwnedAssets(tx, session.user.id, assetIds);
      const sanitized = importedDocumentWithOwnedAssets(normalized.data, owned);
      const state = parseBoardDocument({ ...sanitized.document, __rev: 0 });
      const sourceTitle =
        typeof manifest?.title === 'string' && manifest.title.trim().length > 0
          ? manifest.title.trim().slice(0, 80)
          : 'Новый борд';
      const [row] = await tx
        .insert(boards)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId,
          title: importedTitle(sourceTitle),
          state,
          shareToken: null,
        })
        .returning();
      await syncAssetReferences(tx, {
        userId: session.user.id,
        refType: 'board_node',
        resourceId: row!.id,
        references: boardAssetReferences(state),
      });
      return { kind: 'created' as const, row: row!, placeholders: sanitized.placeholders };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_boards', max: MAX_BOARDS });
    }
    return reply.status(201).send({ ...outcome.row, placeholders: outcome.placeholders });
  });

  app.get<{ Params: { id: string } }>('/v1/boards/:id/snapshots', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [board] = await db
      .select({ id: boards.id })
      .from(boards)
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .limit(1);
    if (!board) return reply.status(404).send({ error: 'not_found' });
    const rows = await db
      .select()
      .from(boardSnapshots)
      .where(eq(boardSnapshots.boardId, board.id))
      .orderBy(desc(boardSnapshots.createdAt), desc(boardSnapshots.id))
      .limit(BOARD_SNAPSHOT_RETENTION);
    return {
      items: rows.map((snapshot) => ({
        id: snapshot.id,
        rev: snapshot.rev,
        reason: snapshot.reason,
        createdAt: snapshot.createdAt,
        ...snapshotCounts(snapshot.state),
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/boards/:id/snapshots', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const result = await db.transaction(async (tx) => {
      const [board] = await tx
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1);
      if (!board) return { kind: 'not_found' as const };
      const state = safeParseBoardDocument(board.state);
      if (!state.success) return { kind: 'corrupt' as const };
      await writeBoardSnapshot(tx, {
        boardId: board.id,
        rev: storedBoardRevision(board.state),
        state: state.data,
        reason: 'manual',
        respectAutosaveCadence: false,
      });
      return { kind: 'created' as const };
    });
    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (result.kind === 'corrupt') return reply.status(409).send({ error: 'invalid_board_state' });
    return { ok: true };
  });

  app.post<{ Params: { id: string; snapshotId: string } }>(
    '/v1/boards/:id/snapshots/:snapshotId/restore',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const result = await db.transaction(async (tx) => {
        const [board] = await tx
          .select()
          .from(boards)
          .where(
            and(
              eq(boards.id, req.params.id),
              eq(boards.userId, session.user.id),
              isNull(boards.trashedAt),
            ),
          )
          .limit(1)
          .for('update');
        if (!board) return { kind: 'not_found' as const };
        const [snapshot] = await tx
          .select()
          .from(boardSnapshots)
          .where(
            and(eq(boardSnapshots.id, req.params.snapshotId), eq(boardSnapshots.boardId, board.id)),
          )
          .limit(1);
        if (!snapshot) return { kind: 'snapshot_not_found' as const };
        const restored = safeParseBoardDocument(snapshot.state);
        const current = safeParseBoardDocument(board.state);
        if (!restored.success) return { kind: 'corrupt' as const };
        const nextRev = storedBoardRevision(board.state) + 1;
        if (nextRev > MAX_BOARD_REV) return { kind: 'rev_exhausted' as const };
        // A corrupt current document is precisely one of the recovery cases;
        // there is nothing safe to append for it, but the selected validated
        // snapshot can still be restored as a new revision.
        if (current.success) {
          await writeBoardSnapshot(tx, {
            boardId: board.id,
            rev: storedBoardRevision(board.state),
            state: current.data,
            reason: 'manual',
            respectAutosaveCadence: false,
          });
        }
        const state = parseBoardDocument({ ...restored.data, __rev: nextRev });
        await tx
          .update(boards)
          .set({ state, updatedAt: new Date() })
          .where(eq(boards.id, board.id));
        await syncAssetReferences(tx, {
          userId: session.user.id,
          refType: 'board_node',
          resourceId: board.id,
          references: boardAssetReferences(state),
        });
        await writeBoardSnapshot(tx, {
          boardId: board.id,
          rev: nextRev,
          state,
          reason: 'manual',
          respectAutosaveCadence: false,
        });
        return { kind: 'restored' as const, rev: nextRev };
      });
      if (result.kind === 'not_found' || result.kind === 'snapshot_not_found') {
        return reply.status(404).send({ error: 'not_found' });
      }
      if (result.kind === 'corrupt')
        return reply.status(409).send({ error: 'invalid_board_state' });
      if (result.kind === 'rev_exhausted')
        return reply.status(409).send({ error: 'rev_exhausted' });
      return { ok: true, rev: result.rev };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/boards/:id/reset', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'confirmation_required' });
    const result = await db.transaction(async (tx) => {
      const [board] = await tx
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!board) return { kind: 'not_found' as const };
      const current = safeParseBoardDocument(board.state);
      const nextRev = storedBoardRevision(board.state) + 1;
      if (nextRev > MAX_BOARD_REV) return { kind: 'rev_exhausted' as const };
      if (current.success) {
        await forceBoardSnapshot(tx, board.id, storedBoardRevision(board.state), current.data);
      }
      const state = parseBoardDocument({ __rev: nextRev });
      await tx
        .update(boards)
        .set({
          state,
          stateBackup: (isRecord(board.state) ? board.state : { value: board.state }) as Record<
            string,
            unknown
          >,
          stateBackupAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(boards.id, board.id));
      await syncAssetReferences(tx, {
        userId: session.user.id,
        refType: 'board_node',
        resourceId: board.id,
        references: [],
      });
      await writeBoardSnapshot(tx, {
        boardId: board.id,
        rev: nextRev,
        state,
        reason: 'manual',
        respectAutosaveCadence: false,
      });
      return { kind: 'reset' as const, rev: nextRev };
    });
    if (result.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (result.kind === 'rev_exhausted') return reply.status(409).send({ error: 'rev_exhausted' });
    return { ok: true, rev: result.rev };
  });

  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>(
    '/v1/boards/:id',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = listSchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const projectId = parsed.data.projectId;
      if (projectId && !(await validateOwnedLiveProject(db, projectId, session.user.id))) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const rows = await db
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNull(boards.trashedAt),
          ),
        )
        .limit(1);
      const board = rows[0];
      if (!board) return reply.status(404).send({ error: 'not_found' });
      if (projectId && board.projectId !== projectId) {
        return reply.status(409).send({
          error: 'project_mismatch',
          expectedProjectId: projectId,
          actualProjectId: board.projectId,
        });
      }
      const state = safeParseBoardDocument(board.state);
      if (!state.success) {
        const recovery = await db
          .select({ id: boardSnapshots.id })
          .from(boardSnapshots)
          .where(eq(boardSnapshots.boardId, board.id))
          .limit(1);
        req.log.error(
          { boardId: board.id, issues: state.error.issues },
          'stored board document failed validation',
        );
        return reply.status(409).send(boardStateError(board, recovery.length > 0));
      }
      return { ...board, state: state.data };
    },
  );

  app.put<{ Params: { id: string } }>(
    '/v1/boards/:id',
    { bodyLimit: MAX_UPDATE_BODY_BYTES },
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (options.redis) {
        const limit = await checkSlidingWindowRateLimit(
          options.redis,
          `seed:boards:save:${session.user.id}`,
          BOARD_SAVE_RATE_LIMIT,
          BOARD_SAVE_RATE_WINDOW_SECONDS,
        );
        if (!limit.allowed) {
          reply.header('retry-after', String(Math.max(1, limit.retryAfterSeconds)));
          return reply.status(429).send({
            error: 'rate_limited',
            message: 'Сохранений слишком много. Автосохранение продолжится автоматически.',
            retryAfterSeconds: Math.max(1, limit.retryAfterSeconds),
          });
        }
      }
      const parsed = updateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
      if (parsed.data.state !== undefined && parsed.data.rev === undefined) {
        return reply.status(400).send({ error: 'rev_required' });
      }
      if (
        parsed.data.state !== undefined &&
        Buffer.byteLength(JSON.stringify(parsed.data.state), 'utf8') > BOARD_LIMITS.stateBytes
      ) {
        return reply.status(400).send({ error: 'state_too_large' });
      }
      const normalizedState =
        parsed.data.state !== undefined ? safeParseBoardDocument(parsed.data.state) : null;
      if (normalizedState && !normalizedState.success) {
        return reply.status(400).send({
          error: 'invalid_state',
          issues: normalizedState.error.issues,
        });
      }
      if (parsed.data.state !== undefined && parsed.data.rev !== undefined) {
        const nextRev = parsed.data.rev + 1;
        if (nextRev > MAX_BOARD_REV) return reply.status(409).send({ error: 'rev_exhausted' });
        const stamped = { ...normalizedState!.data, __rev: nextRev };
        const updated = await db.transaction(async (tx) => {
          const rows = await tx
            .update(boards)
            .set({
              ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
              state: stamped,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(boards.id, req.params.id),
                eq(boards.userId, session.user.id),
                isNull(boards.trashedAt),
                sql`COALESCE(
              CASE
                WHEN jsonb_typeof(${boards.state}->'__rev') = 'number'
                THEN (${boards.state}->>'__rev')::numeric
                ELSE 0
              END,
              0
            ) = ${parsed.data.rev}`,
              ),
            )
            .returning({ id: boards.id });
          if (rows.length > 0) {
            await syncAssetReferences(tx, {
              userId: session.user.id,
              refType: 'board_node',
              resourceId: req.params.id,
              references: boardAssetReferences(normalizedState!.data),
            });
            await writeBoardSnapshot(tx, {
              boardId: req.params.id,
              rev: nextRev,
              state: parseBoardDocument(stamped),
              reason: 'autosave',
            });
          }
          return rows;
        });
        if (updated.length > 0) return { ok: true, rev: nextRev };
        const existing = await db
          .select({ id: boards.id, state: boards.state })
          .from(boards)
          .where(
            and(
              eq(boards.id, req.params.id),
              eq(boards.userId, session.user.id),
              isNull(boards.trashedAt),
            ),
          )
          .limit(1);
        if (existing.length === 0) return reply.status(404).send({ error: 'not_found' });
        return reply
          .status(409)
          .send({ error: 'rev_conflict', rev: storedBoardRevision(existing[0]!.state) });
      }
      const updated = await db.transaction(async (tx) => {
        const rows = await tx
          .update(boards)
          .set({
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(normalizedState?.success ? { state: normalizedState.data } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(boards.id, req.params.id),
              eq(boards.userId, session.user.id),
              isNull(boards.trashedAt),
            ),
          )
          .returning({ id: boards.id });
        if (rows.length > 0 && normalizedState?.success) {
          await syncAssetReferences(tx, {
            userId: session.user.id,
            refType: 'board_node',
            resourceId: req.params.id,
            references: boardAssetReferences(normalizedState.data),
          });
        }
        return rows;
      });
      if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/boards/:id/permanent', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const deleted = await db.transaction(async (tx) => {
      const [board] = await tx
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.id, req.params.id),
            eq(boards.userId, session.user.id),
            isNotNull(boards.trashedAt),
          ),
        )
        .limit(1)
        .for('update');
      if (!board) return { kind: 'not_found' as const };
      const state = safeParseBoardDocument(board.state);
      if (!state.success) return { kind: 'corrupt' as const };
      await forceBoardSnapshot(tx, board.id, storedBoardRevision(board.state), state.data);
      await syncAssetReferences(tx, {
        userId: session.user.id,
        refType: 'board_node',
        resourceId: board.id,
        references: [],
      });
      await tx.delete(boards).where(eq(boards.id, board.id));
      return { kind: 'deleted' as const };
    });
    if (deleted.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (deleted.kind === 'corrupt') {
      return reply.status(409).send({
        error: 'invalid_board_state',
        code: 'BOARD_STATE_INVALID',
        message: 'Сначала сбросьте повреждённый борд, затем удалите его навсегда.',
      });
    }
    return { ok: true, permanent: true };
  });

  app.delete<{ Params: { id: string } }>('/v1/boards/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const now = new Date();
    const trashed = await db
      .update(boards)
      .set({ trashedAt: now, shareToken: null, updatedAt: now })
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .returning({ id: boards.id, trashedAt: boards.trashedAt });
    if (trashed.length > 0) return { ok: true, trashedAt: trashed[0]!.trashedAt };
    const [existing] = await db
      .select({ id: boards.id, trashedAt: boards.trashedAt })
      .from(boards)
      .where(and(eq(boards.id, req.params.id), eq(boards.userId, session.user.id)))
      .limit(1);
    if (!existing) return reply.status(404).send({ error: 'not_found' });
    if (existing.trashedAt)
      return { ok: true, alreadyTrashed: true, trashedAt: existing.trashedAt };
    return reply.status(404).send({ error: 'not_found' });
  });
}
