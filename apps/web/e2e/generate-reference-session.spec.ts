import { expect, test } from './fixtures';

test('image reference picker follows the selected model maxRefs', async ({
  signedInPage: page,
}) => {
  await page.goto('/generate');
  await page.getByTestId('model-select').selectOption('recraft-v4');
  await expect(page.getByText('до 1 фото', { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('до 10 фото', { exact: false })).toHaveCount(0);
});

test('an accepted one-shot edit consumes only its result frame, not a second user reference', async ({
  signedInPage: page,
}) => {
  const submissions: Array<{ params?: Record<string, unknown> }> = [];
  let galleryRows: unknown[] = [];

  await page.route('**/v1/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON() as { params?: Record<string, unknown> });
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: `reference-session-${submissions.length}`, status: 'queued' }),
    });
  });
  await page.route('**/v1/jobs/reference-session-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'reference-session-1',
        status: 'succeeded',
        modelId: 'seedream-5-0-pro',
        params: { prompt: 'source result', size: '1:1' },
        resultAssets: ['/seed-assets/result-frame.png'],
      }),
    });
  });
  await page.route('**/v1/gallery**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ rows: galleryRows, nextCursor: null }),
    });
  });
  await page.route('**/v1/studio/upload?ext=png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: '/seed-assets/deliberate-reference.png' }),
    });
  });

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('source result');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('action-edit')).toBeVisible({ timeout: 10_000 });

  await page.getByTestId('action-edit').click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'deliberate-reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from('reference'),
  });
  // Both references are now attached AND removable: the one-shot result frame
  // «Редактировать» pinned, plus the one the user uploaded deliberately.
  await expect(page.getByRole('button', { name: 'Убрать' })).toHaveCount(2);

  await page.getByTestId('submit').click();
  await expect.poll(() => submissions.length).toBe(2);
  expect(submissions[1]?.params?.['imageUrls']).toEqual([
    '/seed-assets/result-frame.png',
    '/seed-assets/deliberate-reference.png',
  ]);

  await page.getByTestId('submit').click();
  await expect.poll(() => submissions.length).toBe(3);
  expect(submissions[2]?.params?.['imageUrls']).toEqual(['/seed-assets/deliberate-reference.png']);
});

test('a repeat rejected with tier_required leaves Generate in an error state', async ({
  signedInPage: page,
}) => {
  let postCount = 0;
  await page.route('**/v1/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    postCount += 1;
    await route.fulfill(
      postCount === 1
        ? {
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ jobId: 'repeat-tier', status: 'queued' }),
          }
        : {
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'tier_required' }),
          },
    );
  });
  await page.route('**/v1/jobs/repeat-tier', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'repeat-tier',
        status: 'succeeded',
        modelId: 'seedream-5-0-pro',
        params: {
          prompt: 'repeatable prompt',
          size: '1:1',
          imageUrls: ['/seed-assets/repeat-reference.png'],
        },
        resultAssets: ['/seed-assets/repeat-tier.png'],
      }),
    });
  });
  await page.route('**/seed-assets/repeat-reference.png', (route) => {
    if (route.request().method() === 'HEAD') return route.fulfill({ status: 405 });
    return route.continue();
  });
  await page.route('**/v1/gallery**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ rows: [], nextCursor: null }),
    }),
  );

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('repeatable prompt');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('action-repeat')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('action-repeat').click();
  await expect(page.getByTestId('error-state')).toContainText(
    'Эта модель недоступна в текущем тарифе.',
  );
  // A valid asset may reject HEAD. That is inconclusive, so Repeat still reaches
  // the API rather than falsely asking the user to replace it.
  expect(postCount).toBe(2);
});

test('opening a history tile replays its receipt rather than composer metadata', async ({
  signedInPage: page,
}) => {
  let receiptRequests = 0;
  await page.route('**/v1/gallery**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'history-tile',
            jobId: 'history-receipt',
            assetUrl: '/seed-assets/history.png',
            thumbnailUrl: null,
            kind: 'image',
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.route('**/v1/jobs/history-receipt', async (route) => {
    receiptRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'history-receipt',
        status: 'succeeded',
        modelId: 'seedream-5-0-pro',
        params: { prompt: 'prompt stored with the history job', size: '3:2' },
        resultAssets: ['/seed-assets/history.png'],
      }),
    });
  });

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('new composer draft must not be shown');
  await page.getByTestId('generation-tile').click();
  await expect(page.getByTestId('result-prompt')).toHaveText('prompt stored with the history job');
  expect(receiptRequests).toBe(1);
});

