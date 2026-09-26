import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db as defaultDb, galleryItems, jobs, models, workflows } from '@seed/db';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'refunded';

type DbLike = typeof defaultDb;

export interface ListJobsOptions {
  limit?: number;
  cursor?: string;
  status?: JobStatus | JobStatus[];
}

export interface JobListRow {
  id: string;
  status: string;
  modelId: string;
  modelDisplayName: string | null;
  resultAssets: string[];
  resultExpiresAt: Date | null;
  resultUnavailableReason: 'deleted' | 'expired' | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface JobsPage {
  rows: JobListRow[];
  nextCursor: string | null;
}

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'refunded'] as const;

export function isJobStatus(value: string | undefined): value is JobStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

/**
 * SF-11: count a user's in-flight (queued|running) jobs so the submit path can
 * cap how many expensive generations one account holds reserved at once.
 * Bounded by `cap + 1` — we only need to know whether the cap is reached.
 */
export async function countActiveJobsForUser(
  userId: string,
  cap: number,
  db: DbLike = defaultDb,
): Promise<number> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), inArray(jobs.status, ['queued', 'running'])))
    .limit(cap + 1);
  return rows.length;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const idx = raw.indexOf('|');
  if (idx < 0) return null;
  const iso = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

interface JobAssetSummary {
  liveUrls: Set<string>;
  liveExpiresAt: Date | null;
  expiredAt: Date | null;
  hasDeleted: boolean;
}

function emptyJobAssetSummary(): JobAssetSummary {
  return { liveUrls: new Set(), liveExpiresAt: null, expiredAt: null, hasDeleted: false };
}

function summarizeAssetRows(
  rows: Array<{
    jobId: string | null;
    assetUrl: string;
    expiresAt: Date | null;
    deletedAt: Date | null;
  }>,
  now: Date,
): Map<string, JobAssetSummary> {
  const summaries = new Map<string, JobAssetSummary>();
  for (const row of rows) {
    if (!row.jobId) continue;
    const summary = summaries.get(row.jobId) ?? emptyJobAssetSummary();
    const live = !row.deletedAt && (!row.expiresAt || row.expiresAt > now);
    if (live) {
      summary.liveUrls.add(row.assetUrl);
      if (
        row.expiresAt &&
        (!summary.liveExpiresAt || row.expiresAt.getTime() < summary.liveExpiresAt.getTime())
      ) {
        summary.liveExpiresAt = row.expiresAt;
      }
    } else if (row.deletedAt) {
      summary.hasDeleted = true;
    } else if (
      row.expiresAt &&
      (!summary.expiredAt || row.expiresAt.getTime() < summary.expiredAt.getTime())
    ) {
      summary.expiredAt = row.expiresAt;
    }
    summaries.set(row.jobId, summary);
  }
  return summaries;
}

function summaryExpiry(summary: JobAssetSummary | undefined): Date | null {
  if (!summary) return null;
  return summary.liveUrls.size > 0 ? summary.liveExpiresAt : summary.expiredAt;
}

function summaryUnavailableReason(
  summary: JobAssetSummary | undefined,
): 'deleted' | 'expired' | null {
  if (!summary || summary.liveUrls.size > 0) return null;
  if (summary.hasDeleted) return 'deleted';
  return summary.expiredAt ? 'expired' : null;
}

/**
 * Jobs remain receipts after an asset expires, but their media URLs must obey
 * the same owner + retention boundary as the gallery. Query all rows for a
 * page in one pass so pagination does not reintroduce an N+1 media check.
 */
async function assetSummariesByJob(
  database: DbLike,
  userId: string,
  jobIds: readonly string[],
  now = new Date(),
): Promise<Map<string, JobAssetSummary>> {
  if (jobIds.length === 0) return new Map();
  const rows = await database
    .select({
      jobId: galleryItems.jobId,
      assetUrl: galleryItems.assetUrl,
      expiresAt: galleryItems.expiresAt,
      deletedAt: galleryItems.deletedAt,
    })
    .from(galleryItems)
    .where(and(eq(galleryItems.userId, userId), inArray(galleryItems.jobId, [...new Set(jobIds)])));
  return summarizeAssetRows(rows, now);
}

function visibleResultAssets(
  jobId: string,
  resultAssets: readonly string[],
  liveUrls: Map<string, Set<string>>,
): string[] {
  const allowed = liveUrls.get(jobId);
  if (!allowed) return [];
  return resultAssets.filter((url) => allowed.has(url));
}

