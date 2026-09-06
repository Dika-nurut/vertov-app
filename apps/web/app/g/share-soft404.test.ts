import { afterEach, describe, expect, it, vi } from 'vitest';

// Soft-404 guard for public shares (/g/[slug]): an unknown slug must surface
// as a real 404 (Next notFound()) and carry an explicit noindex, while a
// known slug stays fully indexable (public shares are meant to be crawled).
vi.mock('next/navigation', () => ({
  notFound: (): never => {
    const err = new Error('NEXT_HTTP_ERROR_FALLBACK;404') as Error & { digest: string };
    err.digest = 'NEXT_HTTP_ERROR_FALLBACK;404';
    throw err;
  },
}));

// @/lib/server-api pulls in next/headers (cookies/headers), which only exists
// inside a real Next request scope — stub the one helper the page uses.
vi.mock('@/lib/server-api', () => ({
  apiBaseUrl: () => 'http://localhost:4000',
}));

import PublicGalleryPage, { generateMetadata } from './[slug]/page';
import { metadata as notFoundMetadata } from '../not-found';

const UNKNOWN_SLUG = 'doesnotexist12345';

function mockApi(item: unknown | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      item
        ? { ok: true, status: 200, json: async () => item }
        : { ok: false, status: 404, json: async () => ({ error: 'not_found' }) },
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/g/[slug] unknown-slug handling (soft-404 guard)', () => {
  it('page calls notFound() for an unknown slug (real 404 status)', async () => {
    mockApi(null);
    const err = await PublicGalleryPage({
      params: Promise.resolve({ slug: UNKNOWN_SLUG }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { digest?: string }).digest).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
  });

  it('generateMetadata marks an unknown slug noindex', async () => {
    mockApi(null);
    const meta = await generateMetadata({ params: Promise.resolve({ slug: UNKNOWN_SLUG }) });
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });

  it('the rendered not-found variant is noindex', () => {
    expect(notFoundMetadata.robots).toMatchObject({ index: false, follow: false });
  });

  it('generateMetadata keeps a known slug indexable', async () => {
    mockApi({
      id: 'item-1',
      jobId: 'job-1',
      assetUrl: 'http://127.0.0.1:9000/seed-assets/x.png',
      kind: 'image',
      modelId: 'seedream-4-5',
      modelFamily: 'seedream',
      modelVariant: '4-5',
      modelDisplayName: null,
      prompt: 'Лиса в осеннем лесу',
      presetSlug: null,
      createdAt: new Date().toISOString(),
      displayName: 'Аноним',
    });
    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'AbC123XyZ456' }) });
    expect(meta.title).toContain('Лиса');
    // No robots:index:false — public shares must stay crawlable.
    expect(JSON.stringify(meta.robots ?? null)).not.toContain('"index":false');
  });
});
