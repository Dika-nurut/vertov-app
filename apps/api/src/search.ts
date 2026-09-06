import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '@seed/db';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

export const SEARCH_MAX_QUERY_LENGTH = 100;
export const SEARCH_MAX_PAGE_SIZE = 25;
export const SEARCH_MAX_PAGE = 100;

const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(SEARCH_MAX_QUERY_LENGTH),
    page: z.coerce.number().int().min(1).max(SEARCH_MAX_PAGE).default(1),
    limit: z.coerce.number().int().min(1).max(SEARCH_MAX_PAGE_SIZE).default(20),
    projectId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export type SearchResultType = 'project' | 'script' | 'board' | 'studio' | 'media';

interface SearchRow {
  type: SearchResultType;
  id: string;
  title: string;
  mediaKind: 'image' | 'video' | 'audio' | null;
  thumbnailUrl: string | null;
  projectIds: string[];
  projectTitles: string[];
  projectCount: number;
  updatedAt: string;
  rank: number;
}

interface SearchQueryResult {
  items: SearchRow[];
  total: number;
}

interface MediaDetailRow {
  id: string;
  title: string | null;
  originalName: string | null;
  assetUrl: string;
  thumbnailUrl: string | null;
  kind: 'image' | 'video' | 'audio';
  mimeType: string | null;
  createdAt: string;
  projects: Array<{ id: string; title: string }>;
  projectCount: number;
}

/**
 * One bounded query keeps cross-type ordering and pagination stable. Every
 * candidate arm applies the authenticated owner id before ranking. Attached
 * documents additionally require a live project owned by the same user.
 */
