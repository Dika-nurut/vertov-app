import { test, expect } from './fixtures';

const screenplay = Array.from(
  { length: 3 },
  (_, index) =>
    `ИНТ. ЛОКАЦИЯ ${index + 1} - ДЕНЬ\n= Синопсис ${index + 1}.\n\nДействие ${index + 1}.\n`,
).join('\n');

test('Board → add Scene → choose Scenario and scenes → source blocks appear', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const scriptResponse = await context.request.post(`${apiUrl}/v1/scripts`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Источник для Board', fountain: screenplay },
  });
  expect(scriptResponse.status()).toBe(201);

  const boardResponse = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Board вызывает Scenario' },
  });
  expect(boardResponse.status()).toBe(201);
  const board = (await boardResponse.json()) as { id: string };

  await page.goto(`/boards/${board.id}`);
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-scene').click();
  await expect(page.getByTestId('board-scenario-picker')).toBeVisible();
  await page.getByText('Источник для Board', { exact: true }).click();
  await expect(page.getByTestId('scenario-source-scenes').getByRole('button')).toHaveCount(3);
  await expect(page.getByText('Выбрано: 3')).toBeVisible();
  await page.getByTestId('scenario-add-to-board').click();

  await expect(page.getByTestId('board-scenario-picker')).toHaveCount(0);
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(3);
  await expect(page.getByTestId('scene-node').first()).toContainText('Сценарий · сцена');
  await expect(page.getByTestId('scene-node').first()).not.toContainText('Запустить');

  let submittedJobs = 0;
  await page.route(`${apiUrl}/v1/jobs`, async (route) => {
    if (route.request().method() === 'POST') submittedJobs += 1;
    await route.continue();
  });
  await page.getByTestId('scene-add-shot').first().click();
  await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-generate')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(page.getByTestId('board-toast')).toContainText('запустите вручную');
  expect(submittedJobs).toBe(0);

  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as { state: { nodes: unknown[]; edges: unknown[] } };
      return [body.state.nodes.length, body.state.edges.length];
    })
    .toEqual([5, 1]);
  await page.reload();
  await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-generate')).toHaveCount(1);
  expect(submittedJobs).toBe(0);

  // External generation is represented by deterministic fixtures: this exercises the
  // complete product journey without sending a paid provider job. Keep provenance on
  // both generated assets so a returned Studio user can still trace the source scene.
  const savedResponse = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader },
  });
  expect(savedResponse.ok()).toBe(true);
  const saved = (await savedResponse.json()) as {
    state: {
      __rev: number;
      nodes: Array<{
        id: string;
        type: string;
        position: { x: number; y: number };
        data: Record<string, unknown>;
      }>;
      edges: Array<Record<string, unknown>>;
      tray?: string[];
    };
  };
  const scene = saved.state.nodes.find((node) => node.type === 'scene')!;
  const still = saved.state.nodes.find((node) => node.type === 'generate')!;
  const videoId = 'scenario-video-fixture';
  const nextState = {
    ...saved.state,
    nodes: [
      ...saved.state.nodes.map((node) =>
        node.id === still.id
          ? {
              ...node,
              data: {
                ...node.data,
                status: 'done',
                resultUrl: 'http://example.test/scenario-still.png',
                resultKind: 'image',
              },
            }
          : node,
      ),
      {
        id: videoId,
        type: 'generate',
        position: { x: still.position.x + 430, y: still.position.y },
        data: {
          mode: 'video',
          modelId: 'seedance-2-0-fast',
          prompt: 'оживить первый кадр сцены',
          status: 'done',
          resultUrl: 'http://example.test/scenario-video.mp4',
          resultKind: 'video',
          sourceSceneNodeId: scene.id,
        },
      },
    ],
    edges: [
      ...saved.state.edges,
      {
        id: 'scenario-still-to-video',
        source: still.id,
        sourceHandle: 'out',
        target: videoId,
        targetHandle: 'images[0]',
      },
    ],
    tray: [],
  };
  const fixtureResponse = await context.request.put(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { rev: saved.state.__rev, state: nextState },
  });
  expect(
    fixtureResponse.ok(),
    `fixture update HTTP ${fixtureResponse.status()}: ${await fixtureResponse.text()}`,
  ).toBe(true);

  await page.reload();
  await page.getByTestId('rail-fit').click();
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(3);
  await expect(page.locator('.react-flow__node-generate')).toHaveCount(2);
  const videoNode = page.locator('.react-flow__node-generate').filter({
    has: page.locator('video[data-testid="node-result"]'),
  });
  await expect(videoNode).toHaveCount(1);
  await videoNode.getByRole('button', { name: 'В монтаж' }).click();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();
  await page.getByTestId('board-assemble').click();
  await expect(page.getByTestId('studio-sheet')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'К борду' }).click();
  await expect(page.getByTestId('board-canvas')).toBeVisible();

  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as {
        state: {
          nodes: Array<{ id: string; data: Record<string, unknown> }>;
          tray?: string[];
        };
      };
      const video = body.state.nodes.find((node) => node.id === videoId);
      return [video?.data.sourceSceneNodeId, body.state.tray?.[0]];
    })
    .toEqual([scene.id, videoId]);
  await page.reload();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();
  expect(submittedJobs).toBe(0);
});

test('Board keeps existing work when Scenario source apply fails', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const scriptResponse = await context.request.post(`${apiUrl}/v1/scripts`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Источник с ошибкой', fountain: screenplay },
  });
  expect(scriptResponse.status()).toBe(201);

  const boardResponse = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Не потерять при импорте' },
  });
  const board = (await boardResponse.json()) as { id: string };
  await page.goto(`/boards/${board.id}`);
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-note').click();
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-scene').click();
  await page.getByText('Источник с ошибкой', { exact: true }).click();

  await page.route(`${apiUrl}/v1/scripts/*/board-handoff`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  await page.getByTestId('scenario-add-to-board').click();
  await expect(page.getByText('Не удалось добавить сцены на борд.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('board-scenario-picker')).toBeVisible();
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(0);
});
