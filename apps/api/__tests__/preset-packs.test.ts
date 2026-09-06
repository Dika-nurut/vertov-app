import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, models, nid, pool, presetPacks } from '@seed/db';
import { setupPresetPacksRoutes } from '../src/preset-packs';

/**
 * Preset packs API tests — W4.Mon.
 * The seed already ran 24 rows (12 slugs × 2 locales) against the live
 * test DB; these tests query through the Fastify route layer to verify
 * the endpoint contract.
 */

let app: ReturnType<typeof Fastify>;

// Track any rows we insert in tests so we can clean them up.
const insertedIds: string[] = [];

beforeAll(async () => {
  app = Fastify({ logger: false });
  setupPresetPacksRoutes(app);
  await app.ready();
});

afterAll(async () => {
  // Remove any test rows we inserted.
  for (const id of insertedIds) {
    await db.delete(presetPacks).where(eq(presetPacks.id, id));
  }
  await app.close();
  await pool.end();
});

describe('GET /v1/preset-packs', () => {
  it('returns at least 12 rows for locale=ru (seed presence)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=ru' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[] }>();
    expect(body.items.length).toBeGreaterThanOrEqual(12);
  });

  it('a seeded preview dimension pair round-trips through the API', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/preset-packs/demo-veo-3-1-lite-jumbotron?lang=ru',
    });
    expect(res.statusCode).toBe(200);
    const pack = res.json<{ previewWidth: number | null; previewHeight: number | null }>();
    expect(pack.previewWidth).toBe(1400);
    expect(pack.previewHeight).toBe(788);
  });

  it('projects the current catalogue label into list and detail responses', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=ru' });
    expect(list.statusCode).toBe(200);
    const pack = list.json<{ items: { slug: string; modelId: string; model: unknown }[] }>()
      .items[0]!;
    const [catalogueModel] = await db
      .select({
        family: models.family,
        variant: models.variant,
        displayName: models.displayName,
      })
      .from(models)
      .where(eq(models.id, pack.modelId))
      .limit(1);
    expect(catalogueModel).toBeTruthy();
    expect(pack.model).toEqual(catalogueModel);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/preset-packs/${pack.slug}?lang=ru`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ model: unknown }>().model).toEqual(catalogueModel);
  });

  it('locale filter — ru and en return different titles for same slug', async () => {
    const resRu = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=ru' });
    const resEn = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=en' });
    expect(resRu.statusCode).toBe(200);
    expect(resEn.statusCode).toBe(200);

    const ruItems = resRu.json<{ items: { slug: string; locale: string; title: string }[] }>()
      .items;
    const enItems = resEn.json<{ items: { slug: string; locale: string; title: string }[] }>()
      .items;

    // Every item in the RU response has locale='ru'.
    expect(ruItems.every((i) => i.locale === 'ru')).toBe(true);
    // Every item in the EN response has locale='en'.
    expect(enItems.every((i) => i.locale === 'en')).toBe(true);

    // The same slug exists in both but with a different title.
    const firstSlug = ruItems[0]!.slug;
    const ruTitle = ruItems.find((i) => i.slug === firstSlug)!.title;
    const enTitle = enItems.find((i) => i.slug === firstSlug)!.title;
    expect(ruTitle).not.toBe(enTitle);
  });

  it('only-active filter — inactive rows are excluded', async () => {
    // Insert an inactive pack for this test.
    const slug = `test-inactive-${nid()}`;
    const id = `pp-${slug}-ru`;
    insertedIds.push(id);
    await db.insert(presetPacks).values({
      id,
      slug,
      title: 'Inactive Pack',
      description: 'should not appear',
      modelId: 'seedream-4-5',
      promptTemplate: 'test',
      paramsJson: {},
      samplePreviewUrl: '',
      sortOrder: 9999,
      isActive: false,
      locale: 'ru',
    });

    const res = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=ru' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: { slug: string }[] }>();
    const found = body.items.find((i) => i.slug === slug);
    expect(found).toBeUndefined();
  });

  it('ordering by sortOrder — items arrive in ascending sortOrder', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/preset-packs?lang=ru' });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { sortOrder: number }[] }>().items;
    for (let i = 1; i < items.length; i++) {
      expect(items[i]!.sortOrder).toBeGreaterThanOrEqual(items[i - 1]!.sortOrder);
    }
  });

  it('defaults to lang=ru when lang param is absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/preset-packs' });
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { locale: string }[] }>().items;
    expect(items.every((i) => i.locale === 'ru')).toBe(true);
  });

  it('a default preset (no series/reference fields given) reports seriesCount=1 and no references', async () => {
    const slug = `test-default-${nid()}`;
    const id = `pp-${slug}-ru`;
    insertedIds.push(id);
    await db.insert(presetPacks).values({
      id,
      slug,
      title: 'Default Pack',
      description: 'plain preset, unchanged by this migration',
      modelId: 'seedream-4-5',
      promptTemplate: 'test',
      paramsJson: {},
      samplePreviewUrl: '',
      sortOrder: 9999,
      isActive: true,
      locale: 'ru',
    });

    const res = await app.inject({ method: 'GET', url: `/v1/preset-packs/${slug}?lang=ru` });
    expect(res.statusCode).toBe(200);
    const pack = res.json<{ seriesCount: number; referenceAssetUrls: string[] }>();
    expect(pack.seriesCount).toBe(1);
    expect(pack.referenceAssetUrls).toEqual([]);
  });

  it('a pack without preview dimensions returns null for both dimensions', async () => {
    const slug = `test-no-preview-dimensions-${nid()}`;
    const id = `pp-${slug}-ru`;
    insertedIds.push(id);
    await db.insert(presetPacks).values({
      id,
      slug,
      title: 'Dimensionless Pack',
      description: 'older catalog row without measured preview dimensions',
      modelId: 'seedream-4-5',
      promptTemplate: 'test',
      paramsJson: {},
      samplePreviewUrl: '',
      sortOrder: 9999,
      isActive: true,
      locale: 'ru',
    });

    const res = await app.inject({ method: 'GET', url: `/v1/preset-packs/${slug}?lang=ru` });
    expect(res.statusCode).toBe(200);
    const pack = res.json<{ previewWidth: number | null; previewHeight: number | null }>();
    expect(pack.previewWidth).toBeNull();
    expect(pack.previewHeight).toBeNull();
  });

  it('a series/reference pack round-trips seriesCount and referenceAssetUrls through the API', async () => {
    const slug = `test-series-${nid()}`;
    const id = `pp-${slug}-ru`;
    insertedIds.push(id);
    await db.insert(presetPacks).values({
      id,
      slug,
      title: 'Series Pack',
      description: 'photoshoot preset with bundled references',
      modelId: 'seedream-4-5',
      promptTemplate: 'test',
      paramsJson: {},
      samplePreviewUrl: '',
      sortOrder: 9999,
      isActive: true,
      locale: 'ru',
      seriesCount: 4,
      referenceAssetUrls: ['https://example.test/ref-1.png', 'https://example.test/ref-2.png'],
    });

    const res = await app.inject({ method: 'GET', url: `/v1/preset-packs/${slug}?lang=ru` });
    expect(res.statusCode).toBe(200);
    const pack = res.json<{ seriesCount: number; referenceAssetUrls: string[] }>();
    expect(pack.seriesCount).toBe(4);
    expect(pack.referenceAssetUrls).toEqual([
      'https://example.test/ref-1.png',
      'https://example.test/ref-2.png',
    ]);
  });
});
