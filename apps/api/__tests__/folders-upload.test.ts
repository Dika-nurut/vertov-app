import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Client as MinioClient } from 'minio';
import {
  assetDeletionLeases,
  assetPlacements,
  assetReferences,
  db,
  folders,
  galleryItems,
  nid,
  pool,
  projectAssets,
  projects,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupFolderRoutes } from '../src/folders';
import { OCTET_STREAM_BODY_LIMIT, UPLOAD_MAX_BYTES } from '../src/upload-limits';

interface StorageStub {
  minio: Pick<MinioClient, 'putObject' | 'removeObject'>;
  puts: string[];
  removes: string[];
  stored: Set<string>;
  armPutBarrier(count: number): void;
}

function makeStorageStub(): StorageStub {
  const puts: string[] = [];
  const removes: string[] = [];
  const stored = new Set<string>();
  let barrierTarget = 0;
  let barrierResolvers: Array<() => void> = [];
  const minio = {
    async putObject(_bucket: string, key: string) {
      puts.push(key);
      stored.add(key);
      if (barrierTarget > 0) {
        await new Promise<void>((resolve) => {
          barrierResolvers.push(resolve);
          if (barrierResolvers.length === barrierTarget) {
            const resolvers = barrierResolvers;
            barrierResolvers = [];
            barrierTarget = 0;
            resolvers.forEach((release) => release());
          }
        });
      }
      return { etag: 'test', versionId: null };
    },
    async removeObject(_bucket: string, key: string) {
      removes.push(key);
      stored.delete(key);
    },
  } as unknown as Pick<MinioClient, 'putObject' | 'removeObject'>;
  return {
    minio,
    puts,
    removes,
    stored,
    armPutBarrier(count: number) {
      barrierTarget = count;
      barrierResolvers = [];
    },
  };
}

function png(seed: string): Buffer {
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from(`fixture-${seed}`),
  ]);
}

let app: ReturnType<typeof Fastify>;
let userId: string;
let otherUserId: string;
let storage: StorageStub;
const projectIds: string[] = [];

const headers = () => ({
  'x-test-user': userId,
  'content-type': 'application/octet-stream',
});

async function makeProject(ownerId = userId, title = 'Загрузки'): Promise<string> {
  const id = nid();
  projectIds.push(id);
  await db.insert(projects).values({ id, userId: ownerId, title });
  return id;
}

function upload(
  projectId: string,
  body: Buffer,
  query: { name?: string; folderId?: string; newFolderName?: string } = {},
) {
  const params = new URLSearchParams({ name: query.name ?? 'кадр.png' });
  if (query.folderId) params.set('folderId', query.folderId);
  if (query.newFolderName) params.set('newFolderName', query.newFolderName);
  return app.inject({
    method: 'POST',
    url: `/v1/projects/${projectId}/assets?${params.toString()}`,
    headers: headers(),
    payload: body,
  });
}

beforeAll(async () => {
  userId = nid();
  otherUserId = nid();
  await db.insert(usersApp).values([
    { id: userId, displayName: 'Upload owner', locale: 'ru' },
    { id: otherUserId, displayName: 'Other owner', locale: 'ru' },
  ]);
  await db.insert(usersPii).values([
    { id: userId, email: `upload-owner+${userId}@seed.local` },
    { id: otherUserId, email: `upload-other+${otherUserId}@seed.local` },
  ]);
  storage = makeStorageStub();
  app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: OCTET_STREAM_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );
  setupFolderRoutes(
    app,
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.headers['x-test-user'] !== userId) {
        reply.status(401).send({ error: 'unauthorized' });
        return null;
      }
      return { user: { id: userId } };
    },
    { minio: storage.minio },
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await db
    .delete(assetDeletionLeases)
    .where(inArray(assetDeletionLeases.userId, [userId, otherUserId]));
  const items = await db
    .select({ id: galleryItems.id })
    .from(galleryItems)
    .where(inArray(galleryItems.userId, [userId, otherUserId]));
  const itemIds = items.map((item) => item.id);
  if (itemIds.length > 0) {
    await db.delete(assetPlacements).where(inArray(assetPlacements.assetId, itemIds));
    await db.delete(assetReferences).where(inArray(assetReferences.galleryItemId, itemIds));
  }
  await db.delete(folders).where(inArray(folders.userId, [userId, otherUserId]));
  await db.delete(galleryItems).where(inArray(galleryItems.userId, [userId, otherUserId]));
  if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.id, projectIds));
  await db.delete(usersPii).where(inArray(usersPii.id, [userId, otherUserId]));
  await db.delete(usersApp).where(inArray(usersApp.id, [userId, otherUserId]));
  await pool.end();
});

