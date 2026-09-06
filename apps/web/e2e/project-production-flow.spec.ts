import { expect, test } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';

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
  'ИНТ. МАСТЕРСКАЯ - ДЕНЬ\n= Героиня готовит первый кадр.\n\nОна включает проектор.\n';

async function createProject(
  context: BrowserContext,
  apiUrl: string,
  cookieHeader: string,
  title: string,
): Promise<string> {
  const response = await context.request.post(`${apiUrl}/v1/projects`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

test('empty project homes create real scoped resources in Scenario, Boards, and Studio', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const products = [
    {
      title: 'Контекст сценария',
      home: '/scenario/new',
      route: /\/scenario\/new\?projectId=/,
      list: '/v1/scripts',
      key: 'items',
      creates: false,
    },
    {
      title: 'Контекст борда',
      home: '/boards',
      route: /\/boards\/[^/?]+\?projectId=/,
      list: '/v1/boards',
      key: 'items',
      creates: true,
    },
    {
      title: 'Контекст монтажа',
      home: '/studio/projects',
      route: /\/studio\/[^/?]+\?projectId=/,
      list: '/v1/studio/projects',
      key: 'items',
      creates: true,
    },
  ] as const;

  for (const product of products) {
    const projectId = await createProject(
      context,
      apiUrl,
      cookieHeader,
      `${product.title} ${Date.now()}`,
    );
    await page.goto(`${product.home}?projectId=${encodeURIComponent(projectId)}`);
    await expect(page).toHaveURL(product.route);
    await expect(page.getByTestId('project-context-valid')).toContainText(product.title);
    await expect(page.getByTestId('desk-return')).toHaveAttribute(
      'href',
      `/workspace/${projectId}`,
    );

    const list = await context.request.get(
      `${apiUrl}${product.list}?projectId=${encodeURIComponent(projectId)}`,
      { headers: { cookie: cookieHeader } },
    );
    expect(list.status()).toBe(200);
    const body = (await list.json()) as Record<string, Array<{ id: string; projectId: string }>>;
    if (product.creates) {
      expect(body[product.key]).toHaveLength(1);
      expect(body[product.key]![0]?.projectId).toBe(projectId);
    } else {
      expect(body[product.key]).toHaveLength(0);
    }
  }
});

test('Scenario hands off to a project Board, which uses project media and opens named Studio', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const projectTitle = `Производственный поток ${Date.now()}`;
  const projectId = await createProject(context, apiUrl, cookieHeader, projectTitle);
  const scriptResponse = await context.request.post(`${apiUrl}/v1/scripts`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Свет в мастерской', fountain: screenplay, projectId },
  });
  expect(scriptResponse.status()).toBe(201);
  const script = (await scriptResponse.json()) as { id: string };

  await page.goto(`/scenario/${script.id}?projectId=${encodeURIComponent(projectId)}`);
  await expect(page.getByTestId('project-context-valid')).toContainText(projectTitle);
  await page.getByTestId('scenario-board-open').click();
  await expect(page.getByTestId('scenario-board-dialog')).toBeVisible();
  await expect(page.getByTestId('scenario-board-destination')).toHaveValue('new');
  let scenarioResponseLost = false;
  const scenarioHandoffUrl = `${apiUrl}/v1/scripts/${script.id}/board-handoff`;
  await page.route(scenarioHandoffUrl, async (route) => {
    if (route.request().method() === 'POST' && !scenarioResponseLost) {
      scenarioResponseLost = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByTestId('scenario-board-submit').click();
  await expect(page.getByText(/тот же запрос не создаст дубль/i)).toBeVisible();
  await page.unroute(scenarioHandoffUrl);
  await page.getByTestId('scenario-board-submit').click();
  await expect(page.getByTestId('scenario-board-receipt')).toContainText(
    'Передача уже была выполнена',
  );
  await page.getByTestId('scenario-board-open-result').click();
  await expect(page).toHaveURL(new RegExp(`/boards/[^/?]+\\?projectId=${projectId}`));
  await expect(page.getByTestId('board-canvas')).toBeVisible();
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(1);

  let scopedMediaRequest = '';
  await page.route(`${apiUrl}/v1/gallery?**`, async (route) => {
    scopedMediaRequest = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        rows: [
          {
            id: 'project-image-fixture',
            assetUrl: `${new URL(page.url()).origin}/icons/192.png`,
            thumbnailUrl: null,
            kind: 'image',
          },
        ],
        nextCursor: null,
      }),
    });
  });
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-media').click();
  await expect(page.getByTestId('project-media-picker')).toBeVisible();
  await page.getByTestId('project-media-project-image-fixture').click();
  expect(new URL(scopedMediaRequest).searchParams.get('projectId')).toBe(projectId);
  await expect(page.locator('.react-flow__node-media')).toHaveCount(1);
  await page.unroute(`${apiUrl}/v1/gallery?**`);

  const boardId = new URL(page.url()).pathname.split('/').pop()!;
  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as { state: { nodes: unknown[] } };
      return body.state.nodes.length;
    })
    .toBeGreaterThanOrEqual(2);

  const boardResponse = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader },
  });
  expect(boardResponse.ok()).toBe(true);
  const board = (await boardResponse.json()) as {
    state: {
      __rev: number;
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      tray?: string[];
    };
  };
  const videoId = 'project-video-fixture';
  const videoUrl = `${new URL(page.url()).origin}/_dev/studio-fix.webm`;
  const fixtureResponse = await context.request.put(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      rev: board.state.__rev,
      state: {
        ...board.state,
        nodes: [
          ...board.state.nodes,
          {
            id: videoId,
            type: 'generate',
            position: { x: 900, y: 180 },
            data: {
              mode: 'video',
              modelId: 'seedance-2-0-fast',
              prompt: 'детерминированный монтажный клип',
              status: 'done',
              resultUrl: videoUrl,
              resultKind: 'video',
            },
          },
        ],
        tray: [videoId],
      },
    },
  });
  expect(
    fixtureResponse.ok(),
    `fixture update HTTP ${fixtureResponse.status()}: ${await fixtureResponse.text()}`,
  ).toBe(true);

  await page.reload();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();
  await page.getByTestId('board-assemble').click();
  await expect(page.getByTestId('studio-destination-dialog')).toBeVisible();
  let studioResponseLost = false;
  const studioHandoffUrl = `${apiUrl}/v1/boards/${boardId}/studio-handoff`;
  await page.route(studioHandoffUrl, async (route) => {
    if (!studioResponseLost) {
      studioResponseLost = true;
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.getByTestId('studio-destination-new').click();
  await expect(page.getByTestId('board-toast')).toContainText('Не удалось передать монтаж');
  await page.unroute(studioHandoffUrl);
  await page.getByTestId('studio-destination-new').click();
  await expect(page).toHaveURL(
    new RegExp(`/studio/[^/?]+\\?projectId=${projectId}.*handoff=replayed`),
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('studio-handoff-receipt')).toContainText(
    'Повторный запрос распознан',
  );
  await expect(page.getByTestId('studio-handoff-receipt')).toContainText('Дубликат не создан');
  await expect(page.getByTestId('studio-handoff-receipt')).toContainText('1 клип');
  await expect(page.getByTestId('desk-return')).toHaveAttribute('href', `/workspace/${projectId}`, {
    timeout: 30_000,
  });

  const studioProjectId = new URL(page.url()).pathname.split('/').pop()!;
  const studio = await context.request.get(
    `${apiUrl}/v1/studio/projects/${studioProjectId}?projectId=${projectId}`,
    { headers: { cookie: cookieHeader } },
  );
  expect(studio.status()).toBe(200);
  expect((await studio.json()).projectId).toBe(projectId);

  await page.getByRole('link', { name: 'Вернуться к исходному борду' }).click();
  await expect(page).toHaveURL(`/boards/${boardId}?projectId=${projectId}`);
});

test('Scenario handoff receipt makes a protected partial re-sync visible', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const scriptResponse = await context.request.post(`${apiUrl}/v1/scripts`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Защищённый re-sync', fountain: screenplay },
  });
  expect(scriptResponse.status()).toBe(201);
  const scriptId = ((await scriptResponse.json()) as { id: string }).id;

  await page.goto(`/scenario/${scriptId}`);
  await page.getByTestId('scenario-board-open').click();
  const handoffUrl = `${apiUrl}/v1/scripts/${scriptId}/board-handoff`;
  await page.route(handoffUrl, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        boardId: 'protected-board',
        title: 'Защищённый re-sync',
        created: false,
        replayed: false,
        added: 0,
        updated: 0,
        removed: 0,
        skipped: 1,
      }),
    });
  });

  await page.getByTestId('scenario-board-submit').click();
  await expect(page.getByTestId('scenario-board-receipt')).toContainText('пропущено 1');
  await page.unroute(handoffUrl);
});