export async function listJobsForUser(
  userId: string,
  opts: ListJobsOptions = {},
  database: DbLike = defaultDb,
): Promise<JobsPage> {
  const safeLimit = Math.max(1, Math.min(100, opts.limit ?? 24));
  const filters: SQL[] = [eq(jobs.userId, userId)];
  if (opts.status) {
    filters.push(
      Array.isArray(opts.status) ? inArray(jobs.status, opts.status) : eq(jobs.status, opts.status),
    );
  }
  if (opts.cursor) {
    const parsed = decodeCursor(opts.cursor);
    if (parsed) {
      const tieBreaker = or(
        sql`${jobs.queuedAt} < ${parsed.createdAt}`,
        and(eq(jobs.queuedAt, parsed.createdAt), sql`${jobs.id} < ${parsed.id}`),
      );
      if (tieBreaker) filters.push(tieBreaker);
    }
  }

  const rows = await database
    .select({
      id: jobs.id,
      status: jobs.status,
      modelId: jobs.modelId,
      modelDisplayName: models.displayName,
      resultAssets: jobs.resultAssets,
      errorCode: jobs.errorCode,
      errorMessage: jobs.errorMessage,
      queuedAt: jobs.queuedAt,
    })
    .from(jobs)
    .innerJoin(models, eq(models.id, jobs.modelId))
    .where(and(...filters))
    .orderBy(desc(jobs.queuedAt), desc(jobs.id))
    .limit(safeLimit + 1);

  const assetSummaries = await assetSummariesByJob(
    database,
    userId,
    rows.map((row) => row.id),
  );
  const liveUrls = new Map(
    [...assetSummaries].map(([jobId, summary]) => [jobId, summary.liveUrls] as const),
  );

  const hasMore = rows.length > safeLimit;
  const page = (hasMore ? rows.slice(0, safeLimit) : rows).map((r) => ({
    id: r.id,
    status: r.status,
    modelId: r.modelId,
    modelDisplayName: r.modelDisplayName,
    resultAssets: visibleResultAssets(r.id, r.resultAssets, liveUrls),
    resultExpiresAt: summaryExpiry(assetSummaries.get(r.id)),
    resultUnavailableReason: summaryUnavailableReason(assetSummaries.get(r.id)),
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.queuedAt,
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  return { rows: page, nextCursor };
}

export interface JobDetail {
  id: string;
  status: string;
  modelId: string;
  resultAssets: string[];
  resultExpiresAt: Date | null;
  resultUnavailableReason: 'deleted' | 'expired' | null;
  errorCode: string | null;
  errorMessage: string | null;
  creditsReserved: number;
  creditsSpent: number;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  params: Record<string, unknown>;
  referenceAssets: string[];
  /** Catalogue identity, including inactive rows, for an honest historical receipt. */
  model: {
    family: string;
    variant: string;
    displayName: string | null;
    kind: string;
    capabilities: Record<string, unknown> | null;
  } | null;
  /** First gallery_items row for this job (added W3.Thu); null if not yet materialised. */
  galleryItem: { id: string; isPublic: boolean; publicSlug: string | null } | null;
}

export async function getJobForUser(
  jobId: string,
  userId: string,
  database: DbLike = defaultDb,
): Promise<JobDetail | null> {
  const rows = await database
    .select({
      id: jobs.id,
      status: jobs.status,
      modelId: jobs.modelId,
      resultAssets: jobs.resultAssets,
      errorCode: jobs.errorCode,
      errorMessage: jobs.errorMessage,
      creditsReserved: jobs.creditsReserved,
      creditsSpent: jobs.creditsSpent,
      queuedAt: jobs.queuedAt,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      params: workflows.params,
      referenceAssets: workflows.referenceAssets,
      modelFamily: models.family,
      modelVariant: models.variant,
      modelDisplayName: models.displayName,
      modelKind: models.kind,
      modelCapabilities: models.capabilities,
    })
    .from(jobs)
    .innerJoin(workflows, eq(workflows.id, jobs.workflowId))
    .leftJoin(models, eq(models.id, jobs.modelId))
    .where(and(eq(jobs.id, jobId), eq(jobs.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const giRows = await database
    .select({
      id: galleryItems.id,
      jobId: galleryItems.jobId,
      isPublic: galleryItems.isPublic,
      publicSlug: galleryItems.publicSlug,
      assetUrl: galleryItems.assetUrl,
      expiresAt: galleryItems.expiresAt,
      deletedAt: galleryItems.deletedAt,
    })
    .from(galleryItems)
    .where(and(eq(galleryItems.jobId, jobId), eq(galleryItems.userId, userId)));
  const now = new Date();
  const assetSummary = summarizeAssetRows(giRows, now).get(jobId);
  const liveGalleryRows = giRows.filter(
    (item) => !item.deletedAt && (!item.expiresAt || item.expiresAt > now),
  );
  const liveUrls = new Map<string, Set<string>>();
  const liveJobUrls = assetSummary ? [...assetSummary.liveUrls] : [];
  if (liveJobUrls.length > 0) liveUrls.set(jobId, new Set(liveJobUrls));
  const resultExpiresAt = summaryExpiry(assetSummary);
  return {
    id: row.id,
    status: row.status,
    modelId: row.modelId,
    resultAssets: visibleResultAssets(row.id, row.resultAssets, liveUrls),
    resultExpiresAt,
    resultUnavailableReason: summaryUnavailableReason(assetSummary),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    creditsReserved: row.creditsReserved,
    creditsSpent: row.creditsSpent,
    queuedAt: row.queuedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    params: row.params as Record<string, unknown>,
    referenceAssets: row.referenceAssets as string[],
    model:
      row.modelFamily && row.modelVariant && row.modelKind
        ? {
            family: row.modelFamily,
            variant: row.modelVariant,
            displayName: row.modelDisplayName,
            kind: row.modelKind,
            capabilities: row.modelCapabilities,
          }
        : null,
    galleryItem: liveGalleryRows[0]
      ? {
          id: liveGalleryRows[0].id,
          isPublic: liveGalleryRows[0].isPublic,
          publicSlug: liveGalleryRows[0].publicSlug,
        }
      : null,
  };
}
