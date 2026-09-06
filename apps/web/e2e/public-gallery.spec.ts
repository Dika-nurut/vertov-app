import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

// The floor signs in a normal user, so it must use an active free-tier model.
// Credits alone do not bypass the server-side subscription tier gate.
const PUBLIC_FLOOR_MODEL = 'gemini-3-1-flash-lite-image';

async function grantCredits(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  amount: number,
) {
  const res = await request.post(`${apiUrl}/v1/dev/grant-credits`, {
    data: { amount },
    headers: { cookie: cookieHeader },
  });
  expect(res.ok()).toBeTruthy();
}

test('publish an item, then access it unauthenticated', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;

  // Generate one item via the real API so a gallery_items row materialises.
  await grantCredits(context.request, apiUrl, cookieHeader, 50);
  const createRes = await context.request.post(`${apiUrl}/v1/jobs`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      modelId: PUBLIC_FLOOR_MODEL,
      prompt: 'Лиса в осеннем лесу, акварель',
      params: { size: '1024x1024', n: 1 },
      idempotencyKey: `public-${Date.now()}`,
    },
  });
  expect(createRes.ok()).toBeTruthy();
  const { jobId } = (await createRes.json()) as { jobId: string };

  // Wait for the job to succeed (worker writes the gallery_items row).
  for (let i = 0; i < 40; i++) {
    const r = await context.request.get(`${apiUrl}/v1/jobs/${jobId}`, {
      headers: { cookie: cookieHeader },
    });
    const b = (await r.json()) as { status: string; galleryItem?: { id: string } | null };
    if (b.status === 'succeeded' && b.galleryItem) {
      break;
    }
    if (b.status === 'failed') throw new Error('job failed');
    await new Promise((r) => setTimeout(r, 750));
  }
  const detail = await context.request.get(`${apiUrl}/v1/jobs/${jobId}`, {
    headers: { cookie: cookieHeader },
  });
  const detailBody = (await detail.json()) as {
    galleryItem: { id: string; isPublic: boolean; publicSlug: string | null };
  };
  expect(detailBody.galleryItem).toBeTruthy();

  // Publish through the UI.
  await page.goto(`/gallery/${jobId}`);
  await expect(page.getByTestId('publish-button')).toBeVisible();
  await page.getByTestId('publish-button').click();
  await expect(page.getByTestId('public-url')).toBeVisible({ timeout: 10_000 });
  const publicUrlText = await page.getByTestId('public-url').textContent();
  const slugMatch = publicUrlText!.match(/\/g\/([A-Za-z0-9]{12})/);
  expect(slugMatch).toBeTruthy();
  const slug = slugMatch![1]!;

  // Clear auth and hit /g/[slug] as an anonymous visitor.
  await context.clearCookies();
  const publicResp = await page.goto(`/g/${slug}`);
  expect(publicResp?.status()).toBe(200);
  await expect(page.getByTestId('public-hero')).toBeVisible();
  await expect(page.getByTestId('public-prompt')).toHaveText(/Лиса/);
  // Author defaults to 'Аноним' when displayName is null (e2e magic-link
  // users have no display name set). Assert the element exists with any text.
  await expect(page.getByTestId('public-author')).toHaveText(/.+/);

  // OG meta in the HTML.
  const html = await page.content();
  expect(html).toContain('og:image');
});
