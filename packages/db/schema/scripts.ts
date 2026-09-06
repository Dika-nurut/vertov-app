import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { usersApp } from './users';
import { projects } from './projects';

/**
 * «Сценарий» — AI screenplay co-writing canvas.
 *
 * The canonical stored representation is Fountain TEXT (`scripts.fountain`,
 * one column, diff-able and versionable). Everything else (fdx/pdf/docx)
 * is an import/export adapter in @seed/screenplay.
 */

/**
 * МИР ПРОЕКТА — canon injected into every AI call for this script. The current
 * model is a flat `notes` list (Claude-Projects style); `characters`/`tone`/
 * `rules` are legacy typed fields folded into notes on read (see
 * `bibleNotes` in @seed/shared) and dropped on the first save.
 */
export interface ScriptBible {
  notes?: Array<string | { id: string; content: string; includeInAi: boolean }> | undefined;
  characters?: Array<{ name: string; description: string }> | undefined;
  tone?: string[] | undefined;
  rules?: string[] | undefined;
}

export const scripts = pgTable(
  'scripts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** Optional client intent key; retries create exactly one project. */
    createKey: text('create_key'),
    title: text('title').notNull().default('Новый сценарий'),
    fountain: text('fountain').notNull().default(''),
    /** Optimistic-concurrency revision; bumps by 1 on every accepted save. */
    rev: integer('rev').notNull().default(0),
    /** Writing lens; existing projects remain Film by default. */
    format: text('format').notNull().default('film'),
    /** Validated by @seed/shared at the API boundary. */
    brief: jsonb('brief').notNull().$type<Record<string, unknown>>().default({ version: 1 }),
    /** Versioned beats for non-Film projects; Film keeps Fountain canonical. */
    outline: jsonb('outline')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({ version: 1, beats: [] }),
    bible: jsonb('bible').notNull().$type<ScriptBible>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('scripts_user_id_idx').on(t.userId),
    uniqueIndex('scripts_user_create_key_uidx')
      .on(t.userId, t.createKey)
      .where(sql`${t.createKey} IS NOT NULL`),
  ],
);

export const scriptSnapshots = pgTable(
  'script_snapshots',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    rev: integer('rev').notNull(),
    fountain: text('fountain').notNull(),
    /** What produced the snapshot: manual | apply | autosave | restore. */
    cause: text('cause').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('script_snapshots_script_id_idx').on(t.scriptId, t.rev)],
);

/** Anchor of a sidebar thread to a span of the fountain text. */
export interface ScriptThreadAnchor {
  /** Character offsets into the fountain text at revision `rev`. */
  from: number;
  to: number;
  rev: number;
  /** Quoted text fallback used to re-locate the span after edits. */
  quote: string;
}

export interface ScriptThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Present on rewrite-type assistant messages. */
  proposal?: { before: string; after: string } | undefined;
  tier?: string | undefined;
  at: string; // ISO timestamp
}

export const scriptThreads = pgTable(
  'script_threads',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    /**
     * 'chat' = the single pinned, anchor-less project conversation per
     * script (the «Чат» tab); 'thread' = an anchored/whole-script side
     * thread (the «Треды» tab).
     */
    kind: text('kind').notNull().default('thread'),
    /** null = whole-script thread (structure, pacing, arcs). */
    anchor: jsonb('anchor').$type<ScriptThreadAnchor | null>(),
    messages: jsonb('messages').notNull().$type<ScriptThreadMessage[]>().default([]),
    /**
     * Rolling summary of messages evicted from the verbatim window — our
     * side, invisible to the user, keeps per-call cost flat for the life of
     * a years-long project. Refreshed on window overflow.
     */
    conspect: text('conspect').notNull().default(''),
    /** Count of leading messages already folded into `conspect`. */
    conspectUpto: integer('conspect_upto').notNull().default(0),
    /** open | applied | dismissed | detached (anchor lost after edits). */
    status: text('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('script_threads_script_id_idx').on(t.scriptId)],
);

/** Append-only message ledger; `script_threads.messages` remains a temporary dual-read fallback. */
export const scriptThreadMessages = pgTable(
  'script_thread_messages',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => scriptThreads.id, { onDelete: 'cascade' }),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    proposal: jsonb('proposal').$type<{ before: string; after: string } | null>(),
    tier: text('tier'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('script_thread_messages_thread_cursor_idx').on(t.threadId, t.createdAt, t.id),
    index('script_thread_messages_script_user_idx').on(t.scriptId, t.userId, t.createdAt),
  ],
);

/**
 * Durable request claim for paid Scenario assist. A client-generated key is
 * unique per user, so an uncertain retry cannot start a second provider call,
 * create another conversation turn, or reserve credits twice.
 */
