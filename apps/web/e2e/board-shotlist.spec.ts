import { test, expect } from './fixtures';

/**
 * Same paid-plan beforeEach board-graph.spec.ts got in be44ba6b, for the same
 * reason: `fixtures.ts` mints a fresh user and a fresh user is `free`, but the
 * catalog has NO free-tier video model. Every video model then renders locked,
 * so a character node reports «модель не использует референсы объекта» —
 * which is about the PLAN, not the model. These specs exercise the shot list,
 * not the paywall; the tier gate keeps its own coverage in
 * lib/boards-tier-gate.test.ts and lib/model-tier.test.ts.
 */
test.beforeEach(async ({ context, cookieHeader, apiUrl }) => {
  const res = await context.request.post(`${apiUrl}/v1/dev/godmode`, {
    headers: { cookie: cookieHeader },
  });
  expect(res.ok(), `godmode should succeed (got ${res.status()})`).toBeTruthy();
});

/**
 * B-3: the board can be reviewed linearly via the shot list without panning the
 * graph, and the list stays in sync with the canvas (it's derived live from the
 * same nodes/edges).
 */
test('board: shot list lists graph shots with connected cast', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Seed a board with one shot (generate node) + a connected character.
  const create = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'E2E shot list' },
  });
  expect(create.ok(), `create board (${create.status()})`).toBeTruthy();
  const { id } = (await create.json()) as { id: string };

  const state = {
    schemaVersion: 1,
    nodes: [
      {
        id: 'g1',
        type: 'generate',
        position: { x: 160, y: 140 },
        data: {
          mode: 'video',
          modelId: 'seedance-2-0-fast-reference-to-video',
          prompt: 'герой на крыше',
          status: 'idle',
          count: 1,
        },
      },
      {
        id: 'ch1',
        type: 'cast',
        position: { x: 0, y: 0 },
        data: {
          castKind: 'character',
          name: 'Аня',
          imageUrls: ['http://example.test/anya.png'],
        },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'ch1',
        target: 'g1',
        sourceHandle: 'out',
        targetHandle: 'images[0]',
        type: 'typed',
      },
    ],
    tray: [],
  };
  const put = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok(), `seed board state (${put.status()})`).toBeTruthy();

  await page.goto(`/boards/${id}`);
  // Toggle the shot list and assert the shot + its connected character appear.
  await page.getByTestId('board-shotlist').click();
  await expect(page.getByTestId('shot-list-panel')).toBeVisible({ timeout: 30_000 });
  const rows = page.getByTestId('shot-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('герой на крыше');
  await expect(rows.first()).toContainText('Аня');

  // Export the storyboard → a printable HTML contact sheet downloads.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('shotlist-export').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.html$/);
});

test('board: best-take selection sets the shot result', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  const create = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'E2E best take' },
  });
  expect(create.ok()).toBeTruthy();
  const { id } = (await create.json()) as { id: string };

  // A completed shot with two takes; the first is the default best take.
  const state = {
    nodes: [
      {
        id: 'g1',
        type: 'generate',
        position: { x: 160, y: 140 },
        data: {
          mode: 'image',
          prompt: 'дубли',
          status: 'done',
          resultUrl: 'http://x/a.png',
          resultKind: 'image',
          takes: ['http://x/a.png', 'http://x/b.png'],
        },
      },
    ],
    edges: [],
    tray: [],
  };
  const put = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/boards/${id}`);
  const thumbs = page.getByTestId('take-thumb');
  await expect(thumbs).toHaveCount(2);
  await expect(thumbs.nth(0)).toHaveAttribute('data-chosen', 'true');
  await expect(page.getByTestId('node-result')).toHaveAttribute('src', /a\.png/);

  // Pick the second take as best → it becomes the shot's result.
  await thumbs.nth(1).click();
  await expect(thumbs.nth(1)).toHaveAttribute('data-chosen', 'true');
  await expect(page.getByTestId('node-result')).toHaveAttribute('src', /b\.png/);

  // B-5: mark the take as identity-drifted; the reroll-keeping-identity action
  // is available (reroll re-pulls the wired character's refs on re-run).
  const drift = page.getByTestId('drift-toggle');
  await expect(drift).toHaveAttribute('data-drifted', 'false');
  await drift.click();
  await expect(drift).toHaveAttribute('data-drifted', 'true');
  await expect(page.getByTestId('reroll')).toBeVisible();
});

test('board: character shows reference coverage + how many shots use it (B-5)', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  const create = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'E2E identity' },
  });
  expect(create.ok()).toBeTruthy();
  const { id } = (await create.json()) as { id: string };

  // One character with a single ref (→ weak identity), wired into two shots.
  const state = {
    nodes: [
      {
        id: 'ch1',
        type: 'cast',
        position: { x: 0, y: 0 },
        data: { castKind: 'character', name: 'Аня', imageUrls: ['http://x/1.png'] },
      },
      {
        id: 'g1',
        type: 'generate',
        position: { x: 320, y: 0 },
        data: { mode: 'video', prompt: 'a' },
      },
      {
        id: 'g2',
        type: 'generate',
        position: { x: 320, y: 220 },
        data: { mode: 'video', prompt: 'b' },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'ch1',
        sourceHandle: 'out',
        target: 'g1',
        targetHandle: 'images[0]',
      },
      {
        id: 'e2',
        source: 'ch1',
        sourceHandle: 'out',
        target: 'g2',
        targetHandle: 'images[0]',
      },
    ],
    tray: [],
  };
  const put = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('cast-identity')).toHaveAttribute('data-strength', 'weak');
  await expect(page.getByTestId('cast-identity')).toContainText('референсы: 1/4');
  await expect(page.getByTestId('cast-route-support')).toContainText('Обычные референсы');
  await expect(page.getByTestId('cast-usage')).toContainText('в 2');
});

test('board: shot grammar controls + shot-list display (B-4)', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  const create = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'E2E grammar' },
  });
  expect(create.ok()).toBeTruthy();
  const { id } = (await create.json()) as { id: string };

  // A shot pre-set with grammar (close-up, push-in).
  const state = {
    nodes: [
      {
        id: 'g1',
        type: 'generate',
        position: { x: 160, y: 140 },
        data: { mode: 'video', prompt: 'кадр', shot: { size: 'cu', moves: ['push'] } },
      },
    ],
    edges: [],
    tray: [],
  };
  const put = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBeTruthy();

  await page.goto(`/boards/${id}`);

  // Shot list displays the grammar controls.
  await page.getByTestId('board-shotlist').click();
  await expect(page.getByTestId('shot-grammar-label')).toContainText('Крупный');
  await expect(page.getByTestId('shot-grammar-label')).toContainText('Наезд');
  await page.getByTestId('board-shotlist').click(); // close the panel

  // The node's grammar picker lets you select a move without typing.
  await page.getByTestId('node-settings-open').click();
  await expect(page.getByTestId('shot-grammar')).toBeVisible();
  const pull = page.getByTestId('g-move-pull');
  await expect(pull).toHaveAttribute('data-on', 'false');
  await pull.click();
  await expect(pull).toHaveAttribute('data-on', 'true');
});
