import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * B-10: representative phone-viewport checks matching docs/product/device-support.md
 * — /generate is full on a phone; /boards and /studio are review/view tiers.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function seedMobileBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Mobile handoff' },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const seeded = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: {
      rev: 0,
      state: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mobile-video',
            type: 'generate',
            position: { x: 80, y: 100 },
            data: {
              mode: 'video',
              modelId: 'seedance-2-0-fast',
              prompt: 'готовый мобильный кадр',
              status: 'done',
              resultUrl: 'http://example.test/mobile-board.mp4',
              resultKind: 'video',
            },
          },
        ],
        edges: [],
        tray: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  });
  expect(seeded.ok()).toBe(true);
  return id;
}

async function seedRunnableMobileBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Mobile prepared run' },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const seeded = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: {
      rev: 0,
      state: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mobile-ready',
            type: 'generate',
            position: { x: 80, y: 100 },
            data: {
              mode: 'image',
              modelId: 'seedream-5-0-pro',
              prompt: 'подготовленный мобильный кадр',
              imageAspect: '1:1',
              imageQuality: '2K',
              count: 1,
              status: 'idle',
            },
          },
        ],
        edges: [],
        tray: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  });
  expect(seeded.ok()).toBe(true);
  return id;
}

async function seedOrganizerMobileBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Mobile organizers' },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const seeded = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: {
      rev: 0,
      state: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'mobile-frame',
            type: 'frame',
            position: { x: 80, y: 70 },
            width: 520,
            height: 320,
            data: { title: 'Мобильная группа', tint: 'blue' },
          },
          {
            id: 'mobile-text',
            type: 'text',
            position: { x: 24, y: 28 },
            parentId: 'mobile-frame',
            extent: 'parent',
            data: { text: 'Только чтение на телефоне', size: 'l' },
          },
        ],
        edges: [],
        tray: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    },
  });
  expect(seeded.ok()).toBe(true);
  return id;
}

test('mobile /generate: critical controls fit the phone viewport', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;
  await page.goto('/generate');

  await expect(page.getByTestId('prompt')).toBeVisible();
  const submit = page.getByTestId('submit');
  await expect(submit).toBeVisible();

  // The critical control must not overflow the phone width.
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(391);
});

test('mobile /boards: the projects surface is reviewable on a phone', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;
  await page.goto('/boards');
  await expect(page.getByTestId('board-create')).toBeVisible({ timeout: 30_000 });
});

test('mobile Board confirms and launches one prepared shot without graph editing', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(60_000);
  const id = await seedRunnableMobileBoard(context.request, apiUrl, cookieHeader);
  let submitted: Record<string, unknown> | null = null;
  await page.route(`${apiUrl}/v1/jobs`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'mobile-job-1' }),
    });
  });

  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('mobile-board')).toBeVisible({ timeout: 30_000 });
  await page.locator('.react-flow__node[data-id="mobile-ready"]').click();
  await expect(page.getByTestId('mobile-board-run')).toHaveText(/Запустить/);
  await page.getByTestId('mobile-board-run').click();
  await expect(page.getByTestId('mobile-run-confirm')).toContainText(/seedream.*кр\./i);
  await page.getByTestId('mobile-run-submit').click();

  await expect(page.getByTestId('mobile-board-notice')).toContainText('Кадр запущен');
  expect(submitted).toMatchObject({
    source: 'boards',
    modelId: 'seedream-5-0-pro',
    prompt: 'подготовленный мобильный кадр',
    provider: 'openrouter',
    params: { aspect_ratio: '1:1', resolution: '2K', n: 1 },
    idempotencyKey: expect.any(String),
  });

  const saved = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader },
  });
  expect(saved.ok()).toBe(true);
  const body = (await saved.json()) as {
    state: { nodes: { id: string; data: Record<string, unknown> }[] };
  };
  expect(body.state.nodes.find((node) => node.id === 'mobile-ready')?.data).toMatchObject({
    status: 'running',
    jobId: 'mobile-job-1',
  });
});

test('mobile Board hands completed video to Studio', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(60_000);
  const id = await seedMobileBoard(context.request, apiUrl, cookieHeader);
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('mobile-board')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('mobile-board-studio')).toBeEnabled();
  await page.getByTestId('mobile-board-studio').click();

  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.getByTestId('source-clip')).toHaveCount(1, { timeout: 30_000 });
});

test('mobile Board renders organizer nodes as read-only content', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(60_000);
  const id = await seedOrganizerMobileBoard(context.request, apiUrl, cookieHeader);
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('mobile-board')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.react-flow__node-frame')).toContainText('Мобильная группа');
  await expect(page.locator('.react-flow__node-text')).toContainText('Только чтение на телефоне');
  await expect(page.locator('.react-flow__node-frame [data-handleid]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-text [data-handleid]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-frame textarea')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-text textarea')).toHaveCount(0);
});

test('mobile /studio: the editor is viewable on a phone', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;
  await page.goto('/studio');
  await expect(page.getByTestId('export-btn')).toBeVisible({ timeout: 30_000 });
});
