import { test, expect } from './fixtures';

test.setTimeout(180_000);

test('a running generation is visible in «Твои генерации»', async ({
  signedInPage: page,
}) => {
  let status = 'queued';
  await page.route(/\/v1\/jobs(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/jobs' && request.method() === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'inflight-1', status: 'queued' }),
      });
      return;
    }
    const m = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
    if (m && m[1] !== 'events' && request.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: m[1],
          status,
          resultAssets: status === 'succeeded' ? ['http://example.test/inflight-1.png'] : [],
        }),
      });
      return;
    }
    await route.continue();
  });

  // the finished asset must appear in the grid without a reload — the gallery
  // is the grid's only source, so it flips to one row once the job succeeds
  let galleryRows: unknown[] = [];
  await page.route(/\/v1\/gallery(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rows: galleryRows, nextCursor: null }),
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/generate');
  await page.getByTestId('prompt').waitFor({ state: 'visible' });
  await page.getByTestId('prompt').fill('красный шар на столе');
  await page.getByTestId('submit').click();

  // the in-flight screen, then the header way out (previously done-only)
  await expect(page.getByTestId('progress-placeholder')).toBeVisible();
  await expect(page.getByTestId('to-catalogue')).toBeVisible();
  await page.screenshot({ path: 'test-results/inflight-1-screen.png' });

  status = 'running';
  await page.waitForTimeout(2500);
  await page.getByTestId('to-catalogue').click();

  const tile = page.getByTestId('inflight-generation-tile');
  await expect(tile).toHaveCount(1);
  await expect(tile).toContainText(/Рисуем|В очереди|Отправляем/);
  await page.screenshot({ path: 'test-results/inflight-2-grid.png' });

  // clicking it puts the shot back on the stage
  await tile.click();
  await expect(page.getByTestId('progress-placeholder')).toBeVisible();

  // back to the grid, then the job finishes in the BACKGROUND: the card must be
  // replaced by the finished asset without a reload (sol's finding #2)
  await page.getByTestId('to-catalogue').click();
  await expect(tile).toHaveCount(1);
  galleryRows = [
    {
      id: 'g1',
      jobId: 'inflight-1',
      assetUrl: 'http://example.test/inflight-1.png',
      thumbnailUrl: null,
      kind: 'image',
      folder: null,
      tags: [],
      isPublic: false,
      publicSlug: null,
      expiresAt: null,
      createdAt: new Date(0).toISOString(),
    },
  ];
  status = 'succeeded';
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('seed:job-event', {
        detail: { jobId: 'inflight-1', status: 'succeeded', source: 'generation' },
      }),
    );
  });
  await expect(tile).toHaveCount(0);
  await expect(page.getByTestId('generation-tile')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/inflight-3-landed.png' });
});