export const scriptAssistRequests = pgTable(
  'script_assist_requests',
  {
    id: text('id').primaryKey(),
    // ON DELETE SET NULL (not cascade): deleting a script must NOT destroy an
    // in-flight paid claim's recovery data (jobId/amount/reserved) while its
    // credit hold survives — that would strand money unrecoverably. The claim
    // outlives the script and the reaper settles it by jobId; scriptId is only
    // read on the replay path, which is unreachable once the script is gone (404).
    scriptId: text('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    threadId: text('thread_id').references(() => scriptThreads.id, { onDelete: 'set null' }),
    /** in_progress | completed | failed | aborted — never a source of assistant content. */
    status: text('status').notNull().default('in_progress'),
    failure: text('failure'),
    /**
     * The validated structurization result ({format, brief, outline, question?})
     * persisted atomically with status='completed', so a lost response can be
     * replayed on an idempotent retry (the user is charged — the paid output must
     * be recoverable). NULL for assist requests, which persist their output in
     * the thread ledger instead.
     */
    result: jsonb('result').$type<Record<string, unknown>>(),
    /**
     * The credit-ledger jobId this paid request reserved against. Persisted (not
     * just in memory) so a crashed request's hold is reconcilable: status encodes
     * the intent (completed → commit, failed/aborted/stale → refund) and jobId is
     * the reservation to settle. Set by structurize; NULL for assist (whose holds
     * are keyed on its own in-memory id — a shared reaper is a separate follow-up).
     */
    jobId: text('job_id'),
    /**
     * The exact credit amount reserved for this claim. Persisted so stale
     * recovery refunds (and replay metadata) use the amount ACTUALLY reserved, not
     * the process's current price — otherwise a claim that crosses a pricing
     * deploy would refund the wrong amount (over → ledger rejects it forever;
     * under → strands credits in pending). Structurize-only; NULL for assist.
     */
    amount: integer('amount'),
    /**
     * Fingerprint of the normalized paid request/source. Structurize and shot
     * planning bind the script/source identity; Prompt Studio binds its brief,
     * model, refs, and fitted context. A completed result is replayed on an
     * idempotent-key retry only when this fingerprint matches, so a reused key
     * cannot return another request's paid output.
     */
    sourceHash: text('source_hash'),
    /**
     * Which paid operation owns this row: 'assist' (default — assist inserts don't
     * set it) or 'structurize'. The in-flight uniqueness is PER-OP so the two
     * operations never share a slot: a crashed assist claim can't block
     * structurize (and vice versa), and each operation only ever reclaims its own
     * rows. Every structurize claim also carries jobId, so its holds are settleable.
     */
    op: text('op').notNull().default('assist'),
    /**
     * Anti-farm cluster for the owner-approved anonymous acquisition call. It is
     * set only when `op='structurize_free'`; the partial unique index allows one
     * completed (or live) claim per cluster while failed claims can be retried.
     */
    freeClusterKey: text('free_cluster_key'),
    /**
     * True once the credit reservation is confirmed (set ATOMICALLY with
     * `credits.reserve`). A claim is inserted BEFORE reserving, so a crash in that
     * window leaves an in_progress row with a jobId but NO ledger hold — stale
     * recovery must refund only `reserved` claims, else it enqueues a refund the
     * ledger rejects forever (poison queue). Structurize-only; assist leaves false.
     */
    reserved: boolean('reserved').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotency-key uniqueness is PER-OP: a client key reused across assist and
    // structurize (a generic UUID) must dedup within its own operation, never
    // collide across operations (which would poison the other's key).
    uniqueIndex('script_assist_requests_user_op_key_uidx').on(t.userId, t.op, t.idempotencyKey),
    // At most one paid provider call per user PER OPERATION at any time. Per-op so
    // assist and structurize don't block each other; the concurrency backstop
    // across API processes, not merely UI state.
    uniqueIndex('script_assist_requests_user_op_inflight_uidx')
      .on(t.userId, t.op)
      .where(sql`${t.status} = 'in_progress'`),
    index('script_assist_requests_script_id_idx').on(t.scriptId, t.createdAt),
    // The reaper sweeps stuck in_progress claims by their updatedAt lease; a
    // partial index keeps that scan cheap (the in_progress set is tiny).
    index('script_assist_requests_inflight_age_idx')
      .on(t.updatedAt)
      .where(sql`${t.status} = 'in_progress'`),
    uniqueIndex('script_assist_requests_free_cluster_uidx')
      .on(t.freeClusterKey)
      .where(
        sql`${t.op} = 'structurize_free' AND ${t.freeClusterKey} IS NOT NULL AND ${t.status} NOT IN ('failed', 'aborted')`,
      ),
  ],
);

/**
 * «Материалы проекта» — user-uploaded/created files that are part of МИР
 * ПРОЕКТА (the editor's memory) and injected into every AI call for the
 * script. Large files are background-compacted to a `summary` on upload so the
 * memory stays cheap to read every turn; the raw `content` is kept for
 * display/removal/export. No per-file toggles; removed with ✕. Server-enforced
 * ceilings live in the scripts API.
 */
export const scriptMaterials = pgTable(
  'script_materials',
  {
    id: text('id').primaryKey(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => usersApp.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    content: text('content').notNull(),
    /** Character count of `content` (the ceiling/meter unit). */
    chars: integer('chars').notNull(),
    /**
     * Background-compacted version of `content`, produced by the economy model
     * on upload (МИР ПРОЕКТА = the editor's memory — kept cheap to read every
     * turn). ALWAYS shorter than `content`; injected into the AI prompt in its
     * place when present. NULL = not compacted (small file / legacy row) → the
     * raw `content` is used. Never shown to the user or used for export.
     */
    summary: text('summary'),
    /** ready | processing | failed_raw_used — raw content always remains usable. */
    processingStatus: text('processing_status').notNull().default('ready'),
    /** Canon participates in assist context; Scratch remains stored but excluded. */
    includeInAi: integer('include_in_ai').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('script_materials_script_id_idx').on(t.scriptId)],
);

export type Script = typeof scripts.$inferSelect;
export type ScriptSnapshot = typeof scriptSnapshots.$inferSelect;
export type ScriptThread = typeof scriptThreads.$inferSelect;
export type ScriptThreadMessageRow = typeof scriptThreadMessages.$inferSelect;
export type ScriptAssistRequest = typeof scriptAssistRequests.$inferSelect;
export type ScriptMaterial = typeof scriptMaterials.$inferSelect;
