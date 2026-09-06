import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  boards,
  db,
  nid,
  scripts,
  scriptMaterials,
  scriptSnapshots,
  scriptSceneTimings,
  scriptShotPlans,
  scriptThreadMessages,
  scriptThreads,
} from '@seed/db';
import {
  EXAMPLE_BIBLE,
  EXAMPLE_FOUNTAIN,
  EXAMPLE_MATERIAL,
  EXAMPLE_TITLE,
  exampleThread,
} from './scenario-example';
import {
  exportFdx,
  exportFountain,
  exportPdf,
  extractText,
  importDocx,
  importFdx,
  importFountain,
  importHighland,
  importPdf,
  parseFountain,
  scriptStats,
  sceneTimings,
  type ImportResult,
} from '@seed/screenplay';
import {
  EMPTY_SCENARIO_BRIEF,
  EMPTY_SCENARIO_OUTLINE,
  MATERIAL_SUMMARY_MIN_RAW_CHARS,
  safeParseBoardDocument,
  scenarioBriefV1Schema,
  scenarioFormatSchema,
  scenarioOutlineV1Schema,
  type BoardDocument,
} from '@seed/shared';
import {
  boardLinksToScript,
  extractScenarioHandoffSources,
  mergeScenarioScenesIntoBoard,
  ScenarioBoardMaterializationLimitError,
} from './scenario-board-handoff';
import { scenarioBoardHandoffs, scenarioMaterialCompactions } from './metrics';
import { validateOwnedLiveProject, workspaceProjectIdSchema } from './project-context';
import {
  decodeProjectListCursor,
  encodeProjectListCursor,
  projectListContext,
} from './project-list-cursor';
import {
  SCENARIO_TIMING_POLICY_VERSION,
  scenarioTimingIsStale,
  scenarioTimingSourceRevisionId,
  scenarioTimingSourceUnitId,
} from './scenario-timing';
import { scenarioShotPlanSchema } from '@seed/shared/scenario-shot-plan';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

const MAX_SCRIPTS = 100;
const MAX_BOARDS = 50;
const MAX_HANDOFF_SCENES = 100;
const MAX_BOARD_STATE_BYTES = 1_048_576;
const MAX_FOUNTAIN_BYTES = 2_000_000; // ~350k words of screenplay — plenty
const MAX_IMPORT_BYTES = 20_000_000; // pdf/docx uploads
/** Autosave snapshots are throttled; manual/apply/restore always snapshot. */
const AUTOSAVE_SNAPSHOT_MIN_MS = 10 * 60 * 1000;

/**
 * «Материалы проекта» ceilings (server-enforced; adding beyond them is
 * blocked with a clear RU message, never silently truncated). All materials
 * are always in every AI call, so the total is what bounds prompt cost.
 */
const MAX_MATERIALS = 10;
const MAX_MATERIAL_CHARS = 30_000;
const MAX_MATERIALS_TOTAL_CHARS = 20_000;

const bibleSchema = z.object({
  // Current model: a flat notes list (МИР ПРОЕКТА). Legacy typed fields stay
  // accepted so an old client / folded data still validates.
  notes: z
    .array(
      z.union([
        z.string().max(2_000),
        z.object({
          id: z.string().trim().min(1).max(100),
          content: z.string().max(2_000),
          includeInAi: z.boolean(),
        }),
      ]),
    )
    .max(300)
    .optional(),
  characters: z
    .array(z.object({ name: z.string().max(200), description: z.string().max(2_000) }))
    .max(200)
    .optional(),
  tone: z.array(z.string().max(200)).max(50).optional(),
  rules: z.array(z.string().max(500)).max(100).optional(),
});

const createSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  projectId: workspaceProjectIdSchema.optional(),
  title: z.string().trim().min(1).max(200).optional(),
  fountain: z.string().optional(),
  format: scenarioFormatSchema.optional(),
  brief: scenarioBriefV1Schema.optional(),
  outline: scenarioOutlineV1Schema.optional(),
});
const listSchema = z
  .object({
    projectId: workspaceProjectIdSchema.optional(),
    cursor: z.string().max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const projectCreateSchema = z.object({ projectId: workspaceProjectIdSchema.optional() }).strict();
const projectResolverParamsSchema = z.object({ projectId: workspaceProjectIdSchema });
const sceneTimingUpdateSchema = z.object({
  durationSeconds: z.number().int().positive().max(7_200),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  bible: bibleSchema.optional(),
  fountain: z.string().optional(),
  format: scenarioFormatSchema.optional(),
  brief: scenarioBriefV1Schema.optional(),
  outline: scenarioOutlineV1Schema.optional(),
  /** Required with `fountain`: the rev the client edited from. */
  baseRev: z.number().int().nonnegative().optional(),
});

const projectUpdateSchema = z
  .object({
    baseRev: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(200).optional(),
    bible: bibleSchema.optional(),
    fountain: z.string().optional(),
    format: scenarioFormatSchema.optional(),
    brief: scenarioBriefV1Schema.optional(),
    outline: scenarioOutlineV1Schema.optional(),
  })
  .refine(
    ({ baseRev: _baseRev, ...changes }) =>
      Object.values(changes).some((value) => value !== undefined),
    { message: 'at least one project field is required' },
  );

const anchorSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  rev: z.number().int().nonnegative(),
  quote: z.string().max(4_000),
});

const threadCreateSchema = z.object({
  anchor: anchorSchema.nullish(),
  message: z.object({ content: z.string().trim().min(1).max(8_000) }),
});

const threadPatchSchema = z.object({
  status: z.enum(['open', 'applied', 'dismissed', 'detached']).optional(),
  message: z
    .object({
      role: z.enum(['user', 'assistant']),
      content: z.string().trim().min(1).max(32_000),
      proposal: z.object({ before: z.string(), after: z.string() }).optional(),
      tier: z.string().max(40).optional(),
    })
    .optional(),
});

const threadMessagesQuerySchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const materialCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  content: z.string().max(200_000),
});

const materialUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  content: z.string().max(200_000).optional(),
  includeInAi: z.boolean().optional(),
});

const boardHandoffSchema = z
  .object({
    ordinals: z.array(z.number().int().positive()).min(1).max(MAX_HANDOFF_SCENES),
    destination: z.enum(['new', 'linked', 'board']).default('new'),
    boardId: z.string().min(1).max(128).optional(),
    fullSync: z.boolean().default(false),
    idempotencyKey: z.string().trim().min(8).max(128).optional(),
  })
  .strict();

const IMPORT_FORMATS = [
  'fountain',
  'spmd',
  'txt',
  'md',
  'markdown',
  'fdx',
  'pdf',
  'docx',
  'highland',
] as const;
const EXPORT_FORMATS = ['fountain', 'txt', 'fdx', 'pdf'] as const;
const importQuerySchema = z
  .object({
    format: z.enum(IMPORT_FORMATS),
    title: z.string().max(240).optional(),
    projectId: workspaceProjectIdSchema.optional(),
  })
  .strict();

export interface ScriptRoutesOptions {
  /**
   * Background file compaction (МИР ПРОЕКТА memory). Injected so the request
   * path stays free of a live gateway call and tests skip it entirely (absent
   * → uploads simply keep the raw content). Wired in server.ts to the economy
   * model via `makeMaterialCompactor(fetch)`.
   */
  compactor?: (m: {
    id: string;
    scriptId: string;
    userId: string;
    name: string;
    content: string;
  }) => Promise<'ready' | 'raw_used'>;
}

