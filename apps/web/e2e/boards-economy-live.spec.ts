import { test, expect } from './fixtures';

test.skip(
  process.env.BOARDS_ECONOMY_LIVE !== '1',
  'paid live run — set BOARDS_ECONOMY_LIVE=1 only after recording the probe ledger',
);

test.use({ signedInEmail: process.env.GOD_EMAIL ?? 'god@seed.local' });

const screenplay = `ИНТ. МАЛЕНЬКАЯ МАСТЕРСКАЯ — УТРО
= Механическая птица впервые оживает.

Мастер отступает от стола. Латунная птица раскрывает крылья в луче утреннего света.
`;

test('paid economy CJM: Scenario → image → first-frame video → Studio → reload', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(15 * 60_000);
  const scenarioTitle = `Economy live Boards CJM ${Date.now()}`;

  const meBefore = await context.request.get(`${apiUrl}/v1/me`, {
    headers: { cookie: cookieHeader },
  });
  expect(meBefore.ok()).toBe(true);
  const before = (await meBefore.json()) as Record<string, unknown>;

  const scriptResponse = await context.request.post(`${apiUrl}/v1/scripts`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: scenarioTitle, fountain: screenplay },
  });
  expect(scriptResponse.status()).toBe(201);

  const boardResponse = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Economy live · mechanical bird' },
  });
  expect(boardResponse.status()).toBe(201);
  const board = (await boardResponse.json()) as { id: string };

  await page.goto(`/boards/${board.id}`);
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-scene').click();
  await page.getByText(scenarioTitle, { exact: true }).click();
  await page.getByTestId('scenario-add-to-board').click();
  await expect(page.locator('.react-flow__node-scene')).toHaveCount(1);
  await page.getByTestId('scene-add-shot').click();

  await expect
    .poll(async () => {
      const response = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await response.json()) as { state: { nodes: unknown[] } };
      return body.state.nodes.length;
    })
    .toBe(3);
  const initialResponse = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader },
  });
  const initial = (await initialResponse.json()) as {
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
  const stillDocumentNode = initial.state.nodes.find((node) => node.type === 'generate')!;
  const chooseImage = await context.request.put(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      rev: initial.state.__rev,
      state: {
        ...initial.state,
        nodes: initial.state.nodes.map((node) =>
          node.id === stillDocumentNode.id
            ? {
                ...node,
                data: {
                  ...node.data,
                  modelId: 'gemini-3-1-flash-lite-image',
                  imageAspect: '16:9',
                  count: 1,
                },
              }
            : node,
        ),
      },
    },
  });
  expect(chooseImage.ok(), await chooseImage.text()).toBe(true);
  await page.reload();
  await page.getByTestId('rail-fit').click();

  const still = page.locator('.react-flow__node-generate').first();
  await expect(still).toBeVisible();
  await expect(still.getByTestId('node-model-trigger')).toContainText('Flash Lite');
  await still.getByTestId('node-settings-open').click();
  await expect(still.getByTestId('node-settings-cost')).toContainText('12');
  await still.getByTestId('node-settings-close').click();

  const imageSubmit = page.waitForResponse(
    (response) => response.url() === `${apiUrl}/v1/jobs` && response.request().method() === 'POST',
  );
  await still.getByTestId('node-run').click();
  const imageResponse = await imageSubmit;
  expect(imageResponse.status()).toBe(201);
  const imageJob = (await imageResponse.json()) as { jobId: string };

  await expect
    .poll(
      async () => {
        const response = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
          headers: { cookie: cookieHeader },
        });
        const body = (await response.json()) as {
          state: { nodes: Array<{ type: string; data: Record<string, unknown> }> };
        };
        return body.state.nodes.find((node) => node.type === 'generate')?.data.status;
      },
      { timeout: 5 * 60_000, intervals: [3000] },
    )
    .toBe('done');

  const imageDoneResponse = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader },
  });
  const imageDone = (await imageDoneResponse.json()) as typeof initial;
  const persistedStill = imageDone.state.nodes.find((node) => node.id === stillDocumentNode.id)!;
  const videoId = 'economy-live-video';
  const addVideo = await context.request.put(`${apiUrl}/v1/boards/${board.id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      rev: imageDone.state.__rev,
      state: {
        ...imageDone.state,
        nodes: [
          ...imageDone.state.nodes,
          {
            id: videoId,
            type: 'generate',
            position: { x: persistedStill.position.x + 430, y: persistedStill.position.y },
            data: {
              mode: 'video',
              modelId: 'veo-3-1-lite',
              prompt: 'The brass mechanical bird opens its wings in a beam of morning light.',
              durationSeconds: 4,
              videoResolution: '720p',
              videoAspect: '16:9',
              generateAudio: false,
              count: 1,
              status: 'idle',
              sourceSceneNodeId: persistedStill.data.sourceSceneNodeId,
            },
          },
        ],
        edges: [
          ...imageDone.state.edges,
          {
            id: 'economy-still-first-frame',
            source: persistedStill.id,
            sourceHandle: 'out',
            target: videoId,
            targetHandle: 'images[0]',
          },
        ],
      },
    },
  });
  expect(addVideo.ok(), await addVideo.text()).toBe(true);
  await page.reload();
  await page.getByTestId('rail-fit').click();
  const video = page.locator('.react-flow__node-generate').filter({
    has: page.getByTestId('node-model-trigger').filter({ hasText: 'Veo 3.1 Lite' }),
  });
  await expect(video).toHaveCount(1);
  await video.getByTestId('node-settings-open').click();
  await expect(video.getByTestId('image-input-mode')).toHaveAttribute('data-mode', 'frame');
  await expect(video.getByTestId('vduration')).toContainText('4 с');
  await expect(video.getByTestId('vres')).toContainText('720p');
  await expect(video.getByTestId('vaudio')).toHaveAttribute('data-state', 'unchecked');
  await expect(video.getByTestId('node-settings-cost')).toContainText('140');
  await video.getByTestId('node-settings-close').click();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  const videoSubmit = page.waitForResponse(
    (response) => response.url() === `${apiUrl}/v1/jobs` && response.request().method() === 'POST',
  );
  await video.getByTestId('node-run').click();
  const videoResponse = await videoSubmit;
  expect(videoResponse.status()).toBe(201);
  const videoJob = (await videoResponse.json()) as { jobId: string };

  await expect
    .poll(
      async () => {
        const response = await context.request.get(`${apiUrl}/v1/boards/${board.id}`, {
          headers: { cookie: cookieHeader },
        });
        const body = (await response.json()) as {
          state: { nodes: Array<{ type: string; data: Record<string, unknown> }> };
        };
        return body.state.nodes.filter(
          (node) => node.type === 'generate' && node.data.status === 'done' && node.data.resultUrl,
        ).length;
      },
      { timeout: 8 * 60_000, intervals: [5000] },
    )
    .toBe(2);

  await page.reload();
  await page.getByTestId('rail-fit').click();
  const completedVideo = page.locator('.react-flow__node-generate').filter({
    has: page.locator('video[data-testid="node-result"]'),
  });
  await completedVideo.getByRole('button', { name: 'В монтаж' }).click();
  await page.getByTestId('board-assemble').click();
  await expect(page.getByTestId('studio-sheet')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'К борду' }).click();
  await page.reload();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();

  const meAfter = await context.request.get(`${apiUrl}/v1/me`, {
    headers: { cookie: cookieHeader },
  });
  expect(meAfter.ok()).toBe(true);
  const after = (await meAfter.json()) as Record<string, unknown>;

  console.log(
    JSON.stringify({
      boardId: board.id,
      imageJobId: imageJob.jobId,
      videoJobId: videoJob.jobId,
      balanceBefore: before['creditBalance'] ?? before['balance'],
      balanceAfter: after['creditBalance'] ?? after['balance'],
    }),
  );
});

test('paid economy resume: persisted first frame → one Veo job → Studio', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(12 * 60_000);
  console.log('economy-resume: fixtures ready');
  const boardId = process.env.BOARDS_ECONOMY_RESUME_BOARD;
  expect(boardId, 'BOARDS_ECONOMY_RESUME_BOARD is required').toBeTruthy();

  const beforeResponse = await context.request.get(`${apiUrl}/v1/credits/balance`, {
    headers: { cookie: cookieHeader },
  });
  expect(beforeResponse.ok()).toBe(true);
  console.log('economy-resume: balance loaded');
  const before = (await beforeResponse.json()) as Record<string, unknown>;

  const documentResponse = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader },
  });
  expect(documentResponse.ok()).toBe(true);
  console.log('economy-resume: board document loaded');
  const document = (await documentResponse.json()) as {
    state: {
      nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
      edges: Array<{ source: string; target: string; targetHandle?: string }>;
    };
  };
  const still = document.state.nodes.find(
    (node) => node.type === 'generate' && node.data.modelId === 'gemini-3-1-flash-lite-image',
  )!;
  const video = document.state.nodes.find((node) => node.id === 'economy-live-video')!;
  expect(still.data.status).toBe('done');
  expect(still.data.resultUrl).toBeTruthy();
  expect(video.data).toMatchObject({
    modelId: 'veo-3-1-lite',
    durationSeconds: 4,
    videoResolution: '720p',
    videoAspect: '16:9',
    generateAudio: false,
  });
  expect(['idle', 'running', 'done']).toContain(video.data.status);
  expect(
    document.state.edges.some(
      (edge) =>
        edge.source === still.id && edge.target === video.id && edge.targetHandle === 'images[0]',
    ),
  ).toBe(true);

  await page.goto(`/boards/${boardId}`);
  console.log('economy-resume: board page loaded');
  await expect(page.getByTestId('rail-fit')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('rail-fit').click({ timeout: 30_000 });
  console.log('economy-resume: canvas fitted');
  const videoNode = page.locator('.react-flow__node-generate').filter({
    has: page.getByTestId('node-model-trigger').filter({ hasText: 'Veo 3.1 Lite' }),
  });
  await expect(videoNode).toHaveCount(1, { timeout: 30_000 });
  let job: { jobId: string };
  if (video.data.status === 'idle') {
    await expect(videoNode.getByTestId('node-run')).toBeEnabled({ timeout: 30_000 });
    console.log('economy-resume: Veo node ready');
    const submit = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/v1/jobs` && response.request().method() === 'POST',
    );
    await videoNode.getByTestId('node-run').click();
    const response = await submit;
    expect(response.status()).toBe(201);
    job = (await response.json()) as { jobId: string };
  } else {
    expect(video.data.jobId).toBeTruthy();
    job = { jobId: String(video.data.jobId) };
    console.log(`economy-resume: resuming existing job ${job.jobId}`);
  }

  await expect
    .poll(
      async () => {
        const board = (await (
          await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
            headers: { cookie: cookieHeader },
          })
        ).json()) as {
          state: { nodes: Array<{ id: string; data: Record<string, unknown> }> };
        };
        return board.state.nodes.find((node) => node.id === video.id)?.data.status;
      },
      { timeout: 8 * 60_000, intervals: [5000] },
    )
    .toBe('done');

  await page.reload();
  await page.getByTestId('rail-fit').click();
  const completedVideo = page.locator('.react-flow__node-generate').filter({
    has: page.locator('video[data-testid="node-result"]'),
  });
  await completedVideo.getByRole('button', { name: 'В монтаж' }).click();
  await page.getByTestId('board-assemble').click();
  await expect(page.getByTestId('studio-sheet')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'К борду' }).click();
  await page.reload();
  await expect(page.getByTestId('board-assemble')).toBeEnabled();

  const afterResponse = await context.request.get(`${apiUrl}/v1/credits/balance`, {
    headers: { cookie: cookieHeader },
  });
  const after = (await afterResponse.json()) as Record<string, unknown>;
  console.log(
    JSON.stringify({
      boardId,
      imageJobId: still.data.jobId,
      videoJobId: job.jobId,
      balanceBefore: before,
      balanceAfter: after,
    }),
  );
});