export const SEARCH_SQL = `
WITH owned_projects AS MATERIALIZED (
  SELECT id, title, updated_at
  FROM projects
  WHERE user_id = $1 AND deleted_at IS NULL
    AND ($8::text IS NULL OR id = $8)
),
candidates AS (
  SELECT
    'project'::text AS type,
    p.id,
    p.title,
    NULL::text AS media_kind,
    NULL::text AS thumbnail_url,
    ARRAY[p.id]::text[] AS project_ids,
    ARRAY[p.title]::text[] AS project_titles,
    1::int AS project_count,
    p.updated_at,
    lower(p.title) AS search_text
  FROM owned_projects p
  WHERE lower(p.title) LIKE $2 ESCAPE '\\'

  UNION ALL

  SELECT
    'script', s.id, s.title, NULL, NULL,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.id]::text[] END,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.title]::text[] END,
    CASE WHEN p.id IS NULL THEN 0 ELSE 1 END,
    s.updated_at, lower(s.title)
  FROM scripts s
  LEFT JOIN owned_projects p ON p.id = s.project_id
  WHERE s.user_id = $1
    AND (s.project_id IS NULL OR p.id IS NOT NULL)
    AND ($8::text IS NULL OR s.project_id = $8)
    AND lower(s.title) LIKE $2 ESCAPE '\\'

  UNION ALL

  SELECT
    'board', b.id, b.title, NULL, NULL,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.id]::text[] END,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.title]::text[] END,
    CASE WHEN p.id IS NULL THEN 0 ELSE 1 END,
    b.updated_at, lower(b.title)
  FROM boards b
  LEFT JOIN owned_projects p ON p.id = b.project_id
  WHERE b.user_id = $1
    AND (b.project_id IS NULL OR p.id IS NOT NULL)
    AND ($8::text IS NULL OR b.project_id = $8)
    AND lower(b.title) LIKE $2 ESCAPE '\\'

  UNION ALL

  SELECT
    'studio', sp.id, sp.title, NULL, NULL,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.id]::text[] END,
    CASE WHEN p.id IS NULL THEN ARRAY[]::text[] ELSE ARRAY[p.title]::text[] END,
    CASE WHEN p.id IS NULL THEN 0 ELSE 1 END,
    sp.updated_at, lower(sp.title)
  FROM studio_projects sp
  LEFT JOIN owned_projects p ON p.id = sp.project_id
  WHERE sp.user_id = $1
    AND (sp.project_id IS NULL OR p.id IS NOT NULL)
    AND ($8::text IS NULL OR sp.project_id = $8)
    AND lower(sp.title) LIKE $2 ESCAPE '\\'

  UNION ALL

  SELECT
    'media', g.id,
    coalesce(nullif(btrim(g.title), ''), nullif(btrim(g.original_name), ''), 'Материал без названия'),
    g.kind::text, coalesce(g.thumbnail_url, g.asset_url),
    coalesce(m.project_ids, ARRAY[]::text[]),
    coalesce(m.project_titles, ARRAY[]::text[]),
    coalesce(m.project_count, 0),
    g.created_at,
    lower(coalesce(g.title, '') || ' ' || coalesce(g.original_name, ''))
  FROM gallery_items g
  LEFT JOIN LATERAL (
    SELECT
      array_agg(members.id ORDER BY members.title, members.id)
        FILTER (WHERE members.position <= 8) AS project_ids,
      array_agg(members.title ORDER BY members.title, members.id)
        FILTER (WHERE members.position <= 8) AS project_titles,
      count(*)::int AS project_count
    FROM (
      SELECT p.id, p.title, row_number() OVER (ORDER BY p.title, p.id) AS position
      FROM project_assets pa
      INNER JOIN owned_projects p ON p.id = pa.project_id
      WHERE pa.asset_id = g.id AND pa.user_id = $1
    ) members
  ) m ON true
  WHERE g.user_id = $1
    AND g.deleted_at IS NULL
    AND (g.expires_at IS NULL OR g.expires_at > CURRENT_TIMESTAMP)
    AND ($8::text IS NULL OR coalesce(m.project_count, 0) > 0)
    AND lower(coalesce(g.title, '') || ' ' || coalesce(g.original_name, ''))
      LIKE $2 ESCAPE '\\'
),
ranked AS (
  SELECT
    type, id, title, media_kind, thumbnail_url, project_ids, project_titles, project_count,
    updated_at,
    CASE
      WHEN search_text = $3 THEN 0
      WHEN search_text LIKE $4 ESCAPE '\\' THEN 1
      WHEN search_text LIKE $5 ESCAPE '\\' THEN 2
      ELSE 3
    END AS rank,
    CASE type
      WHEN 'project' THEN 0
      WHEN 'script' THEN 1
      WHEN 'board' THEN 2
      WHEN 'studio' THEN 3
      ELSE 4
    END AS type_order
  FROM candidates
),
page AS (
  SELECT *
  FROM ranked
  ORDER BY rank, type_order, updated_at DESC, lower(title), id
  LIMIT $6 OFFSET $7
)
SELECT
  coalesce(
    json_agg(
      json_build_object(
        'type', page.type,
        'id', page.id,
        'title', page.title,
        'mediaKind', page.media_kind,
        'thumbnailUrl', page.thumbnail_url,
        'projectIds', page.project_ids,
        'projectTitles', page.project_titles,
        'projectCount', page.project_count,
        'updatedAt', page.updated_at,
        'rank', page.rank
      )
      ORDER BY page.rank, page.type_order, page.updated_at DESC, lower(page.title), page.id
    ),
    '[]'::json
  ) AS items,
  (SELECT count(*)::int FROM ranked) AS total
FROM page
`;

