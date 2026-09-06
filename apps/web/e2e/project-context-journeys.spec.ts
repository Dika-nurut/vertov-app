import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The board editor covers its viewport with an `aria-busy` status until the
 * lazily-loaded canvas is mounted, so its nodes do not exist yet. Wait for that
 * state to clear before asserting graph content — the board is genuinely not
 * interactive until then, and on a cold dev server the first hit also compiles
 * the route.
 */
async function boardSurfaceReady(page: Page) {
  await expect(page.getByTestId('board-surface-loading')).toHaveCount(0, { timeout: 60_000 });
}

const screenplay =
  'ИНТ. МАСТЕРСКАЯ - ДЕНЬ\n= Героиня включает проектор.\n\nНа стене появляется первый кадр.\n';

interface GalleryRow {
  id: string;
  assetUrl: string;
  kind: 'image' | 'video';
}

interface BoardDocument {
  __rev: number;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  tray: string[];
}

test('full project-context journey returns every real source and output to Среда', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(360_000);
  const projectTitle = `Полный цикл ${Date.now()}`;

  // Enter through the real global navigation, then create and open the project.
  await page.getByRole('link', { name: 'Среда', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Создать первый проект' }).click();
  const projectDialog = page.getByRole('dialog');
  await projectDialog.getByLabel('Название проекта').fill(projectTitle);
  await projectDialog.getByRole('button', { name: 'Создать', exact: true }).click();
  const projectButton = page.locator('[data-testid^="workspace-project-"]').filter({
    hasText: projectTitle,
  });
  await expect(projectButton).toBeVisible();
  const projectTestId = await projectButton.getAttribute('data-testid');
  const projectId = projectTestId!.replace('workspace-project-', '');
  await projectButton.click();
  await expect(projectButton).toHaveAttribute('aria-pressed', 'true');
  await projectButton.dblclick();
  await expect(page.getByTestId('workspace-desk')).toBeVisible({ timeout: 90_000 });

  // Create the Scenario from the project dock. The dock is navigation only:
  // opening it must not create a ghost script row.
  await page.getByTestId('dock-scenario').click();
  await expect(page).toHaveURL(new RegExp(`/scenario/new\\?projectId=${projectId}`));
  await expect(page.getByTestId('scenario-new-page')).toBeVisible();
  const beforeIntent = await context.request.get(
    `${apiUrl}/v1/scripts?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  expect((await beforeIntent.json()).items).toEqual([]);
  await page.getByTestId('scenario-direct-start').click();
  await page.getByTestId('scenario-intent').fill(screenplay);
  await page.getByTestId('scenario-structurize').click();
  await expect(page).toHaveURL(new RegExp(`/scenario/[^/?]+\\?projectId=${projectId}`));
  const scriptId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('scenario-canvas')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/scripts/${scriptId}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as { fountain?: string };
      return body.fountain;
    })
    .toBe(screenplay);

  // Scenario → Board is the production handoff, not a route mock.
  await page.getByTestId('scenario-board-open').click();
  await page.getByTestId('scenario-board-submit').click();
  await expect(page.getByTestId('scenario-board-receipt')).toBeVisible();
  await page.getByTestId('scenario-board-open-result').click();
  await expect(page).toHaveURL(new RegExp(`/boards/[^/?]+\\?projectId=${projectId}`), {
    timeout: 30_000,
  });
  const boardId = new URL(page.url()).pathname.split('/').pop()!;
  await boardSurfaceReady(page);
  await expect(page.getByText('Сценарий · сцена 1', { exact: true })).toBeVisible();

  // Generate one project image through the repository's zero-spend provider.
  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    headers: { cookie: cookieHeader },
    data: { amount: 1_000 },
  });
  expect(grant.ok()).toBe(true);
  await page.getByTestId('desk-return').click();
  await page.getByTestId('dock-generate').click();
  await expect(page.getByTestId('project-context-valid')).toContainText(projectTitle, {
    timeout: 30_000,
  });
  await page.getByTestId('prompt').fill('Детерминированный луч проектора в мастерской');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('result-image')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('generate-project-receipt')).toContainText(projectTitle);

  const scopedGallery = await context.request.get(
    `${apiUrl}/v1/gallery?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  expect(scopedGallery.status()).toBe(200);
  const generatedAsset = ((await scopedGallery.json()) as { rows: GalleryRow[] }).rows.find(
    (row) => row.kind === 'image',
  );
  expect(generatedAsset, 'the generated project image should be a real gallery asset').toBeTruthy();

  // Reopen the project desk and use that exact project asset in it. The Generate
  // receipt links directly to the project's Среда desk now that private gallery
  // pages have been removed.
  await page.getByTestId('generate-project-receipt').getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${projectId}$`));
  const deskBoard = page.locator('[data-testid^="desk-item-board-"]').first();
  await expect(deskBoard).toBeVisible({ timeout: 30_000 });
  await expect(deskBoard).toHaveAttribute('data-testid', `desk-item-board-${boardId}`);
  await deskBoard.dblclick();
  await boardSurfaceReady(page);
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-media').click();
  await page.getByTestId(`project-media-${generatedAsset!.id}`).click();
  await expect(page.locator('.react-flow__node-media')).toHaveCount(1);
  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as { state: BoardDocument };
      return body.state.nodes.some(
        (node) =>
          node['type'] === 'media' &&
          (node['data'] as Record<string, unknown> | undefined)?.['assetId'] === generatedAsset!.id,
      );
    })
    .toBe(true);

  // Add the repository's deterministic local video fixture as another real
  // project asset, then put it in the montage tray. The subsequent Board →
  // Studio handoff and render remain the real production APIs.
  const fixtureUpload = await context.request.post(
    `${apiUrl}/v1/projects/${projectId}/assets?name=project-context-fixture.webm`,
    {
      headers: { cookie: cookieHeader, 'content-type': 'application/octet-stream' },
      data: await readFile(resolve(__dirname, '../public/_dev/studio-fix.webm')),
    },
  );
  expect(fixtureUpload.status()).toBe(201);
  const fixtureAssetId = ((await fixtureUpload.json()) as { assetId: string }).assetId;
  const fixtureGallery = await context.request.get(
    `${apiUrl}/v1/gallery?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  const fixtureAsset = ((await fixtureGallery.json()) as { rows: GalleryRow[] }).rows.find(
    (row) => row.id === fixtureAssetId,
  );
  expect(fixtureAsset?.kind).toBe('video');

  const boardResponse = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader },
  });
  const board = (await boardResponse.json()) as { state: BoardDocument };
  const trayNodeId = 'journey-generated-video';
  const update = await context.request.put(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      rev: board.state.__rev,
      state: {
        ...board.state,
        nodes: [
          ...board.state.nodes,
          {
            id: trayNodeId,
            type: 'generate',
            position: { x: 920, y: 180 },
            data: {
              mode: 'video',
              modelId: 'seedance-2-0-fast',
              prompt: 'Детерминированный локальный клип',
              status: 'done',
              resultUrl: fixtureAsset!.assetUrl,
              resultKind: 'video',
              assetId: fixtureAsset!.id,
            },
          },
        ],
        tray: [trayNodeId],
      },
    },
  });
  expect(update.ok(), `board fixture update HTTP ${update.status()}`).toBe(true);

  await page.reload();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();
  await page.getByTestId('board-assemble').click();
  await expect(page.getByTestId('studio-destination-dialog')).toBeVisible();
  await page.getByTestId('studio-destination-new').click();
  await expect(page).toHaveURL(new RegExp(`/studio/[^/?]+\\?projectId=${projectId}`), {
    timeout: 90_000,
  });
  const studioProjectId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByTestId('studio-project-title')).toContainText('Монтаж');
  await expect(page.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Скрыть уведомление' }).click({ timeout: 15_000 });

  // Render locally through the integration worker, exercising the real queued
  // render contract and its completed project output.
  await page.getByTestId('export-btn').click({ timeout: 15_000 });
  await expect(page.getByTestId('render-result')).toBeVisible({ timeout: 180_000 });

  // The canonical return lands on the desk, where all exclusive records and
  // both project media memberships must be visible.
  await page.getByTestId('desk-return').click();
  await expect(page).toHaveURL(`/workspace/${projectId}`);
  await expect(page.getByTestId(`desk-item-script-${scriptId}`)).toBeVisible();
  await expect(page.getByTestId(`desk-item-board-${boardId}`)).toBeVisible();
  await expect(page.getByTestId(`desk-item-studio-${studioProjectId}`)).toBeVisible();
  await expect(page.getByTestId(`desk-item-media-${generatedAsset!.id}`)).toBeVisible();

  const deskResponse = await context.request.get(`${apiUrl}/v1/projects/${projectId}/desk-items`, {
    headers: { cookie: cookieHeader },
  });
  expect(deskResponse.status()).toBe(200);
  const desk = (await deskResponse.json()) as {
    items: Array<{
      type: string;
      id: string;
      asset?: { id: string; kind: string; sourceLine: string };
    }>;
    apps: {
      scenario: Array<{ id: string }>;
      boards: Array<{ id: string }>;
      studio: Array<{ id: string }>;
    };
  };
  const completedOutput = desk.items.find(
    (item) => item.type === 'media' && item.asset?.sourceLine === 'из Студии',
  );
  expect(completedOutput?.asset?.kind).toBe('video');
  await expect(page.getByTestId(`desk-item-media-${completedOutput!.id}`)).toBeVisible();
  expect(desk.apps.scenario.map((item) => item.id)).toContain(scriptId);
  expect(desk.apps.boards.map((item) => item.id)).toContain(boardId);
  expect(desk.apps.studio.map((item) => item.id)).toContain(studioProjectId);

  const finalGallery = await context.request.get(
    `${apiUrl}/v1/gallery?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  const finalIds = ((await finalGallery.json()) as { rows: GalleryRow[] }).rows.map(
    (row) => row.id,
  );
  expect(finalIds).toEqual(expect.arrayContaining([generatedAsset!.id, completedOutput!.id]));
});

/**
 * The Studio editor's own chrome. Its header back control and its in-editor
 * cross-links used to hardcode standalone targets, so leaving the montage in
 * project mode silently dropped the project: the «← НА СТОЛ» pill disappeared
 * and anything generated from Studio landed in the global library.
 */
test('the Studio editor keeps the project in its header and its internal links', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: `Монтаж в проекте ${Date.now()}` },
  });
  expect(projectResponse.ok(), `project create HTTP ${projectResponse.status()}`).toBe(true);
  const projectId = ((await projectResponse.json()) as { id: string }).id;

  const studioResponse = await context.request.post(`${apiUrl}/v1/studio/projects`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Монтаж проекта', projectId },
  });
  expect(studioResponse.status()).toBe(201);
  const studioProjectId = ((await studioResponse.json()) as { id: string }).id;

  await page.goto(`/studio/${studioProjectId}?projectId=${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId('studio-project-title')).toBeVisible({ timeout: 60_000 });

  // Internal cross-links carry the project rather than exiting to the global app.
  await expect(page.getByTestId('upload-generate')).toHaveAttribute(
    'href',
    `/generate?projectId=${projectId}`,
  );
  await expect(page.getByTestId('media-panel-generate')).toHaveAttribute(
    'href',
    `/generate?projectId=${projectId}`,
  );

  // The header back control returns to the PROJECT's montage list…
  await expect(page.getByTestId('studio-to-projects')).toHaveAttribute(
    'href',
    `/studio/projects?projectId=${projectId}`,
  );
  await page.getByTestId('studio-to-projects').click();
  await expect(page).toHaveURL(`/studio/projects?projectId=${projectId}`, { timeout: 30_000 });

  // …and the Среда return context survives the trip.
  await expect(page.getByTestId('desk-return')).toHaveAttribute('href', `/workspace/${projectId}`, {
    timeout: 30_000,
  });
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sreda:active-desk')))
    .toBe(projectId);
});

