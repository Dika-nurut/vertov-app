/**
 * Seeds 15 demo gallery_items owned by a dedicated "Seed Demo" system
 * user (`status='active'`, `displayName='Seed Demo'`). Each row points
 * at a static MinIO object in `seed-demo-assets/`. Idempotent: re-runs
 * upsert rather than dup.
 *
 * Two parts, deliberately separate so the DB seed has no MinIO dependency:
 *   1. THIS script (and `pnpm seed`, which calls `seedPublicGallery()`) writes
 *      the DB rows — `isPublic` + `publicSlug` + **`featuredAt`** (required by
 *      `/v1/showcase`, which filters `isNotNull(featured_at)`) + a `title`.
 *   2. `scripts/upload-demo-assets.mjs` uploads the matching PNG bytes to the
 *      `seed-demo-assets` bucket. Run it once after deploy or the tiles 404.
 *
 *   pnpm --filter @seed/db exec tsx scripts/seed-public-gallery.ts   # rows only
 *   node scripts/upload-demo-assets.mjs                              # bytes
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, galleryItems, jobs, nid, pool, usersApp, usersPii, workflows } from '../src/index';

const SYSTEM_USER_ID = 'seed-demo-system';
const ASSET_BASE = process.env.MINIO_PUBLIC_URL ?? 'http://127.0.0.1:9000';
const BUCKET = 'seed-demo-assets';

interface DemoItem {
  slug: string;
  prompt: string;
  family: 'seedream' | 'seedance';
}

const DEMO_ITEMS: DemoItem[] = [
  { slug: 'sunset-mountains', prompt: 'Закат над горами Алтая, акварель', family: 'seedream' },
  { slug: 'cyberpunk-street', prompt: 'Киберпанк улица в дожде, неон', family: 'seedream' },
  {
    slug: 'cosmonaut-balloon',
    prompt: 'Космонавт с воздушным шаром в облаках',
    family: 'seedream',
  },
  { slug: 'spb-bridge', prompt: 'Дворцовый мост на рассвете, мягкий свет', family: 'seedream' },
  { slug: 'kazan-mosque', prompt: 'Мечеть Кул-Шариф зимой, снегопад', family: 'seedream' },
  { slug: 'taiga-cabin', prompt: 'Изба в тайге, дым из трубы, ёлки', family: 'seedream' },
  { slug: 'baikal-ice', prompt: 'Лёд Байкала с пузырьками метана', family: 'seedream' },
  { slug: 'arctic-fox', prompt: 'Арктический песец на снегу, портрет', family: 'seedream' },
  { slug: 'red-square', prompt: 'Красная площадь ночью, кинематографично', family: 'seedream' },
  { slug: 'volga-fisherman', prompt: 'Рыбак на Волге в тумане, охра', family: 'seedream' },
  { slug: 'borscht-bowl', prompt: 'Тарелка борща, фуд-фотография, сверху', family: 'seedream' },
  { slug: 'matryoshka-line', prompt: 'Матрёшки в ряд, мягкий студийный свет', family: 'seedream' },
  { slug: 'kremlin-snow', prompt: 'Кремль под снегопадом, открытка', family: 'seedream' },
  { slug: 'sochi-palms', prompt: 'Пальмы Сочи на закате, тёплые тона', family: 'seedream' },
  { slug: 'kola-aurora', prompt: 'Северное сияние над Кольским полуостровом', family: 'seedream' },
];

async function ensureSystemUser(): Promise<void> {
  const existing = await db.select().from(usersApp).where(eq(usersApp.id, SYSTEM_USER_ID));
  if (existing.length > 0) return;
  await db.insert(usersApp).values({
    id: SYSTEM_USER_ID,
    displayName: 'Seed Demo',
    locale: 'ru',
    tier: 'studio',
    status: 'active',
  });
  await db.insert(usersPii).values({ id: SYSTEM_USER_ID, email: null });
}

async function upsertDemoItem(item: DemoItem, sortIdx: number): Promise<void> {
  const existing = await db
    .select()
    .from(galleryItems)
    .where(eq(galleryItems.publicSlug, item.slug));
  if (existing.length > 0) return;

  const wId = nid();
  const jId = nid();
  await db.insert(workflows).values({
    id: wId,
    userId: SYSTEM_USER_ID,
    modelId: item.family === 'seedream' ? 'seedream-5-0-pro' : 'seedance-2-0',
    params: { prompt: item.prompt, size: '1024x1024' },
    referenceAssets: [],
  });
  const assetUrl = `${ASSET_BASE}/${BUCKET}/${item.slug}.png`;
  await db.insert(jobs).values({
    id: jId,
    userId: SYSTEM_USER_ID,
    workflowId: wId,
    modelId: item.family === 'seedream' ? 'seedream-5-0-pro' : 'seedance-2-0',
    status: 'succeeded',
    creditsReserved: 15,
    idempotencyKey: `demo:${item.slug}:${sortIdx}`,
    resultAssets: [assetUrl],
  });
  // featuredAt is REQUIRED for the item to surface on /v1/showcase (the feed
  // filters isNotNull(featured_at) — curation is the anti-slop lever). Stagger
  // the timestamps by index so the ordering (desc featured_at) is stable.
  const now = Date.now();
  await db.insert(galleryItems).values({
    id: nid(),
    userId: SYSTEM_USER_ID,
    jobId: jId,
    assetUrl,
    kind: 'image',
    title: item.prompt,
    tags: ['demo'],
    isPublic: true,
    publicSlug: item.slug,
    publishedAt: new Date(),
    featuredAt: new Date(now - sortIdx * 1000),
  });
}

export async function seedPublicGallery(): Promise<number> {
  await ensureSystemUser();
  for (let i = 0; i < DEMO_ITEMS.length; i++) {
    await upsertDemoItem(DEMO_ITEMS[i]!, i);
  }
  const count = await db.select().from(galleryItems).where(eq(galleryItems.userId, SYSTEM_USER_ID));
  return count.length;
}

// Standalone runner: `tsx scripts/seed-public-gallery.ts`. When imported by the
// main seed (`pnpm seed`), this guard keeps it from closing the shared pool.
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = await seedPublicGallery();
  console.log(`seed-public-gallery: ${n} public demo items live for "${SYSTEM_USER_ID}"`);
  await pool.end();
}