export const MEDIA_DETAIL_SQL = `
WITH owned_projects AS MATERIALIZED (
  SELECT id, title
  FROM projects
  WHERE user_id = $1 AND deleted_at IS NULL
)
SELECT
  g.id,
  g.title,
  g.original_name AS "originalName",
  g.asset_url AS "assetUrl",
  g.thumbnail_url AS "thumbnailUrl",
  g.kind::text AS kind,
  g.mime_type AS "mimeType",
  g.created_at AS "createdAt",
  coalesce(m.projects, '[]'::json) AS projects,
  coalesce(m.project_count, 0) AS "projectCount"
FROM gallery_items g
LEFT JOIN LATERAL (
  SELECT
    coalesce(
      json_agg(
        json_build_object('id', members.id, 'title', members.title)
        ORDER BY members.title, members.id
      ) FILTER (WHERE members.position <= 100),
      '[]'::json
    ) AS projects,
    count(*)::int AS project_count
  FROM (
    SELECT p.id, p.title, row_number() OVER (ORDER BY p.title, p.id) AS position
    FROM project_assets pa
    INNER JOIN owned_projects p ON p.id = pa.project_id
    WHERE pa.asset_id = g.id AND pa.user_id = $1
  ) members
) m ON true
WHERE g.id = $2
  AND g.user_id = $1
  AND g.deleted_at IS NULL
  AND (g.expires_at IS NULL OR g.expires_at > CURRENT_TIMESTAMP)
LIMIT 1
`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function resultHref(row: SearchRow): string {
  const projectId = row.projectIds[0];
  switch (row.type) {
    case 'project':
      return `/workspace/${encodeURIComponent(row.id)}`;
    case 'script':
      return `/scenario/${encodeURIComponent(row.id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
    case 'board':
      return `/boards/${encodeURIComponent(row.id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
    case 'studio':
      return `/studio/${encodeURIComponent(row.id)}${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;
    case 'media':
      return `/media/${encodeURIComponent(row.id)}`;
  }
}

function groupItems(rows: SearchRow[]) {
  const order: SearchResultType[] = ['project', 'script', 'board', 'studio', 'media'];
  return order.flatMap((type) => {
    const items = rows
      .filter((row) => row.type === type)
      .map((row) => ({
        type: row.type,
        id: row.id,
        title: row.title,
        href: resultHref(row),
        mediaKind: row.mediaKind,
        thumbnailUrl: row.thumbnailUrl,
        projects: row.projectIds.map((id, index) => ({
          id,
          title: row.projectTitles[index] ?? 'Проект',
        })),
        projectCount: row.projectCount,
        association:
          row.type === 'project'
            ? 'project'
            : row.projectCount === 0
              ? 'standalone'
              : row.projectCount === 1
                ? 'single'
                : 'multiple',
        updatedAt: row.updatedAt,
      }));
    return items.length > 0 ? [{ type, items }] : [];
  });
}

export function setupSearchRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  app.get<{
    Querystring: { q?: string; page?: string; limit?: string; projectId?: string };
  }>('/v1/search', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_search_query',
        issues: parsed.error.issues,
        limits: {
          queryLength: SEARCH_MAX_QUERY_LENGTH,
          pageSize: SEARCH_MAX_PAGE_SIZE,
          pages: SEARCH_MAX_PAGE,
        },
      });
    }

    const { q, page, limit, projectId } = parsed.data;
    if (projectId) {
      const project = await pool.query(
        `SELECT 1 FROM projects
           WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
           LIMIT 1`,
        [projectId, session.user.id],
      );
      if (project.rowCount !== 1) return reply.status(404).send({ error: 'project_not_found' });
    }
    const normalized = q.toLocaleLowerCase('ru-RU');
    const escaped = escapeLike(normalized);
    const pattern = `%${escaped}%`;
    const prefix = `${escaped}%`;
    const wordPrefix = `% ${escaped}%`;
    const offset = (page - 1) * limit;
    const result = await pool.query<SearchQueryResult>(SEARCH_SQL, [
      session.user.id,
      pattern,
      normalized,
      prefix,
      wordPrefix,
      limit,
      offset,
      projectId ?? null,
    ]);
    const payload = result.rows[0] ?? { items: [], total: 0 };
    const total = Number(payload.total);
    const totalPages = Math.ceil(total / limit);

    reply.header('cache-control', 'private, no-store');
    return {
      query: q,
      groups: groupItems(payload.items),
      page,
      limit,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
      scope: projectId ? { kind: 'project' as const, projectId } : { kind: 'all' as const },
    };
  });

  app.get<{ Params: { id: string } }>('/v1/search/media/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsedId = z.string().trim().min(1).max(160).safeParse(req.params.id);
    if (!parsedId.success) return reply.status(400).send({ error: 'invalid_media_id' });

    const result = await pool.query<MediaDetailRow>(MEDIA_DETAIL_SQL, [
      session.user.id,
      parsedId.data,
    ]);
    const media = result.rows[0];
    if (!media) return reply.status(404).send({ error: 'not_found' });

    reply.header('cache-control', 'private, no-store');
    return {
      media: {
        ...media,
        association:
          media.projectCount === 0
            ? ('standalone' as const)
            : media.projectCount === 1
              ? ('single' as const)
              : ('multiple' as const),
        projectsTruncated: media.projectCount > media.projects.length,
      },
    };
  });
}