test('a standalone Studio editor stays standalone', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const studioResponse = await context.request.post(`${apiUrl}/v1/studio/projects`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Самостоятельный монтаж' },
  });
  expect(studioResponse.status()).toBe(201);
  const studioProjectId = ((await studioResponse.json()) as { id: string }).id;

  await page.goto(`/studio/${studioProjectId}`);
  await expect(page.getByTestId('studio-project-title')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('studio-to-projects')).toHaveAttribute('href', '/studio/projects');
  await expect(page.getByTestId('upload-generate')).toHaveAttribute('href', '/generate');
  await page.getByTestId('studio-to-projects').click();
  await expect(page).toHaveURL('/studio/projects', { timeout: 30_000 });
  await expect(page.getByTestId('desk-return')).toHaveCount(0);
});

test('standalone products create global-only work after leaving remembered project context', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(240_000);
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    headers: { cookie: cookieHeader },
    data: { title: 'Контекст, который нужно забыть' },
  });
  const projectId = ((await projectResponse.json()) as { id: string }).id;
  await page.goto(`/generate?projectId=${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId('project-context-valid')).toBeVisible();

  // Owner ruling 2026-07-27: Среда has exactly ONE way out, and it is a
  // shutdown. Back arrow → the desk; the desk's «ВЫЙТИ» → the site. The bar's
  // wordmark deliberately navigates nowhere, so there is no side door and no
  // second, invisible exit.
  //
  // What is genuinely gone is «leave the project but stay on THIS product» as a
  // single action. Everything asserted below — landing project-free, and the
  // next generation going to the global library — is the contract that survives.
  await page.getByTestId('desk-return').click();
  await expect(page).toHaveURL(new RegExp(`/workspace/${projectId}$`));
  await page.getByTestId('desk-exit').click();
  await expect(page).toHaveURL(/\/$/);
  // A fresh stack user may see the server-backed welcome card above the nav.
  const onboarding = page.getByTestId('onboarding-card').getByTestId('onboarding-skip');
  if (await onboarding.isVisible().catch(() => false)) await onboarding.click();
  await page
    .getByTestId('product-nav')
    .getByRole('link', { name: 'Генерация', exact: true })
    .click();
  await expect(page).toHaveURL('/generate');
  await expect(page.getByTestId('project-context-valid')).toHaveCount(0);
  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    headers: { cookie: cookieHeader },
    data: { amount: 500 },
  });
  expect(grant.ok()).toBe(true);
  await page.getByTestId('prompt').fill('Самостоятельный материал общей библиотеки');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('result-image')).toBeVisible({ timeout: 90_000 });

  const globalGalleryResponse = await context.request.get(`${apiUrl}/v1/gallery?limit=100`, {
    headers: { cookie: cookieHeader },
  });
  const globalRows = ((await globalGalleryResponse.json()) as { rows: GalleryRow[] }).rows;
  expect(globalRows).toHaveLength(1);
  const standaloneAssetId = globalRows[0]!.id;
  const oldProjectGallery = await context.request.get(
    `${apiUrl}/v1/gallery?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  expect(((await oldProjectGallery.json()) as { rows: GalleryRow[] }).rows).toHaveLength(0);

  // A standalone list is browse-only. Its create action opens the intent
  // surface without creating a ghost row.
  await page.goto('/scenario');
  await expect(page.getByTestId('scenario-page')).toBeVisible();
  const beforeStandaloneCreate = await context.request.get(`${apiUrl}/v1/scripts?limit=100`, {
    headers: { cookie: cookieHeader },
  });
  const beforeStandaloneCount = ((await beforeStandaloneCreate.json()) as { items: unknown[] })
    .items.length;
  await page.getByTestId('scenario-create').click();
  await expect(page).toHaveURL(/\/scenario\/new$/, { timeout: 30_000 });
  const afterStandaloneCreate = await context.request.get(`${apiUrl}/v1/scripts?limit=100`, {
    headers: { cookie: cookieHeader },
  });
  expect(((await afterStandaloneCreate.json()) as { items: unknown[] }).items.length).toBe(
    beforeStandaloneCount,
  );

  await page.goto('/boards');
  await expect(page).toHaveURL(/\/boards\/[^/?]+$/, { timeout: 30_000 });
  await page.goto('/boards');
  await expect(page.getByTestId('board-card')).toBeVisible();
  await page.getByTestId('board-create').click();
  await expect(page).toHaveURL(/\/boards\/[^/?]+$/, { timeout: 30_000 });

  await page.goto('/studio/projects');
  await expect(page).toHaveURL(/\/studio\/[^/?]+$/, { timeout: 30_000 });
  await page.goto('/studio/projects');
  await expect(page.getByTestId('studio-project-card')).toBeVisible();
  await page.getByTestId('studio-project-create').click();
  await expect(page).toHaveURL(/\/studio\/[^/?]+$/, { timeout: 30_000 });

  const [scripts, boards, studio] = await Promise.all([
    context.request.get(`${apiUrl}/v1/scripts`, { headers: { cookie: cookieHeader } }),
    context.request.get(`${apiUrl}/v1/boards`, { headers: { cookie: cookieHeader } }),
    context.request.get(`${apiUrl}/v1/studio/projects`, { headers: { cookie: cookieHeader } }),
  ]);
  for (const response of [scripts, boards, studio]) expect(response.status()).toBe(200);
  const exclusiveRows = [
    ...((await scripts.json()) as { items: Array<{ projectId: string | null }> }).items,
    ...((await boards.json()) as { items: Array<{ projectId: string | null }> }).items,
    ...((await studio.json()) as { items: Array<{ projectId: string | null }> }).items,
  ];
  expect(exclusiveRows).toHaveLength(6);
  expect(exclusiveRows.every((row) => row.projectId === null)).toBe(true);

  await page.goto('/generate');
  await expect(page).toHaveURL('/generate');
  await expect(page.getByTestId('generation-tile')).toHaveCount(1);
  const renderedIds = await page
    .getByTestId('generation-tile')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset['itemId']));
  expect(renderedIds).toContain(standaloneAssetId);
});