/** «Сценарий» — screenplay canvas: CRUD, rev-guarded saves, snapshots, threads, import/export. */
export function setupScriptRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  options: ScriptRoutesOptions = {},
): void {
  const ownScript = (id: string, userId: string) =>
    and(eq(scripts.id, id), eq(scripts.userId, userId));

  type CompactionJob = {
    log: FastifyRequest['log'];
    row: {
      id: string;
      scriptId: string;
      userId: string;
      name: string;
      content: string;
      chars: number;
    };
  };
  const compactionQueue: CompactionJob[] = [];
  let activeCompactions = 0;
  const runCompactions = () => {
    while (activeCompactions < 2 && compactionQueue.length > 0) {
      const job = compactionQueue.shift()!;
      activeCompactions += 1;
      void options.compactor!({
        id: job.row.id,
        scriptId: job.row.scriptId,
        userId: job.row.userId,
        name: job.row.name,
        content: job.row.content,
      })
        .then(async (outcome) => {
          await db
            .update(scriptMaterials)
            .set({ processingStatus: outcome })
            .where(eq(scriptMaterials.id, job.row.id));
          scenarioMaterialCompactions.labels(outcome).inc();
        })
        .catch(async (err) => {
          await db
            .update(scriptMaterials)
            .set({ processingStatus: 'failed_raw_used' })
            .where(eq(scriptMaterials.id, job.row.id));
          scenarioMaterialCompactions.labels('failed_raw_used').inc();
          job.log.error({ err, materialId: job.row.id }, 'material compaction failed');
        })
        .finally(() => {
          activeCompactions -= 1;
          runCompactions();
        });
    }
  };

  // Fire-and-forget background compaction of a just-stored material. Never
  // blocks or fails the upload; a failure just leaves `summary` null (raw text
  // is used). Gated on size so tiny files don't incur a gateway call.
  const scheduleCompaction = (
    log: FastifyRequest['log'],
    row: {
      id: string;
      scriptId: string;
      userId: string;
      name: string;
      content: string;
      chars: number;
    },
  ) => {
    if (!options.compactor || row.chars < MATERIAL_SUMMARY_MIN_RAW_CHARS) return;
    if (compactionQueue.length >= 1_000) {
      void db
        .update(scriptMaterials)
        .set({ processingStatus: 'failed_raw_used' })
        .where(eq(scriptMaterials.id, row.id));
      scenarioMaterialCompactions.labels('queue_full_raw_used').inc();
      return;
    }
    compactionQueue.push({ log, row });
    runCompactions();
  };

  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>(
    '/v1/scripts',
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
            scope: 'scripts',
            ownerId: session.user.id,
            context,
          })
        : null;
      if (parsed.data.cursor && !cursor) {
        return reply.status(400).send({ error: 'invalid_cursor' });
      }
      const rows = await db
        .select({
          id: scripts.id,
          projectId: scripts.projectId,
          title: scripts.title,
          rev: scripts.rev,
          fountain: scripts.fountain,
          createdAt: scripts.createdAt,
          updatedAt: scripts.updatedAt,
        })
        .from(scripts)
        .where(
          and(
            eq(scripts.userId, session.user.id),
            ...(projectId ? [eq(scripts.projectId, projectId)] : []),
            ...(cursor
              ? [
                  or(
                    lt(scripts.updatedAt, cursor.updatedAt),
                    and(eq(scripts.updatedAt, cursor.updatedAt), lt(scripts.id, cursor.id)),
                  )!,
                ]
              : []),
          ),
        )
        .orderBy(desc(scripts.updatedAt), desc(scripts.id))
        .limit(limit + 1);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      // Title-page cards need pages + last scene, not the whole draft — compute
      // the compact stats server-side and drop the fountain from the payload.
      const items = page.map(({ fountain, ...meta }) => ({
        ...meta,
        stats: scriptStats(fountain),
        author: authorFromFountain(fountain) ?? null,
      }));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor:
          more && last
            ? encodeProjectListCursor({
                scope: 'scripts',
                ownerId: session.user.id,
                context,
                updatedAt: last.updatedAt,
                id: last.id,
              })
            : null,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/resolve/scenario',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = projectResolverParamsSchema.safeParse(req.params);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_project_context' });
      const projectId = parsed.data.projectId;
      const intent = `workspace-resolve:${session.user.id}:${projectId}:scenario`;
      const outcome = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${intent}))`);
        if (!(await validateOwnedLiveProject(tx, projectId, session.user.id))) {
          return { kind: 'not_found' as const };
        }
        const [existing] = await tx
          .select({ id: scripts.id })
          .from(scripts)
          .where(and(eq(scripts.userId, session.user.id), eq(scripts.projectId, projectId)))
          .orderBy(desc(scripts.updatedAt), desc(scripts.id))
          .limit(1);
        if (existing) return { kind: 'document' as const, id: existing.id };
        const count = await tx
          .select({ id: scripts.id })
          .from(scripts)
          .where(eq(scripts.userId, session.user.id));
        if (count.length >= MAX_SCRIPTS) return { kind: 'limit' as const };
        const [created] = await tx
          .insert(scripts)
          .values({
            id: nid(),
            userId: session.user.id,
            projectId,
            // Deliberately no createKey: the advisory lock above already makes this
            // atomic, and a stable key would collide with its own earlier row the
            // moment that script is deleted or moved out of the project — the
            // unique (user_id, create_key) index would then 500 the dock forever.
            brief: EMPTY_SCENARIO_BRIEF,
            outline: EMPTY_SCENARIO_OUTLINE,
          })
          .returning({ id: scripts.id });
        return { kind: 'document' as const, id: created!.id };
      });
      if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (outcome.kind === 'limit') return { destination: 'list' as const };
      return { destination: 'document' as const, id: outcome.id };
    },
  );

  app.post('/v1/scripts', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    if (parsed.data.fountain && Buffer.byteLength(parsed.data.fountain) > MAX_FOUNTAIN_BYTES) {
      return reply.status(400).send({ error: 'fountain_too_large', max: MAX_FOUNTAIN_BYTES });
    }
    const requestedProjectId = parsed.data.projectId ?? null;
    const outcome = await db.transaction(async (tx) => {
      if (
        parsed.data.projectId &&
        !(await validateOwnedLiveProject(tx, parsed.data.projectId, session.user.id))
      ) {
        return { kind: 'not_found' as const };
      }
      const existing = await tx
        .select({ id: scripts.id })
        .from(scripts)
        .where(eq(scripts.userId, session.user.id));
      if (existing.length >= MAX_SCRIPTS) return { kind: 'limit' as const };
      const [row] = await tx
        .insert(scripts)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: requestedProjectId,
          ...(parsed.data.idempotencyKey ? { createKey: parsed.data.idempotencyKey } : {}),
          ...(parsed.data.title ? { title: parsed.data.title } : {}),
          ...(parsed.data.fountain !== undefined ? { fountain: parsed.data.fountain } : {}),
          ...(parsed.data.format ? { format: parsed.data.format } : {}),
          ...(parsed.data.brief ? { brief: parsed.data.brief } : { brief: EMPTY_SCENARIO_BRIEF }),
          ...(parsed.data.outline
            ? { outline: parsed.data.outline }
            : { outline: EMPTY_SCENARIO_OUTLINE }),
        })
        .onConflictDoNothing()
        .returning();
      if (row) return { kind: 'created' as const, row };
      if (parsed.data.idempotencyKey) {
        const [existingIntent] = await tx
          .select()
          .from(scripts)
          .where(
            and(
              eq(scripts.userId, session.user.id),
              eq(scripts.createKey, parsed.data.idempotencyKey),
            ),
          )
          .limit(1);
        if (existingIntent) {
          if (existingIntent.projectId !== requestedProjectId) {
            return { kind: 'project_mismatch' as const };
          }
          return { kind: 'replay' as const, row: existingIntent };
        }
      }
      return { kind: 'conflict' as const };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_scripts', max: MAX_SCRIPTS });
    }
    if (outcome.kind === 'project_mismatch') {
      return reply.status(409).send({ error: 'idempotency_project_mismatch' });
    }
    if (outcome.kind === 'conflict') {
      return reply.status(409).send({ error: 'script_create_conflict' });
    }
    return reply.status(outcome.kind === 'created' ? 201 : 200).send(outcome.row);
  });

  /**
   * «Открыть пример» — create the seeded demo project (spec §2, path 3): a
   * real 3-scene RU script with a populated МИР ПРОЕКТА and one already-applied
   * «было → станет» note, so onboarding lands the writer in a live session
   * rather than an empty page. Idempotency is not required — each call makes a
   * fresh copy the writer can edit or delete.
   */
  app.post('/v1/scripts/example', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = projectCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const outcome = await db.transaction(async (tx) => {
      if (
        parsed.data.projectId &&
        !(await validateOwnedLiveProject(tx, parsed.data.projectId, session.user.id))
      ) {
        return { kind: 'not_found' as const };
      }
      const existing = await tx
        .select({ id: scripts.id })
        .from(scripts)
        .where(eq(scripts.userId, session.user.id));
      if (existing.length >= MAX_SCRIPTS) return { kind: 'limit' as const };
      const [row] = await tx
        .insert(scripts)
        .values({
          id: nid(),
          userId: session.user.id,
          projectId: parsed.data.projectId ?? null,
          title: EXAMPLE_TITLE,
          fountain: EXAMPLE_FOUNTAIN,
          bible: EXAMPLE_BIBLE,
        })
        .returning();
      const script = row!;
      const now = new Date().toISOString();
      const { messages, anchor, status } = exampleThread(script.fountain, now);
      await tx.insert(scriptThreads).values({
        id: nid(),
        scriptId: script.id,
        userId: session.user.id,
        kind: 'thread',
        anchor,
        messages,
        status,
      });
      await tx.insert(scriptMaterials).values({
        id: nid(),
        scriptId: script.id,
        userId: session.user.id,
        name: EXAMPLE_MATERIAL.name,
        content: EXAMPLE_MATERIAL.content,
        chars: [...EXAMPLE_MATERIAL.content].length,
      });
      await tx.insert(scriptSnapshots).values({
        id: nid(),
        scriptId: script.id,
        rev: script.rev,
        fountain: script.fountain,
        cause: 'manual',
      });
      return { kind: 'created' as const, script };
    });
    if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
    if (outcome.kind === 'limit') {
      return reply.status(400).send({ error: 'too_many_scripts', max: MAX_SCRIPTS });
    }
    return reply.status(201).send(outcome.script);
  });

  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>(
    '/v1/scripts/:id',
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
        .from(scripts)
        .where(ownScript(req.params.id, session.user.id))
        .limit(1);
      const script = rows[0];
      if (!script) return reply.status(404).send({ error: 'not_found' });
      if (projectId && script.projectId !== projectId) {
        return reply.status(409).send({
          error: 'project_mismatch',
          expectedProjectId: projectId,
          actualProjectId: script.projectId,
        });
      }
      return script;
    },
  );

  app.get<{ Params: { id: string } }>('/v1/scripts/:id/board-handoff', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const scenes = scenarioSources(script);
    const linked = await linkedBoards(script.id, session.user.id, script.projectId);
    return {
      scriptRevision: script.rev,
      scenes: scenes.map(({ ordinal, heading, synopsis }) => ({ ordinal, heading, synopsis })),
      linkedBoards: linked.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    };
  });

  /**
   * Editorial timing is a separate append-only ledger. The page estimate is
   * deliberately returned as a labelled fallback; it is never promoted to an
   * approved semantic duration without the author's save action.
   */
  app.get<{ Params: { id: string } }>('/v1/scripts/:id/scene-timings', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });

    const sources = scenarioSources(script);
    const pageEstimates = new Map(
      sceneTimings(script.fountain).map((estimate) => [estimate.index, estimate]),
    );
    const rows = await db
      .select()
      .from(scriptSceneTimings)
      .where(eq(scriptSceneTimings.scriptId, script.id))
      .orderBy(desc(scriptSceneTimings.createdAt));
    const latestByUnit = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!latestByUnit.has(row.sourceUnitId)) latestByUnit.set(row.sourceUnitId, row);
    }

    return {
      scriptRevision: script.rev,
      policyVersion: SCENARIO_TIMING_POLICY_VERSION,
      scenes: sources.map((source) => {
        const sourceUnitId = scenarioTimingSourceUnitId(source);
        const sourceRevisionId = scenarioTimingSourceRevisionId(source.sourceText);
        const row = latestByUnit.get(sourceUnitId);
        const sourceChanged = row ? row.sourceRevisionId !== sourceRevisionId : false;
        return {
          sourceUnitId,
          ordinal: source.ordinal,
          heading: source.heading,
          synopsis: source.synopsis,
          sourceRevisionId,
          pageEstimate: pageEstimates.get(source.ordinal)?.duration ?? null,
          timing: row
            ? {
                id: row.id,
                durationSeconds: row.durationSeconds,
                owner: row.owner,
                sourceRevisionId: row.sourceRevisionId,
                stale: scenarioTimingIsStale({
                  owner: row.owner,
                  sourceRevisionId: row.sourceRevisionId,
                  currentSourceRevisionId: sourceRevisionId,
                }),
                sourceChanged,
                createdAt: row.createdAt,
              }
            : null,
        };
      }),
    };
  });

  app.put<{ Params: { id: string; sourceUnitId: string } }>(
    '/v1/scripts/:id/scene-timings/:sourceUnitId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = sceneTimingUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });

      const source = scenarioSources(script).find(
        (candidate) => scenarioTimingSourceUnitId(candidate) === req.params.sourceUnitId,
      );
      if (!source) return reply.status(404).send({ error: 'scene_not_found' });
      const sourceRevisionId = scenarioTimingSourceRevisionId(source.sourceText);
      const [latest] = await db
        .select({ id: scriptSceneTimings.id })
        .from(scriptSceneTimings)
        .where(
          and(
            eq(scriptSceneTimings.scriptId, script.id),
            eq(scriptSceneTimings.sourceUnitId, req.params.sourceUnitId),
          ),
        )
        .orderBy(desc(scriptSceneTimings.createdAt))
        .limit(1);
      const [timing] = await db
        .insert(scriptSceneTimings)
        .values({
          id: nid(),
          scriptId: script.id,
          sourceUnitId: req.params.sourceUnitId,
          durationSeconds: parsed.data.durationSeconds,
          owner: 'user',
          sourceRevisionId,
          estimatorPolicyVersion: SCENARIO_TIMING_POLICY_VERSION,
          supersedesTimingId: latest?.id ?? null,
        })
        .returning();
      return {
        ok: true,
        timing: {
          id: timing!.id,
          durationSeconds: timing!.durationSeconds,
          owner: timing!.owner,
          sourceRevisionId: timing!.sourceRevisionId,
          stale: false,
          sourceChanged: false,
          createdAt: timing!.createdAt,
        },
      };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/board-handoff', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = boardHandoffSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    if (
      script.projectId &&
      !(await validateOwnedLiveProject(db, script.projectId, session.user.id))
    ) {
      return reply.status(404).send({ error: 'project_context_unavailable' });
    }

    const available = scenarioSources(script);
    const byOrdinal = new Map(available.map((scene) => [scene.ordinal, scene]));
    const selected = [...new Set(parsed.data.ordinals)].map((ordinal) => byOrdinal.get(ordinal));
    if (selected.some((scene) => !scene)) {
      return reply.status(400).send({
        error: 'unknown_scene',
        available: available.map((scene) => scene.ordinal),
      });
    }
    const selectedScenes = selected.filter(
      (scene): scene is ReturnType<typeof scenarioSources>[number] => Boolean(scene),
    );
    const planRows = await db
      .select()
      .from(scriptShotPlans)
      .where(eq(scriptShotPlans.scriptId, script.id))
      .orderBy(desc(scriptShotPlans.createdAt));
    const timingRows = await db
      .select()
      .from(scriptSceneTimings)
      .where(eq(scriptSceneTimings.scriptId, script.id))
      .orderBy(desc(scriptSceneTimings.createdAt));
    const latestTimingBySource = new Map<string, (typeof timingRows)[number]>();
    for (const row of timingRows) {
      if (!latestTimingBySource.has(row.sourceUnitId))
        latestTimingBySource.set(row.sourceUnitId, row);
    }
    const plansBySource = new Map<string, ReturnType<typeof scenarioShotPlanSchema.parse>>();
    for (const row of planRows) {
      const source = selectedScenes.find(
        (candidate) =>
          scenarioTimingSourceUnitId(candidate) === row.sourceSceneId &&
          candidate.sourceHash === row.sourceHash,
      );
      const timing = latestTimingBySource.get(row.sourceSceneId);
      const timingMatchesPlan =
        timing?.owner === 'user' &&
        timing.sourceRevisionId === row.sourceHash &&
        timing.durationSeconds === row.targetDurationSeconds;
      if (!source || !timingMatchesPlan || plansBySource.has(row.sourceSceneId)) continue;
      const parsedPlan = scenarioShotPlanSchema.safeParse(row.plan);
      if (!parsedPlan.success) {
        return reply.status(409).send({ error: 'shot_plan_unreconcilable' });
      }
      plansBySource.set(row.sourceSceneId, parsedPlan.data);
    }
    const selectedScenesWithPlans = selectedScenes.map((scene) => {
      const shotPlan = plansBySource.get(scenarioTimingSourceUnitId(scene));
      return shotPlan ? { ...scene, shotPlan } : scene;
    });

    if (parsed.data.destination === 'new') {
      let merged;
      try {
        merged = mergeScenarioScenesIntoBoard({
          document: {},
          scriptId: script.id,
          scriptRevision: script.rev,
          scenes: selectedScenesWithPlans,
          fullSync: parsed.data.fullSync,
          makeId: nid,
        });
      } catch (error) {
        if (error instanceof ScenarioBoardMaterializationLimitError) {
          return reply
            .status(400)
            .send({ error: 'board_capacity_exceeded', message: error.message });
        }
        throw error;
      }
      if (Buffer.byteLength(JSON.stringify(merged.document), 'utf8') > MAX_BOARD_STATE_BYTES) {
        return reply.status(400).send({ error: 'board_state_too_large' });
      }
      const titleBase = script.title.trim() || 'Сценарий';
      const title = `${titleBase.slice(0, 68)} · Борд`;
      const receipt = {
        scriptId: script.id,
        ordinals: [...new Set(parsed.data.ordinals)].sort((a, b) => a - b),
        fullSync: parsed.data.fullSync,
        added: merged.added,
        updated: merged.updated,
        removed: merged.removed,
        skipped: merged.skipped,
        materializedShots: merged.materializedShots,
        materializedCastNodes: merged.materializedCastNodes,
      };
      const outcome = await db.transaction(async (tx) => {
        if (parsed.data.idempotencyKey) {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${`${session.user.id}:scenario-board:${parsed.data.idempotencyKey}`}))`,
          );
          const [replayed] = await tx
            .select({ id: boards.id, title: boards.title, state: boards.state })
            .from(boards)
            .where(
              and(
                eq(boards.userId, session.user.id),
                isNull(boards.trashedAt),
                sql`${boards.state}->'__scenarioHandoff'->>'idempotencyKey' = ${parsed.data.idempotencyKey}`,
              ),
            )
            .limit(1);
          if (replayed) {
            const metadata = (replayed.state as { __scenarioHandoff?: unknown })
              .__scenarioHandoff as Partial<typeof receipt> | undefined;
            if (
              !metadata ||
              metadata.scriptId !== receipt.scriptId ||
              JSON.stringify(metadata.ordinals) !== JSON.stringify(receipt.ordinals) ||
              metadata.fullSync !== receipt.fullSync
            ) {
              return { kind: 'idempotency_mismatch' as const };
            }
            return {
              kind: 'replayed' as const,
              board: { id: replayed.id, title: replayed.title },
              receipt: metadata,
            };
          }
        }
        const existing = await tx
          .select({ id: boards.id })
          .from(boards)
          .where(and(eq(boards.userId, session.user.id), isNull(boards.trashedAt)));
        if (existing.length >= MAX_BOARDS) return { kind: 'limit' as const };
        const [board] = await tx
          .insert(boards)
          .values({
            id: nid(),
            userId: session.user.id,
            projectId: script.projectId,
            title,
            state: {
              ...merged.document,
              __rev: 0,
              ...(parsed.data.idempotencyKey
                ? {
                    __scenarioHandoff: {
                      idempotencyKey: parsed.data.idempotencyKey,
                      ...receipt,
                    },
                  }
                : {}),
            },
          })
          .returning({ id: boards.id, title: boards.title });
        return { kind: 'created' as const, board: board!, receipt };
      });
      if (outcome.kind === 'limit') {
        return reply.status(400).send({ error: 'too_many_boards', max: MAX_BOARDS });
      }
      if (outcome.kind === 'idempotency_mismatch') {
        return reply.status(409).send({ error: 'idempotency_payload_mismatch' });
      }
      if (outcome.kind === 'replayed') {
        scenarioBoardHandoffs.labels('replayed').inc();
        return {
          boardId: outcome.board.id,
          title: outcome.board.title,
          created: false,
          replayed: true,
          added: outcome.receipt.added ?? 0,
          updated: outcome.receipt.updated ?? 0,
          removed: outcome.receipt.removed ?? 0,
          skipped: outcome.receipt.skipped ?? 0,
          materializedShots: outcome.receipt.materializedShots ?? 0,
          materializedCastNodes: outcome.receipt.materializedCastNodes ?? 0,
        };
      }
      scenarioBoardHandoffs.labels('created').inc();
      return reply.status(201).send({
        boardId: outcome.board.id,
        title: outcome.board.title,
        created: true,
        replayed: false,
        added: outcome.receipt.added,
        updated: outcome.receipt.updated,
        removed: outcome.receipt.removed,
        skipped: outcome.receipt.skipped,
        materializedShots: outcome.receipt.materializedShots,
        materializedCastNodes: outcome.receipt.materializedCastNodes,
      });
    }

    const candidates = parsed.data.boardId
      ? await db
          .select({
            id: boards.id,
            projectId: boards.projectId,
            title: boards.title,
            state: boards.state,
          })
          .from(boards)
          .where(
            and(
              eq(boards.id, parsed.data.boardId),
              eq(boards.userId, session.user.id),
              isNull(boards.trashedAt),
            ),
          )
          .limit(1)
      : await linkedBoards(script.id, session.user.id, script.projectId);
    const board = candidates[0];
    if (!board) return reply.status(404).send({ error: 'linked_board_not_found' });
    if (script.projectId && board.projectId !== script.projectId) {
      scenarioBoardHandoffs.labels('project_mismatch').inc();
      return reply.status(409).send({
        error: 'project_mismatch',
        scriptProjectId: script.projectId,
        boardProjectId: board.projectId,
      });
    }
    const current = safeParseBoardDocument(board.state);
    if (
      !current.success ||
      (parsed.data.destination === 'linked' && !boardLinksToScript(current.data, script.id))
    ) {
      return reply.status(409).send({ error: 'board_not_linked' });
    }
    const ordinals = [...new Set(parsed.data.ordinals)].sort((a, b) => a - b);
    if (parsed.data.idempotencyKey) {
      const metadata = current.data.__scenarioHandoff as
        | {
            idempotencyKey?: unknown;
            scriptId?: unknown;
            ordinals?: unknown;
            fullSync?: unknown;
            added?: unknown;
            updated?: unknown;
            removed?: unknown;
            skipped?: unknown;
            materializedShots?: unknown;
            materializedCastNodes?: unknown;
          }
        | undefined;
      if (metadata?.idempotencyKey === parsed.data.idempotencyKey) {
        if (
          metadata.scriptId !== script.id ||
          JSON.stringify(metadata.ordinals) !== JSON.stringify(ordinals) ||
          metadata.fullSync !== parsed.data.fullSync
        ) {
          return reply.status(409).send({ error: 'idempotency_payload_mismatch' });
        }
        scenarioBoardHandoffs.labels('replayed').inc();
        return {
          boardId: board.id,
          title: board.title,
          created: false,
          replayed: true,
          added: typeof metadata.added === 'number' ? metadata.added : 0,
          updated: typeof metadata.updated === 'number' ? metadata.updated : 0,
          removed: typeof metadata.removed === 'number' ? metadata.removed : 0,
          skipped: typeof metadata.skipped === 'number' ? metadata.skipped : 0,
          materializedShots:
            typeof metadata.materializedShots === 'number' ? metadata.materializedShots : 0,
          materializedCastNodes:
            typeof metadata.materializedCastNodes === 'number' ? metadata.materializedCastNodes : 0,
          state: current.data,
        };
      }
    }
    let merged;
    try {
      merged = mergeScenarioScenesIntoBoard({
        document: current.data,
        scriptId: script.id,
        scriptRevision: script.rev,
        scenes: selectedScenesWithPlans,
        fullSync: parsed.data.fullSync,
        makeId: nid,
      });
    } catch (error) {
      if (error instanceof ScenarioBoardMaterializationLimitError) {
        return reply.status(400).send({ error: 'board_capacity_exceeded', message: error.message });
      }
      throw error;
    }
    if (Buffer.byteLength(JSON.stringify(merged.document), 'utf8') > MAX_BOARD_STATE_BYTES) {
      return reply.status(400).send({ error: 'board_state_too_large' });
    }
    const baseRev = current.data.__rev ?? 0;
    const stamped: BoardDocument = {
      ...merged.document,
      __rev: baseRev + 1,
      ...(parsed.data.idempotencyKey
        ? {
            __scenarioHandoff: {
              idempotencyKey: parsed.data.idempotencyKey,
              scriptId: script.id,
              ordinals,
              fullSync: parsed.data.fullSync,
              added: merged.added,
              updated: merged.updated,
              removed: merged.removed,
              skipped: merged.skipped,
              materializedShots: merged.materializedShots,
              materializedCastNodes: merged.materializedCastNodes,
            },
          }
        : {}),
    };
    const updated = await db
      .update(boards)
      .set({ state: stamped, updatedAt: new Date() })
      .where(
        and(
          eq(boards.id, board.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
          sql`COALESCE(
            CASE
              WHEN jsonb_typeof(${boards.state}->'__rev') = 'number'
              THEN (${boards.state}->>'__rev')::numeric
              ELSE 0
            END,
            0
          ) = ${baseRev}`,
        ),
      )
      .returning({ id: boards.id });
    if (updated.length === 0) {
      scenarioBoardHandoffs.labels('revision_conflict').inc();
      return reply.status(409).send({ error: 'board_rev_conflict' });
    }
    scenarioBoardHandoffs.labels('updated').inc();
    return {
      boardId: board.id,
      title: board.title,
      created: false,
      replayed: false,
      added: merged.added,
      updated: merged.updated,
      removed: merged.removed,
      skipped: merged.skipped,
      materializedShots: merged.materializedShots,
      materializedCastNodes: merged.materializedCastNodes,
      state: stamped,
    };
  });

  /**
   * Save. Fountain changes ride an atomic rev guard: UPDATE only when the
   * stored rev equals `baseRev`, bumping rev by 1. A stale save gets a hard
   * 409 with the current rev — a writer's draft must never be silently
   * dropped (deliberate divergence from boards' `skipped:true`).
   */
  app.put<{ Params: { id: string } }>('/v1/scripts/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { title, bible, fountain, format, brief, outline, baseRev } = parsed.data;

    const projectStructureChanged =
      format !== undefined || brief !== undefined || outline !== undefined;

    if (fountain !== undefined || projectStructureChanged) {
      if (fountain !== undefined && Buffer.byteLength(fountain) > MAX_FOUNTAIN_BYTES) {
        return reply.status(400).send({ error: 'fountain_too_large', max: MAX_FOUNTAIN_BYTES });
      }
      if (baseRev === undefined) {
        return reply.status(400).send({ error: 'base_rev_required' });
      }
      const updated = await db
        .update(scripts)
        .set({
          ...(fountain !== undefined ? { fountain } : {}),
          rev: sql`${scripts.rev} + 1`,
          ...(title !== undefined ? { title } : {}),
          ...(bible !== undefined ? { bible } : {}),
          ...(format !== undefined ? { format } : {}),
          ...(brief !== undefined ? { brief } : {}),
          ...(outline !== undefined ? { outline } : {}),
          updatedAt: new Date(),
        })
        .where(and(ownScript(req.params.id, session.user.id), eq(scripts.rev, baseRev)))
        .returning({ rev: scripts.rev });
      if (updated.length > 0) {
        const rev = updated[0]!.rev;
        if (fountain !== undefined) await maybeSnapshotAutosave(req.params.id, rev, fountain);
        return { ok: true, rev };
      }
      const current = await db
        .select({ rev: scripts.rev, fountain: scripts.fountain })
        .from(scripts)
        .where(ownScript(req.params.id, session.user.id))
        .limit(1);
      if (current.length === 0) return reply.status(404).send({ error: 'not_found' });
      return reply.status(409).send({
        error: 'rev_conflict',
        rev: current[0]!.rev,
        fountain: current[0]!.fountain,
      });
    }

    // Metadata-only update (title/bible): no rev bump, last write wins.
    if (title === undefined && bible === undefined) {
      return reply.status(400).send({ error: 'invalid_body' });
    }
    const updated = await db
      .update(scripts)
      .set({
        ...(title !== undefined ? { title } : {}),
        ...(bible !== undefined ? { bible } : {}),
        updatedAt: new Date(),
      })
      .where(ownScript(req.params.id, session.user.id))
      .returning({ rev: scripts.rev });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true, rev: updated[0]!.rev };
  });

  /** Versioned whole-project save contract for the universal client. */
  app.patch<{ Params: { id: string } }>('/v1/scripts/:id/project', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = projectUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { baseRev, ...changes } = parsed.data;
    if (
      changes.fountain !== undefined &&
      Buffer.byteLength(changes.fountain) > MAX_FOUNTAIN_BYTES
    ) {
      return reply.status(400).send({ error: 'fountain_too_large', max: MAX_FOUNTAIN_BYTES });
    }
    const [updated] = await db
      .update(scripts)
      .set({ ...changes, rev: sql`${scripts.rev} + 1`, updatedAt: new Date() })
      .where(and(ownScript(req.params.id, session.user.id), eq(scripts.rev, baseRev)))
      .returning();
    if (updated) {
      if (changes.fountain !== undefined) {
        await maybeSnapshotAutosave(updated.id, updated.rev, changes.fountain);
      }
      return { ok: true, project: updated };
    }
    const [current] = await db
      .select()
      .from(scripts)
      .where(ownScript(req.params.id, session.user.id))
      .limit(1);
    if (!current) return reply.status(404).send({ error: 'not_found' });
    return reply.status(409).send({ error: 'rev_conflict', project: current });
  });

  app.delete<{ Params: { id: string } }>('/v1/scripts/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const deleted = await db
      .delete(scripts)
      .where(ownScript(req.params.id, session.user.id))
      .returning({ id: scripts.id });
    if (deleted.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // ---------- snapshots / versions ----------

  app.get<{ Params: { id: string } }>('/v1/scripts/:id/snapshots', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const rows = await db
      .select({
        id: scriptSnapshots.id,
        rev: scriptSnapshots.rev,
        cause: scriptSnapshots.cause,
        createdAt: scriptSnapshots.createdAt,
      })
      .from(scriptSnapshots)
      .where(eq(scriptSnapshots.scriptId, script.id))
      .orderBy(desc(scriptSnapshots.createdAt))
      .limit(200);
    return { items: rows };
  });

  app.get<{ Params: { id: string; snapshotId: string } }>(
    '/v1/scripts/:id/snapshots/:snapshotId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });
      const rows = await db
        .select()
        .from(scriptSnapshots)
        .where(
          and(
            eq(scriptSnapshots.id, req.params.snapshotId),
            eq(scriptSnapshots.scriptId, script.id),
          ),
        )
        .limit(1);
      if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });
      return rows[0];
    },
  );

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/snapshots', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const [row] = await db
      .insert(scriptSnapshots)
      .values({
        id: nid(),
        scriptId: script.id,
        rev: script.rev,
        fountain: script.fountain,
        cause: 'manual',
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/restore', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = z.object({ snapshotId: z.string().min(1) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const snaps = await db
      .select()
      .from(scriptSnapshots)
      .where(
        and(
          eq(scriptSnapshots.id, parsed.data.snapshotId),
          eq(scriptSnapshots.scriptId, script.id),
        ),
      )
      .limit(1);
    if (snaps.length === 0) return reply.status(404).send({ error: 'not_found' });
    const snap = snaps[0]!;
    const [updated] = await db
      .update(scripts)
      .set({ fountain: snap.fountain, rev: sql`${scripts.rev} + 1`, updatedAt: new Date() })
      .where(ownScript(script.id, session.user.id))
      .returning();
    await db.insert(scriptSnapshots).values({
      id: nid(),
      scriptId: script.id,
      rev: updated!.rev,
      fountain: snap.fountain,
      cause: 'restore',
    });
    return updated;
  });

  // ---------- threads ----------

  app.get<{ Params: { id: string } }>('/v1/scripts/:id/threads', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const rows = await db
      .select()
      .from(scriptThreads)
      .where(eq(scriptThreads.scriptId, script.id))
      .orderBy(desc(scriptThreads.updatedAt))
      .limit(500);
    return {
      items: rows.map((thread) => ({
        ...thread,
        messages: thread.messages.slice(-50),
        messagesTruncated: thread.messages.length > 50,
      })),
    };
  });

  /** Newest-first, cursor-paginated thread ledger. Legacy JSON is a read fallback. */
  app.get<{
    Params: { id: string; threadId: string };
    Querystring: { cursor?: string; limit?: string };
  }>('/v1/scripts/:id/threads/:threadId/messages', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = threadMessagesQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
    const thread = await loadOwnThread(req.params.id, req.params.threadId, session.user.id);
    if (!thread) return reply.status(404).send({ error: 'not_found' });

    const cursor = parseMessageCursor(parsed.data.cursor);
    if (parsed.data.cursor && !cursor) return reply.status(400).send({ error: 'invalid_cursor' });
    const where = [eq(scriptThreadMessages.threadId, thread.id)];
    if (cursor) {
      where.push(
        or(
          lt(scriptThreadMessages.createdAt, cursor.createdAt),
          and(
            eq(scriptThreadMessages.createdAt, cursor.createdAt),
            lt(scriptThreadMessages.id, cursor.id),
          ),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(scriptThreadMessages)
      .where(and(...where))
      .orderBy(desc(scriptThreadMessages.createdAt), desc(scriptThreadMessages.id))
      .limit(parsed.data.limit + 1);
    if (rows.length === 0 && !cursor && thread.messages.length > 0) {
      // Expand/dual-read rollout: old conversations remain readable until
      // the deterministic backfill has populated their ledger rows.
      const legacy = thread.messages.slice(-parsed.data.limit);
      return { items: legacy, nextCursor: null, source: 'legacy' as const };
    }
    const page = rows.slice(0, parsed.data.limit);
    const tail = page[page.length - 1];
    return {
      items: page.reverse().map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        ...(message.proposal ? { proposal: message.proposal } : {}),
        ...(message.tier ? { tier: message.tier } : {}),
        at: message.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > parsed.data.limit && tail
          ? encodeMessageCursor(tail.createdAt, tail.id)
          : null,
      source: 'ledger' as const,
    };
  });

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/threads', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = threadCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const createdAt = new Date();
    const message = {
      role: 'user' as const,
      content: parsed.data.message.content,
      at: createdAt.toISOString(),
    };
    const [row] = await db
      .insert(scriptThreads)
      .values({
        id: nid(),
        scriptId: script.id,
        userId: session.user.id,
        anchor: parsed.data.anchor ?? null,
        messages: [message],
      })
      .returning();
    await db.insert(scriptThreadMessages).values({
      id: nid(),
      threadId: row!.id,
      scriptId: script.id,
      userId: session.user.id,
      role: message.role,
      content: message.content,
      createdAt,
    });
    return reply.status(201).send(row);
  });

  app.patch<{ Params: { id: string; threadId: string } }>(
    '/v1/scripts/:id/threads/:threadId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = threadPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
      if (parsed.data.status === undefined && parsed.data.message === undefined) {
        return reply.status(400).send({ error: 'invalid_body' });
      }
      const rows = await db
        .select()
        .from(scriptThreads)
        .where(
          and(
            eq(scriptThreads.id, req.params.threadId),
            eq(scriptThreads.scriptId, req.params.id),
            eq(scriptThreads.userId, session.user.id),
          ),
        )
        .limit(1);
      if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });
      const thread = rows[0]!;
      const messageAt = new Date();
      const messages = parsed.data.message
        ? [...thread.messages, { ...parsed.data.message, at: messageAt.toISOString() }]
        : thread.messages;
      const [updated] = await db
        .update(scriptThreads)
        .set({
          messages,
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(scriptThreads.id, thread.id))
        .returning();
      if (parsed.data.message) {
        await db.insert(scriptThreadMessages).values({
          id: nid(),
          threadId: thread.id,
          scriptId: thread.scriptId,
          userId: session.user.id,
          role: parsed.data.message.role,
          content: parsed.data.message.content,
          ...(parsed.data.message.proposal ? { proposal: parsed.data.message.proposal } : {}),
          ...(parsed.data.message.tier ? { tier: parsed.data.message.tier } : {}),
          createdAt: messageAt,
        });
      }
      return updated;
    },
  );

  // ---------- materials («Материалы проекта») ----------

  app.get<{ Params: { id: string } }>('/v1/scripts/:id/materials', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });
    const rows = await db
      .select({
        id: scriptMaterials.id,
        name: scriptMaterials.name,
        chars: scriptMaterials.chars,
        createdAt: scriptMaterials.createdAt,
        updatedAt: scriptMaterials.updatedAt,
        includeInAi: scriptMaterials.includeInAi,
        processingStatus: scriptMaterials.processingStatus,
      })
      .from(scriptMaterials)
      .where(eq(scriptMaterials.scriptId, script.id))
      .orderBy(desc(scriptMaterials.createdAt));
    const totalChars = rows.reduce((n, r) => n + r.chars, 0);
    return {
      items: rows,
      totalChars,
      maxTotalChars: MAX_MATERIALS_TOTAL_CHARS,
      maxFiles: MAX_MATERIALS,
      maxFileChars: MAX_MATERIAL_CHARS,
    };
  });

  app.post<{ Params: { id: string } }>('/v1/scripts/:id/materials', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = materialCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const script = await loadOwn(req.params.id, session.user.id);
    if (!script) return reply.status(404).send({ error: 'not_found' });

    const existing = await db
      .select({ chars: scriptMaterials.chars })
      .from(scriptMaterials)
      .where(eq(scriptMaterials.scriptId, script.id));
    const chars = [...parsed.data.content].length;
    const ceiling = materialCeilingError(existing, chars);
    if (ceiling) return reply.status(400).send(ceiling);

    const [row] = await db
      .insert(scriptMaterials)
      .values({
        id: nid(),
        scriptId: script.id,
        userId: session.user.id,
        name: parsed.data.name,
        content: parsed.data.content,
        chars,
        processingStatus:
          options.compactor && chars >= MATERIAL_SUMMARY_MIN_RAW_CHARS ? 'processing' : 'ready',
      })
      .returning();
    scheduleCompaction(req.log, row!);
    return reply.status(201).send(row);
  });

  /**
   * «⤓ Файл» in МИР ПРОЕКТА: extract a file's PLAIN TEXT and store it as a
   * material, ceiling-checked. Text formats pass through; docx/pdf/highland are
   * text-extracted server-side. Large files are background-compacted into the
   * editor's memory afterwards (owner steer 2026-07-04; supersedes the §4b
   * "never summarized" note) — the raw content is kept for display/export.
   */
  app.post<{ Params: { id: string }; Querystring: { format?: string; name?: string } }>(
    '/v1/scripts/:id/materials/file',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const format = (req.query.format ?? '').toLowerCase();
      if (!(IMPORT_FORMATS as readonly string[]).includes(format)) {
        return reply.status(400).send({ error: 'unsupported_format', formats: IMPORT_FORMATS });
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_body' });
      }
      if (body.length > MAX_IMPORT_BYTES) {
        return reply.status(400).send({ error: 'file_too_large', max: MAX_IMPORT_BYTES });
      }
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });

      let content: string;
      try {
        content = await extractText(format, new Uint8Array(body));
      } catch (err) {
        return reply.status(422).send({ error: 'extract_failed', message: (err as Error).message });
      }
      const name = (req.query.name ?? '').trim().slice(0, 200) || `файл.${format}`;
      const existing = await db
        .select({ chars: scriptMaterials.chars })
        .from(scriptMaterials)
        .where(eq(scriptMaterials.scriptId, script.id));
      const chars = [...content].length;
      const ceiling = materialCeilingError(existing, chars);
      if (ceiling) return reply.status(400).send(ceiling);

      const [row] = await db
        .insert(scriptMaterials)
        .values({
          id: nid(),
          scriptId: script.id,
          userId: session.user.id,
          name,
          content,
          chars,
          processingStatus:
            options.compactor && chars >= MATERIAL_SUMMARY_MIN_RAW_CHARS ? 'processing' : 'ready',
        })
        .returning();
      scheduleCompaction(req.log, row!);
      return reply.status(201).send(row);
    },
  );

  app.put<{ Params: { id: string; materialId: string } }>(
    '/v1/scripts/:id/materials/:materialId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const parsed = materialUpdateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
      if (
        parsed.data.name === undefined &&
        parsed.data.content === undefined &&
        parsed.data.includeInAi === undefined
      ) {
        return reply.status(400).send({ error: 'invalid_body' });
      }
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });
      const rows = await db
        .select()
        .from(scriptMaterials)
        .where(
          and(
            eq(scriptMaterials.id, req.params.materialId),
            eq(scriptMaterials.scriptId, script.id),
          ),
        )
        .limit(1);
      if (rows.length === 0) return reply.status(404).send({ error: 'not_found' });

      let chars = rows[0]!.chars;
      if (parsed.data.content !== undefined) {
        chars = [...parsed.data.content].length;
        // Re-check ceilings against the OTHER materials (the count is
        // unchanged on update, so only the total-chars ceiling can bind).
        const all = await db
          .select({ chars: scriptMaterials.chars })
          .from(scriptMaterials)
          .where(eq(scriptMaterials.scriptId, script.id));
        const otherChars = all.reduce((n, r) => n + r.chars, 0) - rows[0]!.chars;
        const ceiling = materialCeilingError([{ chars: otherChars }], chars, true);
        if (ceiling) return reply.status(400).send(ceiling);
      }
      const shouldCompact =
        parsed.data.content !== undefined &&
        Boolean(options.compactor) &&
        chars >= MATERIAL_SUMMARY_MIN_RAW_CHARS;
      const [updated] = await db
        .update(scriptMaterials)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.content !== undefined
            ? {
                content: parsed.data.content,
                chars,
                summary: null,
                processingStatus: shouldCompact ? 'processing' : 'ready',
              }
            : {}),
          ...(parsed.data.includeInAi !== undefined
            ? { includeInAi: parsed.data.includeInAi ? 1 : 0 }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(scriptMaterials.id, req.params.materialId))
        .returning();
      if (shouldCompact) scheduleCompaction(req.log, updated!);
      return updated;
    },
  );

  app.delete<{ Params: { id: string; materialId: string } }>(
    '/v1/scripts/:id/materials/:materialId',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });
      const deleted = await db
        .delete(scriptMaterials)
        .where(
          and(
            eq(scriptMaterials.id, req.params.materialId),
            eq(scriptMaterials.scriptId, script.id),
          ),
        )
        .returning({ id: scriptMaterials.id });
      if (deleted.length === 0) return reply.status(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  // ---------- import / export ----------

  app.post<{ Querystring: { format?: string; title?: string; projectId?: string } }>(
    '/v1/scripts/import',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const requestedFormat = (req.query.format ?? '').toLowerCase();
      if (!(IMPORT_FORMATS as readonly string[]).includes(requestedFormat)) {
        return reply.status(400).send({ error: 'unsupported_format', formats: IMPORT_FORMATS });
      }
      const parsed = importQuerySchema.safeParse({ ...req.query, format: requestedFormat });
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
      const { format, projectId } = parsed.data;
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.status(400).send({ error: 'empty_body' });
      }
      if (body.length > MAX_IMPORT_BYTES) {
        return reply.status(400).send({ error: 'file_too_large', max: MAX_IMPORT_BYTES });
      }
      let imported: ImportResult;
      try {
        imported = await runImport(format, body);
      } catch (err) {
        return reply.status(422).send({ error: 'import_failed', message: (err as Error).message });
      }
      if (Buffer.byteLength(imported.fountain) > MAX_FOUNTAIN_BYTES) {
        return reply.status(400).send({ error: 'fountain_too_large', max: MAX_FOUNTAIN_BYTES });
      }

      const title =
        (parsed.data.title ?? '').trim().slice(0, 200) ||
        titleFromFountain(imported.fountain) ||
        'Импортированный сценарий';
      const outcome = await db.transaction(async (tx) => {
        if (projectId && !(await validateOwnedLiveProject(tx, projectId, session.user.id))) {
          return { kind: 'not_found' as const };
        }
        const existing = await tx
          .select({ id: scripts.id })
          .from(scripts)
          .where(eq(scripts.userId, session.user.id));
        if (existing.length >= MAX_SCRIPTS) return { kind: 'limit' as const };
        const [row] = await tx
          .insert(scripts)
          .values({
            id: nid(),
            userId: session.user.id,
            projectId: projectId ?? null,
            title,
            fountain: imported.fountain,
          })
          .returning();
        await tx.insert(scriptSnapshots).values({
          id: nid(),
          scriptId: row!.id,
          rev: row!.rev,
          fountain: row!.fountain,
          cause: 'manual',
        });
        return { kind: 'created' as const, row: row! };
      });
      if (outcome.kind === 'not_found') return reply.status(404).send({ error: 'not_found' });
      if (outcome.kind === 'limit') {
        return reply.status(400).send({ error: 'too_many_scripts', max: MAX_SCRIPTS });
      }
      return reply.status(201).send({ script: outcome.row, report: imported.report });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/v1/scripts/:id/export',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      const format = (req.query.format ?? 'fountain').toLowerCase();
      if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
        return reply.status(400).send({ error: 'unsupported_format', formats: EXPORT_FORMATS });
      }
      const script = await loadOwn(req.params.id, session.user.id);
      if (!script) return reply.status(404).send({ error: 'not_found' });

      const doc = parseFountain(script.fountain);
      const filename = `${encodeURIComponent(script.title.replace(/[/\\"]/g, ' ').trim() || 'script')}.${format}`;
      reply.header('content-disposition', `attachment; filename*=UTF-8''${filename}`);
      switch (format) {
        case 'pdf':
          reply.type('application/pdf');
          return reply.send(Buffer.from(await exportPdf(doc)));
        case 'fdx':
          reply.type('application/xml; charset=utf-8');
          return reply.send(exportFdx(doc));
        default:
          reply.type('text/plain; charset=utf-8');
          return reply.send(exportFountain(doc));
      }
    },
  );

  async function loadOwn(id: string, userId: string) {
    const rows = await db.select().from(scripts).where(ownScript(id, userId)).limit(1);
    return rows[0];
  }

  function scenarioSources(script: NonNullable<Awaited<ReturnType<typeof loadOwn>>>) {
    return extractScenarioHandoffSources({
      format: scenarioFormatSchema.parse(script.format),
      outline: scenarioOutlineV1Schema.parse(script.outline),
      fountain: script.fountain,
    });
  }

  async function loadOwnThread(scriptId: string, threadId: string, userId: string) {
    const rows = await db
      .select()
      .from(scriptThreads)
      .where(
        and(
          eq(scriptThreads.id, threadId),
          eq(scriptThreads.scriptId, scriptId),
          eq(scriptThreads.userId, userId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async function linkedBoards(scriptId: string, userId: string, projectId: string | null) {
    const rows = await db
      .select({
        id: boards.id,
        projectId: boards.projectId,
        title: boards.title,
        state: boards.state,
        updatedAt: boards.updatedAt,
      })
      .from(boards)
      .where(
        projectId
          ? and(
              eq(boards.userId, userId),
              eq(boards.projectId, projectId),
              isNull(boards.trashedAt),
            )
          : and(eq(boards.userId, userId), isNull(boards.trashedAt)),
      )
      .orderBy(desc(boards.updatedAt))
      .limit(MAX_BOARDS);
    return rows.filter((row) => {
      const document = safeParseBoardDocument(row.state);
      return document.success && boardLinksToScript(document.data, scriptId);
    });
  }

  async function maybeSnapshotAutosave(scriptId: string, rev: number, fountain: string) {
    const latest = await db
      .select({ createdAt: scriptSnapshots.createdAt })
      .from(scriptSnapshots)
      .where(eq(scriptSnapshots.scriptId, scriptId))
      .orderBy(desc(scriptSnapshots.createdAt))
      .limit(1);
    const last = latest[0]?.createdAt?.getTime() ?? 0;
    if (Date.now() - last < AUTOSAVE_SNAPSHOT_MIN_MS) return;
    await db
      .insert(scriptSnapshots)
      .values({ id: nid(), scriptId, rev, fountain, cause: 'autosave' });
  }
}

/**
 * Enforce the «Материалы» ceilings. Returns a 400 body (with a clear RU
 * message) when adding/updating would breach a limit, or null when it fits.
 * Never truncates — the writer decides what to remove.
 */
function materialCeilingError(
  existing: { chars: number }[],
  newChars: number,
  isUpdate = false,
): { error: string; message: string; max: number } | null {
  if (!isUpdate && existing.length >= MAX_MATERIALS) {
    return {
      error: 'too_many_materials',
      message: `Достигнут предел: не более ${MAX_MATERIALS} материалов. Удалите лишние, чтобы добавить новый.`,
      max: MAX_MATERIALS,
    };
  }
  if (newChars > MAX_MATERIAL_CHARS) {
    return {
      error: 'material_too_large',
      message: `Файл слишком большой: не более ${MAX_MATERIAL_CHARS.toLocaleString('ru-RU')} символов.`,
      max: MAX_MATERIAL_CHARS,
    };
  }
  const total = existing.reduce((n, r) => n + r.chars, 0) + newChars;
  if (total > MAX_MATERIALS_TOTAL_CHARS) {
    return {
      error: 'materials_budget_exceeded',
      message: `Превышен лимит контекста: суммарно не более ${MAX_MATERIALS_TOTAL_CHARS.toLocaleString('ru-RU')} символов. Освободите место, удалив материал.`,
      max: MAX_MATERIALS_TOTAL_CHARS,
    };
  }
  return null;
}

async function runImport(format: string, body: Buffer): Promise<ImportResult> {
  switch (format) {
    case 'fdx':
      return importFdx(body.toString('utf-8'));
    case 'pdf':
      return importPdf(new Uint8Array(body));
    case 'docx':
      return importDocx(new Uint8Array(body));
    case 'highland':
      return importHighland(new Uint8Array(body));
    default:
      return importFountain(body.toString('utf-8'));
  }
}

/** Pull `Title:`/`Название:` from the fountain title page, if present. */
function titleFromFountain(fountain: string): string | undefined {
  const doc = parseFountain(fountain);
  const entry = doc.titlePage.find((e) => /^(title|название)$/i.test(e.key));
  const value = entry?.values.join(' ').replace(/[*_]/g, '').trim();
  return value || undefined;
}

/** Pull `Author:`/`Автор:` from the fountain title page, if present. */
function authorFromFountain(fountain: string): string | undefined {
  const doc = parseFountain(fountain);
  const entry = doc.titlePage.find((e) => /^(authors?|авторы?)$/i.test(e.key));
  const value = entry?.values.join(' ').replace(/[*_]/g, '').trim();
  return value || undefined;
}

function encodeMessageCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

function parseMessageCursor(value: string | undefined): { createdAt: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string')
      return null;
    const createdAt = new Date(parsed[0]);
    return Number.isNaN(createdAt.getTime()) || !parsed[1] ? null : { createdAt, id: parsed[1] };
  } catch {
    return null;
  }
}