test('Scenario can update an existing Board only inside the same project', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const projectId = await createProject(
    context,
    apiUrl,
    cookieHeader,
    `Существующая ${Date.now()}`,
  );
  const [scriptResponse, boardResponse] = await Promise.all([
    context.request.post(`${apiUrl}/v1/scripts`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: { title: 'Источник существующего борда', fountain: screenplay, projectId },
    }),
    context.request.post(`${apiUrl}/v1/boards`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: { title: 'Готовый борд проекта', projectId },
    }),
  ]);
  expect(scriptResponse.status()).toBe(201);
  expect(boardResponse.status()).toBe(201);
  const scriptId = ((await scriptResponse.json()) as { id: string }).id;
  const boardId = ((await boardResponse.json()) as { id: string }).id;

  await page.goto(`/scenario/${scriptId}?projectId=${projectId}`);
  await page.getByTestId('scenario-board-open').click();
  await page.getByTestId('scenario-board-destination').selectOption(boardId);
  await page.getByTestId('scenario-board-submit').click();
  await expect(page.getByTestId('scenario-board-receipt')).toContainText('Обновлён борд');
  await page.getByTestId('scenario-board-open-result').click();
  await expect(page).toHaveURL(`/boards/${boardId}?projectId=${projectId}`);
  await boardSurfaceReady(page);
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(1);
});
