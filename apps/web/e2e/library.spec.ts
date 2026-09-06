import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

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

async function createJob(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  idempotencyKey: string,
  prompt: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/jobs`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      modelId: 'seedream-5-0-pro',
      prompt,
      params: { size: '1024x1024', n: 1 },
      idempotencyKey,
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.jobId as string;
}

async function waitForSucceeded(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  jobId: string,
) {
  for (let i = 0; i < 40; i++) {
    const r = await request.get(`${apiUrl}/v1/jobs/${jobId}`, {
      headers: { cookie: cookieHeader },
    });
    const b = await r.json();
    if (b.status === 'succeeded') return;
    if (b.status === 'failed') throw new Error(`job ${jobId} failed: ${b.errorMessage}`);
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`job ${jobId} did not succeed in time`);
}

test('library: move two items into a folder, filter, bulk-download ZIP', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;

  await grantCredits(context.request, apiUrl, cookieHeader, 100);
  const ids = [
    await createJob(context.request, apiUrl, cookieHeader, `lib-${Date.now()}-1`, 'Эксперимент 1'),
    await createJob(context.request, apiUrl, cookieHeader, `lib-${Date.now()}-2`, 'Эксперимент 2'),
  ];
  for (const id of ids) await waitForSucceeded(context.request, apiUrl, cookieHeader, id);

  await page.goto('/gallery');
  await expect(page.getByTestId('folder-sidebar')).toBeVisible();
  const items = page.getByTestId('gallery-item');
  await expect(items).toHaveCount(2, { timeout: 15_000 });

  // Free banner is visible on a new free-tier user.
  await expect(page.getByTestId('free-expiry-banner')).toBeVisible();

  // Select both items
  await page.locator('[data-testid="gallery-item"]').nth(0).getByTestId('select-checkbox').check();
  await page.locator('[data-testid="gallery-item"]').nth(1).getByTestId('select-checkbox').check();
  await expect(page.getByTestId('action-bar')).toBeVisible();

  // Move into "Эксперименты"
  await page.getByTestId('move-trigger').click();
  await page.getByTestId('move-folder-input').fill('Эксперименты');
  await page.getByTestId('move-apply').click();

  // Wait for refresh + folder appearing in sidebar
  await expect
    .poll(async () => (await page.locator('[data-folder="Эксперименты"]').count()) > 0, {
      timeout: 10_000,
    })
    .toBe(true);

  // Filter by that folder
  await page.locator('[data-folder="Эксперименты"]').first().click();
  await page.waitForURL(/folder=/);
  await expect(page.getByTestId('gallery-item')).toHaveCount(2, { timeout: 10_000 });

  // Re-select all and bulk-download
  const newItems = page.locator('[data-testid="gallery-item"]');
  await newItems.nth(0).getByTestId('select-checkbox').check();
  await newItems.nth(1).getByTestId('select-checkbox').check();
  // Use direct API call (download interception is finicky in headless),
  // assert 200 + application/zip + non-empty body.
  const itemIds = await newItems.evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset['itemId']!),
  );
  const zipRes = await page.request.post(`${apiUrl}/v1/gallery/bulk-download`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { itemIds },
  });
  expect(zipRes.status()).toBe(200);
  expect(zipRes.headers()['content-type']).toBe('application/zip');
  const buf = await zipRes.body();
  expect(buf.byteLength).toBeGreaterThan(50);
});

test('library: free banner shown for free tier (default)', async ({ signedInPage }) => {
  // Inverse-path coverage (banner hidden for tier='start'+) lives in
  // apps/api/__tests__/gallery-folders.test.ts: "expires_at stays NULL
  // on paid tiers" proves the tier branch. Flipping a user to a paid
  // tier from Playwright would require a dev-only tier-setter endpoint
  // we don't ship — out of W3.Wed scope.
  await signedInPage.goto('/gallery');
  await expect(signedInPage.getByTestId('free-expiry-banner')).toBeVisible();
});
