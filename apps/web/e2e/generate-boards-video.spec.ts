import { expect, test } from './fixtures';

/**
 * Owner report: a clip generated in /boards would not PLAY when opened from
 * the generations library on /generate. Reproduces the realistic shape — a
 * video gallery row whose job carries a poster still alongside the clip.
 */
test('a boards-made clip opened from the library plays as video', async ({
  signedInPage: page,
}) => {
  await page.route('**/v1/gallery**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'g-board-1',
            jobId: 'board-job-1',
            kind: 'video',
            assetUrl: '/seed-assets/clip.mp4',
            thumbnailUrl: '/seed-assets/poster.png',
            title: 'снято на борде',
            createdAt: new Date(0).toISOString(),
          },
        ],
        nextCursor: null,
      }),
    });
  });
  await page.route('**/v1/jobs/board-job-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'board-job-1',
        status: 'succeeded',
        kind: 'video',
        modelId: 'seedance-2-0-fast',
        params: { prompt: 'снято на борде', aspect_ratio: '16:9', duration_seconds: 5 },
        resultAssets: ['/seed-assets/poster.png', '/seed-assets/clip.mp4'],
      }),
    });
  });

  await page.goto('/generate');
  const tile = page.getByTestId('generation-tile').first();
  await tile.waitFor({ state: 'visible', timeout: 20_000 });
  await tile.click();

  const video = page.locator('[data-testid="result-area"] video');
  await expect(video).toBeVisible({ timeout: 10_000 });
  await expect(video).toHaveAttribute('src', /clip\.mp4/);
  await expect(page.getByTestId('result-area')).toContainText('5s · 16:9');
});
