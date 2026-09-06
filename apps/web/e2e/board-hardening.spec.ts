import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';

const execFileAsync = promisify(execFile);

interface BoardDocument {
  __rev?: number;
  nodes: Array<{
    id: string;
    type: string;
    data: Record<string, unknown>;
    parentId?: string;
    width?: number;
    height?: number;
  }>;
  edges: unknown[];
  tray?: string[];
}

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  title = 'Hardening e2e',
): Promise<string> {
  const response = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  state: Record<string, unknown>,
): Promise<string> {
  const id = await newBoard(request, apiUrl, cookie);
  const response = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return id;
}

async function readBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  id: string,
): Promise<BoardDocument> {
  const response = await request.get(`${apiUrl}/v1/boards/${id}`, { headers: { cookie } });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { state: BoardDocument }).state;
}

async function releaseDatabase() {
  test.skip(process.env.BOARDS_RELEASE !== '1', 'release-only database recovery journey');
  const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for this journey');
  return databaseUrl;
}

async function poisonBoard(id: string, state: unknown) {
  const databaseUrl = await releaseDatabase();
  const encodedState = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  await execFileAsync('psql', [
    databaseUrl,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE boards SET state = convert_from(decode('${encodedState}', 'base64'), 'UTF8')::jsonb WHERE id = '${id}';`,
  ]);
}

test('organizer nodes add, edit, resize, wrap, delete, undo, and persist without ports', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const id = await seedBoard(context.request, apiUrl, cookieHeader, {
    nodes: [
      {
        id: 'prompt-under-test',
        type: 'prompt',
        position: { x: 320, y: 120 },
        data: { text: 'Кадр для группировки' },
      },
    ],
    edges: [],
  });
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('board-canvas')).toBeVisible();

  await page.getByTestId('board-add').click();
  await page.getByTestId('add-text').click();
  const textNode = page.locator('.react-flow__node-text');
  await expect(textNode).toBeVisible();
  await expect(textNode.locator('[data-handleid]')).toHaveCount(0);
  const textArea = textNode.getByRole('textbox', { name: 'Текст борда' });
  await textArea.dblclick();
  await textArea.fill('Заметка для монтажа');
  await textArea.press('Tab');
  await textNode.getByTestId('text-size-l').click();
  await expect
    .poll(async () => {
      const state = await readBoard(context.request, apiUrl, cookieHeader, id);
      return state.nodes.find((node) => node.type === 'text')?.data;
    })
    .toMatchObject({ text: 'Заметка для монтажа', size: 'l' });

  const textBeforeMove = await textNode.boundingBox();
  expect(textBeforeMove).not.toBeNull();
  await textNode.getByTestId('node-text-header').click();
  const textHeader = (await textNode.getByTestId('node-text-header').boundingBox())!;
  await page.mouse.move(textHeader.x + 24, textHeader.y + 12);
  await page.mouse.down();
  await page.mouse.move(textHeader.x + 84, textHeader.y + 42, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const box = await textNode.boundingBox();
      return box ? Math.abs(box.x - textBeforeMove!.x) : 0;
    })
    .toBeGreaterThan(30);

  await textNode.getByTestId('node-text-header').click();
  const textResize = textNode.locator('.react-flow__resize-control').last();
  await expect(textResize).toBeVisible();
  const resizeBox = (await textResize.boundingBox())!;
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 36, resizeBox.y + resizeBox.height / 2);
  await page.mouse.up();

  await page.getByTestId('node-prompt-header').click();
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-frame').click();
  const frameNode = page.locator('.react-flow__node-frame');
  await expect(frameNode).toBeVisible();
  await expect(frameNode.locator('[data-handleid]')).toHaveCount(0);
  const frameId = await frameNode.getAttribute('data-id');
  expect(frameId).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await readBoard(context.request, apiUrl, cookieHeader, id)).nodes.find(
          (node) => node.id === 'prompt-under-test',
        )?.parentId,
    )
    .toBe(frameId);

  await frameNode.getByTestId('node-frame-header').click();
  const frameTitle = frameNode.getByRole('textbox', { name: 'Название рамки' });
  await frameTitle.fill('План сцены');
  await frameTitle.press('Tab');
  await expect
    .poll(
      async () =>
        (await readBoard(context.request, apiUrl, cookieHeader, id)).nodes.find(
          (node) => node.id === frameId,
        )?.data.title,
    )
    .toBe('План сцены');

  const frameResize = frameNode.locator('.react-flow__resize-control').last();
  await expect(frameResize).toBeVisible();
  const frameResizeBox = (await frameResize.boundingBox())!;
  await page.mouse.move(
    frameResizeBox.x + frameResizeBox.width / 2,
    frameResizeBox.y + frameResizeBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    frameResizeBox.x + frameResizeBox.width / 2 + 40,
    frameResizeBox.y + frameResizeBox.height / 2 + 20,
  );
  await page.mouse.up();

  await frameNode.getByTestId('node-frame-header').getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByTestId('frame-delete-dialog')).toBeVisible();
  await page.getByTestId('frame-detach-children').click();
  await expect(frameNode).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="prompt-under-test"]')).toBeVisible();
  await page.getByTestId('rail-undo').click();
  await expect(frameNode).toBeVisible();
  await page.getByTestId('rail-redo').click();
  await expect(frameNode).toHaveCount(0);

  await expect
    .poll(
      async () =>
        (await readBoard(context.request, apiUrl, cookieHeader, id)).nodes.find(
          (node) => node.type === 'text',
        )?.data.text,
    )
    .toBe('Заметка для монтажа');
  await page.reload();
  await expect(page.locator('.react-flow__node-text')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст борда' })).toHaveValue(
    'Заметка для монтажа',
  );
});

test('corrupt board opens a server recovery path and reset creates a valid document', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  await releaseDatabase();
  const recoverableId = await seedBoard(context.request, apiUrl, cookieHeader, {
    nodes: [{ id: 'server-copy', type: 'text', position: { x: 0, y: 0 }, data: { text: 'копия' } }],
    edges: [],
  });
  await poisonBoard(recoverableId, { schemaVersion: 99 });
  await page.goto(`/boards/${recoverableId}`);
  await expect(page.getByTestId('board-recovery-shell')).toBeVisible();
  await expect(page.getByTestId('board-recovery-restore')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('board-recovery-restore').click();
  await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await readBoard(context.request, apiUrl, cookieHeader, recoverableId)).nodes[0]?.data.text,
    )
    .toBe('копия');

  const resetId = await newBoard(context.request, apiUrl, cookieHeader, 'Сброс e2e');
  await poisonBoard(resetId, { schemaVersion: 99 });
  await page.goto(`/boards/${resetId}`);
  await expect(page.getByTestId('board-recovery-shell')).toBeVisible();
  await expect(page.getByTestId('board-recovery-restore')).toHaveCount(0);
  await page.getByTestId('board-recovery-reset').click();
  await page.getByTestId('board-recovery-reset-confirm').click();
  await expect(page.getByTestId('board-canvas')).toHaveAttribute('data-node-count', '0', {
    timeout: 30_000,
  });
  await expect((await readBoard(context.request, apiUrl, cookieHeader, resetId)).nodes).toEqual([]);
});

test('history, JSON download/import, and 429 autosave backoff stay user-visible and recoverable', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const id = await seedBoard(context.request, apiUrl, cookieHeader, {
    nodes: [{ id: 'annotation', type: 'text', position: { x: 0, y: 0 }, data: { text: 'backup' } }],
    edges: [],
  });
  await page.goto(`/boards/${id}`);

  await page.getByTestId('board-history').click();
  const history = page.getByTestId('board-history-panel');
  await expect(history).toBeVisible();
  await expect(history.locator('[data-testid^="board-history-restore-"]')).toHaveCount(1);
  await history.getByTestId('board-history-snapshot').click();
  await expect(history.locator('[data-testid^="board-history-restore-"]')).toHaveCount(2);
  page.once('dialog', (dialog) => void dialog.accept());
  await history.locator('[data-testid^="board-history-restore-"]').first().click();
  await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: 30_000 });

  await page.getByTestId('board-export').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-board-json').click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const exported = JSON.parse(await readFile(downloadPath!, 'utf8')) as {
    manifest: { format: string; assetPolicy: string };
    document: Record<string, unknown>;
  };
  expect(exported.manifest).toMatchObject({
    format: 'vertov-board',
    assetPolicy: 'references-only',
  });

  await page.goto('/boards');
  await page.getByTestId('board-import-input').setInputFiles({
    name: 'board.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await page.waitForURL(/\/boards\/[^/]+$/);
  const listed = await context.request.get(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader },
  });
  const titles = ((await listed.json()) as { items: Array<{ title: string }> }).items.map(
    (item) => item.title,
  );
  expect(titles).toContain('Hardening e2e (импорт)');

  const throttledId = await seedBoard(context.request, apiUrl, cookieHeader, {
    nodes: [],
    edges: [],
  });
  await page.goto(`/boards/${throttledId}`);
  let saveAttempts = 0;
  await page.route(`${apiUrl}/v1/boards/${throttledId}`, async (route) => {
    if (route.request().method() !== 'PUT' || !route.request().postDataJSON()?.state) {
      await route.continue();
      return;
    }
    saveAttempts += 1;
    if (saveAttempts === 1) {
      await route.fulfill({
        status: 429,
        headers: { 'retry-after': '1' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 1 }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, rev: 2 }),
    });
  });
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-text').click();
  await expect(page.getByTestId('board-toast')).toContainText('замедлено', { timeout: 10_000 });
  await expect.poll(() => saveAttempts, { timeout: 10_000 }).toBe(2);
  await page.unroute(`${apiUrl}/v1/boards/${throttledId}`);
});

test('mobile organizer nodes render read-only content', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await seedBoard(context.request, apiUrl, cookieHeader, {
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
  });
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('mobile-board')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.react-flow__node-frame')).toContainText('Мобильная группа');
  await expect(page.locator('.react-flow__node-text')).toContainText('Только чтение на телефоне');
  await expect(page.locator('.react-flow__node-frame [data-handleid]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-text [data-handleid]')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-frame textarea')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-text textarea')).toHaveCount(0);
});