test('paired video receipts keep their frame and reference labels', async ({
  signedInPage: page,
}) => {
  await page.route('**/v1/gallery**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'paired-frames',
            jobId: 'paired-frames-job',
            assetUrl: '/seed-assets/paired-frames.mp4',
            kind: 'video',
          },
          {
            id: 'paired-references',
            jobId: 'paired-references-job',
            assetUrl: '/seed-assets/paired-references.mp4',
            kind: 'video',
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  for (const [jobId, modelId] of [
    ['paired-frames-job', 'seedance-2-0-fast'],
    ['paired-references-job', 'seedance-2-0-fast-reference-to-video'],
  ]) {
    await page.route(`**/v1/jobs/${jobId}`, (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          id: jobId,
          status: 'succeeded',
          modelId,
          params: { duration_seconds: 5, resolution: '720p' },
          resultAssets: [`/seed-assets/${jobId}.mp4`],
        }),
      }),
    );
  }

  await page.goto('/generate');
  await page.getByTestId('generation-tile').nth(0).click();
  await expect(page.getByTestId('result-area')).toContainText('Seedance 2.0 Fast · кадры');
  await page.getByRole('button', { name: 'Создать ещё' }).click();
  await page.getByTestId('generation-tile').nth(1).click();
  await expect(page.getByTestId('result-area')).toContainText('Seedance 2.0 Fast · референсы');
});

test('a legacy receipt shows its saved image quality', async ({ signedInPage: page }) => {
  await page.route('**/v1/gallery**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'legacy-tile',
            jobId: 'legacy-receipt',
            assetUrl: '/seed-assets/legacy.png',
            thumbnailUrl: null,
            kind: 'image',
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.route('**/v1/jobs/legacy-receipt', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'legacy-receipt',
        status: 'succeeded',
        modelId: 'legacy-image',
        model: { family: 'Legacy', variant: 'Image', displayName: null, kind: 'image' },
        params: { prompt: 'saved legacy prompt', quality: '4K' },
        resultAssets: ['/seed-assets/legacy.png'],
      }),
    }),
  );

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('new composer draft must not be shown');
  await page.getByTestId('generation-tile').click();

  await expect(page.getByTestId('result-area')).toContainText('4K');
  await expect(page.getByTestId('result-prompt')).toHaveText('saved legacy prompt');
});

test('a gallery asset without a source job says its recipe is unavailable', async ({
  signedInPage: page,
}) => {
  await page.route('**/v1/gallery**', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'studio-render',
            jobId: null,
            assetUrl: '/seed-assets/studio-render.mp4',
            thumbnailUrl: null,
            kind: 'video',
          },
        ],
        nextCursor: null,
      }),
    }),
  );

  await page.goto('/generate');
  await page.getByTestId('generation-tile').click();

  await expect(page.getByTestId('result-unavailable')).toContainText('Рецепт не сохранён');
  await expect(page.getByTestId('result-unavailable')).toContainText('нет исходной генерации');
});

test('reload restores a persisted Generate job while ignoring an active foreign row', async ({
  signedInPage: page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      'vertov:generate-owned-jobs',
      JSON.stringify([{ id: 'owned-running', submittedAt: Date.now() }]),
    );
  });
  await page.route('**/v1/jobs?**', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'owned-running',
            status: 'running',
            modelId: 'seedream-5-0-pro',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'boards-running',
            status: 'queued',
            modelId: 'seedream-5-0-pro',
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    });
  });
  await page.route('**/v1/jobs/owned-running', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'running' }) }),
  );

  await page.goto('/generate');
  await expect(page.getByTestId('inflight-generation-tile')).toHaveCount(1);
  await expect(page.getByTestId('inflight-generation-tile')).toContainText('Seedream 4.5');
});
