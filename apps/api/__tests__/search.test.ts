import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply } from 'fastify';
import { inArray } from 'drizzle-orm';
import {
  boards,
  db,
  galleryItems,
  nid,
  pool,
  projectAssets,
  projects,
  scripts,
  studioProjects,
  usersApp,
  usersPii,
} from '@seed/db';
import {
  MEDIA_DETAIL_SQL,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_SQL,
  setupSearchRoutes,
} from '../src/search';

let app: ReturnType<typeof Fastify>;
let ownerId: string;
let foreignId: string;
let liveProjectId: string;
let secondProjectId: string;
let deletedProjectId: string;
let multiAssetId: string;
let standaloneAssetId: string;
let liveExpiringAssetId: string;
let expiredAssetId: string;
let deletedAssetId: string;
let foreignAssetId: string;
let generatedAssetId: string;

async function insertUser(id: string, label: string) {
  await db.insert(usersApp).values({ id, displayName: label, locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `${label}-${id}@search.seed.local` });
}

beforeAll(async () => {
  ownerId = nid();
  foreignId = nid();
  await insertUser(ownerId, 'owner');
  await insertUser(foreignId, 'foreign');

  liveProjectId = nid();
  secondProjectId = nid();
  deletedProjectId = nid();
  await db.insert(projects).values([
    { id: liveProjectId, userId: ownerId, title: 'Needle Project' },
    { id: secondProjectId, userId: ownerId, title: 'Other workspace' },
    {
      id: deletedProjectId,
      userId: ownerId,
      title: 'Needle trashed project',
      deletedAt: new Date(),
    },
    { id: nid(), userId: foreignId, title: 'Needle foreign project' },
  ]);

  await db.insert(scripts).values([
    { id: nid(), userId: ownerId, projectId: liveProjectId, title: 'Needle' },
    { id: nid(), userId: ownerId, title: 'Needle standalone scenario' },
    { id: nid(), userId: ownerId, projectId: deletedProjectId, title: 'Needle hidden script' },
    { id: nid(), userId: foreignId, title: 'Needle foreign script' },
  ]);
  await db.insert(boards).values([
    { id: nid(), userId: ownerId, projectId: liveProjectId, title: 'Needle board', state: {} },
    { id: nid(), userId: foreignId, title: 'Needle foreign board', state: {} },
  ]);
  await db.insert(studioProjects).values([
    {
      id: nid(),
      userId: ownerId,
      projectId: liveProjectId,
      title: 'Needle studio document',
      timeline: {},
    },
    {
      id: nid(),
      userId: foreignId,
      title: 'Needle foreign studio',
      timeline: {},
    },
  ]);

  multiAssetId = nid();
  standaloneAssetId = nid();
  liveExpiringAssetId = nid();
  expiredAssetId = nid();
  deletedAssetId = nid();
  foreignAssetId = nid();
  generatedAssetId = nid();
  await db.insert(galleryItems).values([
    {
      id: multiAssetId,
      userId: ownerId,
      title: 'Needle media',
      assetUrl: 'https://assets.seed.test/search-owned.png',
      kind: 'image',
    },
    {
      id: standaloneAssetId,
      userId: ownerId,
      originalName: 'needle-standalone.mov',
      assetUrl: 'https://assets.seed.test/search-standalone.mov',
      kind: 'video',
    },
    {
      id: liveExpiringAssetId,
      userId: ownerId,
      title: 'Needle live expiring media',
      assetUrl: 'https://assets.seed.test/search-live-expiring.png',
      kind: 'image',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
    {
      id: expiredAssetId,
      userId: ownerId,
      title: 'Needle expired media',
      assetUrl: 'https://assets.seed.test/search-expired.png',
      kind: 'image',
      expiresAt: new Date(Date.now() - 86_400_000),
    },
    {
      id: deletedAssetId,
      userId: ownerId,
      title: 'Needle deleted media',
      assetUrl: 'https://assets.seed.test/search-deleted.png',
      kind: 'image',
      deletedAt: new Date(),
    },
    {
      id: foreignAssetId,
      userId: foreignId,
      title: 'Needle foreign media',
      assetUrl: 'https://assets.seed.test/search-foreign.png',
      kind: 'image',
    },
    {
      id: generatedAssetId,
      userId: ownerId,
      title: 'Девушка на берегу моря · 2 из 3',
      assetUrl: 'https://assets.seed.test/generated-cyrillic.png',
      kind: 'image',
      sourceKind: 'generation',
    },
  ]);
  await db.insert(projectAssets).values([
    { projectId: liveProjectId, assetId: multiAssetId, userId: ownerId },
    { projectId: secondProjectId, assetId: multiAssetId, userId: ownerId },
    { projectId: liveProjectId, assetId: generatedAssetId, userId: ownerId },
  ]);

  app = Fastify({ logger: false });
  setupSearchRoutes(app, async () => ({ user: { id: ownerId } }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db.delete(projectAssets).where(inArray(projectAssets.userId, [ownerId, foreignId]));
  await db.delete(galleryItems).where(inArray(galleryItems.userId, [ownerId, foreignId]));
  await db.delete(studioProjects).where(inArray(studioProjects.userId, [ownerId, foreignId]));
  await db.delete(boards).where(inArray(boards.userId, [ownerId, foreignId]));
  await db.delete(scripts).where(inArray(scripts.userId, [ownerId, foreignId]));
  await db.delete(projects).where(inArray(projects.userId, [ownerId, foreignId]));
  await db.delete(usersPii).where(inArray(usersPii.id, [ownerId, foreignId]));
  await db.delete(usersApp).where(inArray(usersApp.id, [ownerId, foreignId]));
  await pool.end();
});

interface Result {
  type: string;
  title: string;
  href: string;
  association: string;
  projects: Array<{ id: string; title: string }>;
  projectCount: number;
}

interface SearchBody {
  groups: Array<{ type: string; items: Result[] }>;
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
}

function items(body: SearchBody): Result[] {
  return body.groups.flatMap((group) => group.items);
}

describe('GET /v1/search', () => {
  it('finds a generated persisted Cyrillic title in all-Sreda and project scope', async () => {
    for (const suffix of ['', `&projectId=${liveProjectId}`]) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/search?q=${encodeURIComponent('берегу моря')}${suffix}`,
      });
      expect(response.statusCode).toBe(200);
      expect(items(response.json() as SearchBody)).toContainEqual(
        expect.objectContaining({
          type: 'media',
          title: 'Девушка на берегу моря · 2 из 3',
          href: `/media/${generatedAssetId}`,
          association: 'single',
        }),
      );
    }
  });

  it('returns every supported type while excluding foreign, deleted, and trashed-context data', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=needle&limit=25' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json() as SearchBody;
    const rows = items(body);

    expect(new Set(rows.map((row) => row.type))).toEqual(
      new Set(['project', 'script', 'board', 'studio', 'media']),
    );
    expect(rows.map((row) => row.title).join(' ')).not.toMatch(
      /foreign|hidden|deleted|expired|trashed/i,
    );
    expect(body.groups.map((group) => group.type)).toEqual([
      'project',
      'script',
      'board',
      'studio',
      'media',
    ]);
  });

  it('labels standalone and multi-project objects without guessing media context', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=needle&limit=25' });
    const rows = items(response.json() as SearchBody);
    const attachedScript = rows.find((row) => row.title === 'Needle');
    const standaloneScript = rows.find((row) => row.title === 'Needle standalone scenario');
    const multiMedia = rows.find((row) => row.title === 'Needle media');
    const standaloneMedia = rows.find((row) => row.title === 'needle-standalone.mov');

    expect(attachedScript).toMatchObject({ association: 'single' });
    expect(attachedScript?.href).toContain(`projectId=${liveProjectId}`);
    expect(standaloneScript).toMatchObject({ association: 'standalone' });
    expect(standaloneScript?.href).not.toContain('projectId=');
    expect(multiMedia).toMatchObject({ association: 'multiple' });
    expect(multiMedia?.projects).toHaveLength(2);
    expect(multiMedia?.projectCount).toBe(2);
    expect(multiMedia?.href).toBe(`/media/${multiAssetId}`);
    expect(standaloneMedia).toMatchObject({
      association: 'standalone',
      href: `/media/${standaloneAssetId}`,
    });
  });

  it('scopes results to one validated project without leaking standalone work', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/search?q=needle&limit=25&projectId=${liveProjectId}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as SearchBody & {
      scope: { kind: string; projectId?: string };
    };
    const rows = items(body);

    expect(body.scope).toEqual({ kind: 'project', projectId: liveProjectId });
    expect(rows.map((row) => row.title)).not.toContain('Needle standalone scenario');
    expect(rows.map((row) => row.title)).not.toContain('needle-standalone.mov');
    expect(rows).not.toHaveLength(0);
    expect(
      rows.every(
        (row) =>
          row.type === 'project' || row.projects.some((project) => project.id === liveProjectId),
      ),
    ).toBe(true);

    const unavailable = await app.inject({
      method: 'GET',
      url: `/v1/search?q=needle&projectId=${deletedProjectId}`,
    });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).toEqual({ error: 'project_not_found' });
  });

  it('uses database-time lifecycle semantics for live, expired, and deleted media', async () => {
    expect(SEARCH_SQL).toContain('g.expires_at > CURRENT_TIMESTAMP');
    expect(MEDIA_DETAIL_SQL).toContain('g.expires_at > CURRENT_TIMESTAMP');
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=needle&limit=25' });
    const media = items(response.json() as SearchBody).filter((row) => row.type === 'media');
    const titles = media.map((row) => row.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        'Needle media',
        'needle-standalone.mov',
        'Needle live expiring media',
      ]),
    );
    expect(titles).not.toContain('Needle expired media');
    expect(titles).not.toContain('Needle deleted media');
  });

  it('opens an exact owned live asset neutrally with deliberate project actions', async () => {
    const multi = await app.inject({
      method: 'GET',
      url: `/v1/search/media/${multiAssetId}`,
    });
    expect(multi.statusCode).toBe(200);
    expect(multi.headers['cache-control']).toBe('private, no-store');
    expect(multi.json()).toMatchObject({
      media: {
        id: multiAssetId,
        association: 'multiple',
        projectCount: 2,
        projectsTruncated: false,
      },
    });
    expect(
      (multi.json() as { media: { projects: Array<{ id: string }> } }).media.projects.map(
        (project) => project.id,
      ),
    ).toEqual(expect.arrayContaining([liveProjectId, secondProjectId]));

    const standalone = await app.inject({
      method: 'GET',
      url: `/v1/search/media/${standaloneAssetId}`,
    });
    expect(standalone.statusCode).toBe(200);
    expect(standalone.json()).toMatchObject({
      media: {
        id: standaloneAssetId,
        association: 'standalone',
        projectCount: 0,
        projects: [],
      },
    });
  });

  it.each([
    ['expired', () => expiredAssetId],
    ['deleted', () => deletedAssetId],
    ['foreign', () => foreignAssetId],
  ])('does not expose an exact %s asset', async (_label, id) => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/search/media/${id()}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });

  it('uses deterministic exact-first ranking and bounded pagination', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/search?q=needle&limit=2&page=1' });
    const second = await app.inject({ method: 'GET', url: '/v1/search?q=needle&limit=2&page=2' });
    const firstBody = first.json() as SearchBody;
    const secondBody = second.json() as SearchBody;

    const scriptGroup = [...firstBody.groups, ...secondBody.groups].find(
      (group) => group.type === 'script',
    );
    expect(scriptGroup?.items[0]?.title).toBe('Needle');
    expect(
      new Set([...items(firstBody), ...items(secondBody)].map((row) => `${row.type}:${row.title}`))
        .size,
    ).toBe(4);
    expect(firstBody).toMatchObject({ page: 1, limit: 2, hasNext: true });
    expect(firstBody.totalPages).toBeGreaterThan(1);
  });

  it.each([
    ['', 'missing query'],
    [`${'q'.repeat(SEARCH_MAX_QUERY_LENGTH + 1)}`, 'long query'],
    [`needle&limit=${SEARCH_MAX_PAGE_SIZE + 1}`, 'large page size'],
    [`needle&page=${SEARCH_MAX_PAGE + 1}`, 'large page number'],
  ])('rejects a bounded-contract violation: %s (%s)', async (query) => {
    const response = await app.inject({ method: 'GET', url: `/v1/search?q=${query}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_search_query' });
  });

  it('treats SQL wildcard characters as literal query text', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/search?q=%25' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ total: 0, groups: [] });
  });

  it('requires an authenticated session before running any search', async () => {
    const guarded = Fastify({ logger: false });
    setupSearchRoutes(guarded, async (_req, reply: FastifyReply) => {
      reply.status(401).send({ error: 'unauthenticated' });
      return null;
    });
    await guarded.ready();
    const response = await guarded.inject({ method: 'GET', url: '/v1/search?q=needle' });
    expect(response.statusCode).toBe(401);
    await guarded.close();
  });

  it('has planner evidence for every selected trigram search index', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const checks = [
        {
          index: 'projects_title_search_idx',
          sql: `EXPLAIN (COSTS OFF) SELECT id FROM projects
                WHERE lower(title) LIKE '%needle%'`,
        },
        {
          index: 'scripts_title_search_idx',
          sql: `EXPLAIN (COSTS OFF) SELECT id FROM scripts
                WHERE lower(title) LIKE '%needle%'`,
        },
        {
          index: 'boards_title_search_idx',
          sql: `EXPLAIN (COSTS OFF) SELECT id FROM boards
                WHERE lower(title) LIKE '%needle%'`,
        },
        {
          index: 'studio_projects_title_search_idx',
          sql: `EXPLAIN (COSTS OFF) SELECT id FROM studio_projects
                WHERE lower(title) LIKE '%needle%'`,
        },
        {
          index: 'gallery_items_search_idx',
          sql: `EXPLAIN (COSTS OFF) SELECT id FROM gallery_items
                WHERE lower(coalesce(title, '') || ' ' || coalesce(original_name, ''))
                    LIKE '%needle%'`,
        },
      ];
      for (const check of checks) {
        const plan = await client.query<{ 'QUERY PLAN': string }>(check.sql);
        expect(plan.rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(check.index);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