describe('project asset upload', () => {
  it('gives every free upload a 30-day expiry, including a filed upload', async () => {
    const projectId = await makeProject();
    const before = Date.now();
    const response = await upload(projectId, png('free-retention'), {
      newFolderName: 'Срок 30 дней',
    });
    expect(response.statusCode).toBe(201);
    const [asset] = await db
      .select({ expiresAt: galleryItems.expiresAt })
      .from(galleryItems)
      .where(eq(galleryItems.id, response.json().assetId));
    expect(asset?.expiresAt).toBeInstanceOf(Date);
    expect(asset!.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
    expect(asset!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
  });

  it('stores paid uploads permanently', async () => {
    const projectId = await makeProject();
    await db.update(usersApp).set({ tier: 'start' }).where(eq(usersApp.id, userId));
    try {
      const response = await upload(projectId, png('paid-retention'));
      expect(response.statusCode).toBe(201);
      const [asset] = await db
        .select({ expiresAt: galleryItems.expiresAt })
        .from(galleryItems)
        .where(eq(galleryItems.id, response.json().assetId));
      expect(asset?.expiresAt).toBeNull();
    } finally {
      await db.update(usersApp).set({ tier: 'free' }).where(eq(usersApp.id, userId));
    }
  });

  it('creates a new live asset when identical bytes are re-uploaded after soft delete', async () => {
    const projectId = await makeProject();
    const body = png('delete-reupload');
    const first = await upload(projectId, body);
    expect(first.statusCode).toBe(201);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/assets/${first.json().assetId}`,
      headers: { 'x-test-user': userId },
    });
    expect(deleted.statusCode).toBe(200);

    const second = await upload(projectId, body);
    expect(second.statusCode).toBe(201);
    expect(second.json().assetId).not.toBe(first.json().assetId);
  });

  it('reuses an existing checksum without another object write', async () => {
    const projectId = await makeProject();
    const body = png('dedupe');
    const putsBefore = storage.puts.length;
    const first = await upload(projectId, body);
    const second = await upload(projectId, body);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      assetId: first.json().assetId,
      reused: true,
      alreadyMember: true,
      receipt: 'Уже в этом проекте',
    });
    expect(storage.puts).toHaveLength(putsBefore + 1);
  });

  it('reuses one library row in project B without a folder and creates membership', async () => {
    const firstProjectId = await makeProject(userId, 'Первый проект');
    const secondProjectId = await makeProject(userId, 'Второй проект');
    const body = png('cross-project-dedupe');
    const first = await upload(firstProjectId, body);
    const second = await upload(secondProjectId, body);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      assetId: first.json().assetId,
      reused: true,
      alreadyMember: false,
      receipt: 'Уже есть в библиотеке',
    });
    const [canonical] = await db
      .select({ checksum: galleryItems.checksum })
      .from(galleryItems)
      .where(eq(galleryItems.id, first.json().assetId));
    expect(
      await db
        .select()
        .from(galleryItems)
        .where(
          and(eq(galleryItems.userId, userId), eq(galleryItems.checksum, canonical!.checksum!)),
        ),
    ).toEqual([expect.objectContaining({ id: first.json().assetId })]);
    const memberships = await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.assetId, first.json().assetId));
    expect(memberships).toHaveLength(2);
    expect(memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectId: firstProjectId, userId }),
        expect.objectContaining({ projectId: secondProjectId, userId }),
      ]),
    );
  });

  it('accepts a 55 MiB payload through the shared parser and actual 64 MiB project route', async () => {
    const projectId = await makeProject();
    const body = Buffer.alloc(55 * 1024 * 1024);
    body.write('ftyp', 4, 'ascii');
    const response = await upload(projectId, body, { name: 'большой.mp4' });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ reused: false });
  });

  it('uses the (N) display-name ordinal for different bytes with the same filename', async () => {
    const projectId = await makeProject();
    const first = await upload(projectId, png('ordinal-a'), { name: 'дубль.png' });
    const second = await upload(projectId, png('ordinal-b'), { name: 'дубль.png' });
    const rows = await db
      .select({ id: galleryItems.id, title: galleryItems.title })
      .from(galleryItems)
      .where(inArray(galleryItems.id, [first.json().assetId, second.json().assetId]));
    expect(rows.map((row) => row.title).sort()).toEqual(['дубль.png', 'дубль.png (2)']);
  });

  it('rejects a bad magic signature before storage', async () => {
    const projectId = await makeProject();
    const putsBefore = storage.puts.length;
    const response = await upload(projectId, Buffer.from('not a png'));
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ error: 'invalid_media_type' });
    expect(storage.puts).toHaveLength(putsBefore);
  });

  it('checks project ownership before writing an object', async () => {
    const otherProjectId = await makeProject(otherUserId, 'Чужой');
    const putsBefore = storage.puts.length;
    const response = await upload(otherProjectId, png('not-owner'));
    expect(response.statusCode).toBe(404);
    expect(storage.puts).toHaveLength(putsBefore);
  });

  it('creates a destination folder and reuses it on an idempotent retry', async () => {
    const projectId = await makeProject();
    const body = png('folder-retry');
    const first = await upload(projectId, body, { newFolderName: 'Монтаж' });
    const second = await upload(projectId, body, { newFolderName: 'Монтаж' });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      assetId: first.json().assetId,
      destinationId: first.json().destinationId,
      reused: true,
    });
    expect(await db.select().from(folders).where(eq(folders.projectId, projectId))).toHaveLength(1);
    expect(
      await db
        .select()
        .from(assetPlacements)
        .where(eq(assetPlacements.assetId, first.json().assetId)),
    ).toHaveLength(1);
  });

  it('returns 413 above 64 MiB before storage', async () => {
    const projectId = await makeProject();
    const putsBefore = storage.puts.length;
    const body = Buffer.alloc(UPLOAD_MAX_BYTES + 1);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(body);
    const response = await upload(projectId, body);
    expect(response.statusCode).toBe(413);
    expect(storage.puts).toHaveLength(putsBefore);
  });

  it('recovers a concurrent checksum race and removes the losing object', async () => {
    const projectId = await makeProject();
    const body = png('race');
    const putsBefore = storage.puts.length;
    const removesBefore = storage.removes.length;
    storage.armPutBarrier(2);
    const responses = await Promise.all([
      upload(projectId, body, { newFolderName: 'Гонка' }),
      upload(projectId, body, { newFolderName: 'Гонка' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(new Set(responses.map((response) => response.json().assetId)).size).toBe(1);
    expect(storage.puts).toHaveLength(putsBefore + 2);
    expect(storage.removes).toHaveLength(removesBefore + 1);
    expect(storage.stored.size).toBe(storage.puts.length - storage.removes.length);
    expect(
      await db.select().from(galleryItems).where(eq(galleryItems.originProjectId, projectId)),
    ).toHaveLength(1);
    expect(await db.select().from(folders).where(eq(folders.projectId, projectId))).toHaveLength(1);
  });
});
