import { test, expect } from './fixtures';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * «Борд» node-graph canvas — undo/redo physics.
 * No generation jobs are submitted anywhere here (zero credit spend).
 */

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  projectId?: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'График e2e', ...(projectId ? { projectId } : {}) },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function addPromptNode(page: Page): Promise<void> {
  await page.getByTestId('board-add').click();
  await page.getByTestId('add-prompt').click();
  await expect(page.locator('.react-flow__node-prompt')).toBeVisible();
}

/** Click empty canvas so keyboard events go to the pane, not a textarea. */
async function focusPane(page: Page): Promise<void> {
  await page.locator('.react-flow__pane').click({ position: { x: 40, y: 420 } });
}

/** Current viewport zoom, parsed from the transform style. */
async function getZoom(page: Page): Promise<number> {
  const tf = await page
    .locator('.react-flow__viewport')
    .evaluate((el) => (el as HTMLElement).style.transform);
  const m = /scale\(([\d.]+)\)/.exec(tf);
  return m ? Number(m[1]) : 1;
}

async function getTranslate(page: Page): Promise<string> {
  const tf = await page
    .locator('.react-flow__viewport')
    .evaluate((el) => (el as HTMLElement).style.transform);
  return /translate\([^)]*\)/.exec(tf)?.[0] ?? '';
}

/**
 * Put every board test on a paid plan.
 *
 * `fixtures.ts` mints a fresh user per test, and a fresh user is on `free` —
 * but the catalog has NO free-tier video model at all. Since the board picker
 * started rendering out-of-plan models locked (with the upsell that /generate
 * has always shown), a free fixture sees every video node locked: no price
 * readout, no selectable model. These specs exercise canvas mechanics and cost
 * arithmetic, NOT the paywall, so the realistic state for them is a subscriber.
 *
 * This is not a weakened assertion — the gate keeps its own dedicated coverage
 * in `lib/boards-tier-gate.test.ts` and `lib/model-tier.test.ts`. Same
 * `/v1/dev/godmode` call `generate.spec.ts` already uses; it grants 100k
 * credits, `tier='max'` and an active max subscription.
 */
test.beforeEach(async ({ context, cookieHeader, apiUrl }) => {
  const res = await context.request.post(`${apiUrl}/v1/dev/godmode`, {
    headers: { cookie: cookieHeader },
  });
  expect(res.ok(), `godmode should succeed (got ${res.status()})`).toBeTruthy();
});

test.describe('canvas rail & tools', () => {
  test('zoom rail, undo/redo buttons, minimap toggle', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);

    // undo is disabled until something happens
    await expect(page.getByTestId('rail-undo')).toBeDisabled();
    await addPromptNode(page);
    await expect(page.getByTestId('rail-undo')).toBeEnabled();

    await page.getByTestId('rail-undo').click();
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(0);
    await page.getByTestId('rail-redo').click();
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);

    // zoom in, then reset via the % readout
    const z0 = await getZoom(page);
    await page.getByTestId('rail-zoom-in').click();
    await expect.poll(() => getZoom(page)).toBeGreaterThan(z0);
    await page.getByTestId('rail-zoom-level').click();
    await expect.poll(() => getZoom(page)).toBe(1);

    // minimap toggles
    await expect(page.locator('.react-flow__minimap')).toHaveCount(0);
    await page.getByTestId('rail-minimap').click();
    await expect(page.locator('.react-flow__minimap')).toBeVisible();
    await page.getByTestId('rail-minimap').click();
    await expect(page.locator('.react-flow__minimap')).toHaveCount(0);
  });

  test('pan is the default tool; switching to select marquees', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);
    await page.getByTestId('board-add').click();
    await page.getByTestId('add-note').click();
    await expect(page.locator('.react-flow__node-note')).toBeVisible();

    // PAN is the default: a left-drag on the empty pane moves the viewport.
    const t0 = await getTranslate(page);
    await page.mouse.move(120, 440);
    await page.mouse.down();
    await page.mouse.move(340, 560, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => getTranslate(page)).not.toBe(t0);

    // Switch to the SELECT tool → a left-drag marquees the nodes inside the box.
    await page.getByTestId('tool-select').click();
    const a = (await page.locator('.react-flow__node-prompt').boundingBox())!;
    const b = (await page.locator('.react-flow__node-note').boundingBox())!;
    const x0 = Math.min(a.x, b.x) - 40;
    const y0 = Math.min(a.y, b.y) - 40;
    const x1 = Math.max(a.x + a.width, b.x + b.width) + 40;
    const y1 = Math.max(a.y + a.height, b.y + b.height) + 40;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBeGreaterThan(0);

    // Industry-standard temporary hand: while SELECT remains the chosen tool,
    // holding Space turns an empty-pane drag into viewport pan.
    const t1 = await getTranslate(page);
    await page.keyboard.down('Space');
    await page.mouse.move(140, 460);
    await page.mouse.down();
    await page.mouse.move(320, 520, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await expect.poll(() => getTranslate(page)).not.toBe(t1);

    // The active widget itself remains draggable in SELECT mode; SELECT only
    // changes empty-canvas gestures.
    const promptHeader = (await page.getByTestId('node-prompt-header').boundingBox())!;
    const promptBefore = (await page.locator('.react-flow__node-prompt').boundingBox())!;
    await page.mouse.move(
      promptHeader.x + promptHeader.width / 2,
      promptHeader.y + promptHeader.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      promptHeader.x + promptHeader.width / 2 + 160,
      promptHeader.y + promptHeader.height / 2 + 80,
      { steps: 10 },
    );
    await page.mouse.up();
    const promptAfter = (await page.locator('.react-flow__node-prompt').boundingBox())!;
    expect(Math.abs(promptAfter.x - promptBefore.x)).toBeGreaterThan(80);
  });

  test('a board with nodes but no saved viewport fits to content on load', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    // seed a node far from the origin, with NO viewport in the state
    const put = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        rev: 0,
        state: {
          nodes: [
            { id: 'n-far', type: 'note', position: { x: 2400, y: 1600 }, data: { text: 'далеко' } },
          ],
          edges: [],
        },
      },
    });
    expect(put.ok()).toBe(true);

    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-note')).toBeVisible();
    // default (no-fit) viewport would be translate(80px, 60px); fitView moves it
    expect(await getTranslate(page)).not.toBe('translate(80px, 60px)');
    // and the node actually sits inside the visible canvas
    const box = (await page.locator('.react-flow__node-note').boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThan(vp.width);
  });
});

test.describe('add-node menu', () => {
  test('empty board explains the first step and creates an image shot directly', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);

    await expect(page.getByTestId('board-empty-guide')).toContainText('Создайте первый кадр');
    await page.getByTestId('empty-add-image').click();
    await expect(page.locator('.react-flow__node-generate')).toHaveCount(1);
    await expect(page.getByTestId('board-empty-guide')).toHaveCount(0);
    await expect(page.getByTestId('node-generate-header')).toContainText('изображения');
  });

  test('search filters the catalog; Enter adds the first match', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);

    await page.getByTestId('board-add').click();
    await expect(page.getByTestId('add-generate')).toBeVisible();
    await page.getByTestId('add-search').fill('замет');
    await expect(page.getByTestId('add-generate')).toHaveCount(0);
    await expect(page.getByTestId('add-note')).toBeVisible();

    await page.getByTestId('add-search').press('Enter');
    await expect(page.locator('.react-flow__node-note')).toHaveCount(1);
    // default mode: menu closes after adding
    await expect(page.getByTestId('add-menu')).toHaveCount(0);
  });

  test('keep-open adds several nodes without overlap', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);

    await page.getByTestId('board-add').click();
    await page.getByTestId('add-keep-open').check();
    await page.getByTestId('add-generate').click();
    await page.getByTestId('add-generate').click();
    await page.getByTestId('add-prompt').click();
    // menu stayed open the whole time
    await expect(page.getByTestId('add-menu')).toBeVisible();
    await expect(page.locator('.react-flow__node-generate')).toHaveCount(2);
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);

    // no two nodes overlap
    const boxes = [];
    for (const sel of [
      '.react-flow__node-generate >> nth=0',
      '.react-flow__node-generate >> nth=1',
      '.react-flow__node-prompt',
    ]) {
      boxes.push((await page.locator(sel).boundingBox())!);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap, `nodes ${i} and ${j} must not overlap`).toBe(false);
      }
    }
  });
});

/**
 * Seed a board with explicit state so slot rendering is deterministic.
 * (Connecting handles by synthetic mouse-drag across 11px React-Flow
 * targets is flaky; the slot logic under test is what matters, and it is
 * driven purely by the edges targeting a generate node.)
 */
async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  state: Record<string, unknown>,
): Promise<string> {
  const id = await newBoard(request, apiUrl, cookie);
  const put = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBe(true);
  return id;
}

interface E2EBoardDocument {
  __rev?: number;
  nodes: { type: string; data: Record<string, unknown> }[];
  viewport?: { x: number; y: number; zoom: number };
}

async function readBoardDocument(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  id: string,
): Promise<E2EBoardDocument> {
  const response = await request.get(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie },
  });
  expect(response.ok(), response.statusText()).toBe(true);
  return ((await response.json()) as { state: E2EBoardDocument }).state;
}

async function openStaleTabConflict(input: {
  page: Page;
  request: APIRequestContext;
  apiUrl: string;
  cookie: string;
  projectId?: string;
}): Promise<{ id: string; stalePage: Page }> {
  const { page, request, apiUrl, cookie, projectId } = input;
  const id = await newBoard(request, apiUrl, cookie, projectId);
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const stalePage = await page.context().newPage();
  await Promise.all([page.goto(`/boards/${id}${query}`), stalePage.goto(`/boards/${id}${query}`)]);
  await Promise.all([
    page.locator('.react-flow__pane').waitFor(),
    stalePage.locator('.react-flow__pane').waitFor(),
  ]);
  await page.waitForTimeout(1_800);
  const untouched = await readBoardDocument(request, apiUrl, cookie, id);
  expect(untouched.__rev).toBe(0);
  expect(untouched.nodes).toEqual([]);

  await addPromptNode(page);
  await page.locator('.react-flow__node-prompt textarea').fill('серверная версия');
  await expect
    .poll(async () => {
      const state = await readBoardDocument(request, apiUrl, cookie, id);
      return state.nodes.find((node) => node.type === 'prompt')?.data['text'];
    })
    .toBe('серверная версия');

  await stalePage.getByTestId('board-add').click();
  await stalePage.getByTestId('add-note').click();
  await stalePage.locator('.react-flow__node-note textarea').fill('локальная версия');
  await expect(stalePage.getByTestId('board-conflict-dialog')).toBeVisible({ timeout: 15_000 });
  await expect(stalePage.getByTestId('board-conflict-dialog')).toContainText(
    'Локальная версия не потеряна',
  );

  const server = await readBoardDocument(request, apiUrl, cookie, id);
  expect(server.nodes.some((node) => node.data['text'] === 'серверная версия')).toBe(true);
  expect(server.nodes.some((node) => node.data['text'] === 'локальная версия')).toBe(false);
  return { id, stalePage };
}

test.describe('Board revision conflict recovery', () => {
  test('opening is read-only while a deliberate viewport change persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await page.locator('.react-flow__pane').waitFor();
    await page.waitForTimeout(1_800);
    expect((await readBoardDocument(context.request, apiUrl, cookieHeader, id)).__rev).toBe(0);

    await page.getByTestId('rail-zoom-in').click();
    await expect
      .poll(async () => {
        const state = await readBoardDocument(context.request, apiUrl, cookieHeader, id);
        return state.viewport?.zoom ?? 1;
      })
      .toBeGreaterThan(1);
    await page.reload();
    await expect.poll(() => getZoom(page)).toBeGreaterThan(1);
  });

  test('reload keeps the server version and deliberately discards the local snapshot', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const { id, stalePage } = await openStaleTabConflict({
      page,
      request: context.request,
      apiUrl,
      cookie: cookieHeader,
    });

    await Promise.all([
      stalePage.waitForNavigation(),
      stalePage.getByTestId('board-conflict-reload').click(),
    ]);
    await expect(stalePage.getByTestId('board-conflict-dialog')).toHaveCount(0);
    await expect(stalePage.locator('.react-flow__node-prompt textarea')).toHaveValue(
      'серверная версия',
    );
    await expect(stalePage.locator('.react-flow__node-note')).toHaveCount(0);
    expect(
      await stalePage.evaluate(
        (key) => window.localStorage.getItem(key),
        `seed.board.recovery.${id}`,
      ),
    ).toBeNull();
  });

  test('a recovered local snapshot survives reload and can be duplicated', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const { id, stalePage } = await openStaleTabConflict({
      page,
      request: context.request,
      apiUrl,
      cookie: cookieHeader,
    });

    await stalePage.reload();
    await expect(stalePage.getByTestId('board-conflict-dialog')).toBeVisible();
    await expect(stalePage.getByTestId('board-conflict-dialog')).toContainText(
      'После прошлого сеанса',
    );
    await stalePage.getByTestId('board-conflict-duplicate').click();
    await stalePage.waitForURL(
      (url) => url.pathname.startsWith('/boards/') && !url.pathname.endsWith(id),
    );
    const duplicateId = new URL(stalePage.url()).pathname.split('/').pop()!;
    await stalePage.locator('.react-flow__pane').waitFor({ timeout: 20_000 });
    await expect(stalePage.locator('.react-flow__node-note textarea')).toHaveValue(
      'локальная версия',
      { timeout: 20_000 },
    );

    const original = await readBoardDocument(context.request, apiUrl, cookieHeader, id);
    const duplicate = await readBoardDocument(context.request, apiUrl, cookieHeader, duplicateId);
    expect(original.nodes.some((node) => node.data['text'] === 'серверная версия')).toBe(true);
    expect(duplicate.nodes.some((node) => node.data['text'] === 'локальная версия')).toBe(true);

    // Standalone recovery stays standalone: no project is invented for it.
    expect(new URL(stalePage.url()).searchParams.get('projectId')).toBeNull();
    const standaloneRow = await context.request.get(`${apiUrl}/v1/boards`, {
      headers: { cookie: cookieHeader },
    });
    const standaloneItems = (
      (await standaloneRow.json()) as { items: Array<{ id: string; projectId: string | null }> }
    ).items;
    expect(standaloneItems.find((item) => item.id === duplicateId)?.projectId).toBeNull();
  });

  test('a duplicate recovered in project mode stays in that project', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: { title: `Восстановление ${Date.now()}` },
    });
    expect(projectResponse.ok(), `project create HTTP ${projectResponse.status()}`).toBe(true);
    const projectId = ((await projectResponse.json()) as { id: string }).id;

    const { id, stalePage } = await openStaleTabConflict({
      page,
      request: context.request,
      apiUrl,
      cookie: cookieHeader,
      projectId,
    });

    await stalePage.getByTestId('board-conflict-duplicate').click();
    await stalePage.waitForURL(
      (url) => url.pathname.startsWith('/boards/') && !url.pathname.endsWith(id),
    );
    const duplicateUrl = new URL(stalePage.url());
    const duplicateId = duplicateUrl.pathname.split('/').pop()!;

    // The recovered copy carries the canonical project context in the URL…
    expect(duplicateUrl.searchParams.get('projectId')).toBe(projectId);
    await expect(stalePage.getByTestId('desk-return')).toHaveAttribute(
      'href',
      `/workspace/${projectId}`,
      { timeout: 30_000 },
    );

    // …and it really belongs to the project, so it appears on that desk.
    const deskResponse = await context.request.get(
      `${apiUrl}/v1/projects/${projectId}/desk-items`,
      { headers: { cookie: cookieHeader } },
    );
    expect(deskResponse.status()).toBe(200);
    const desk = (await deskResponse.json()) as { apps: { boards: Array<{ id: string }> } };
    expect(desk.apps.boards.map((board) => board.id)).toContain(duplicateId);
  });

  test('explicit overwrite rechecks the server revision and persists the rejected local document', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const { id, stalePage } = await openStaleTabConflict({
      page,
      request: context.request,
      apiUrl,
      cookie: cookieHeader,
    });

    const before = await readBoardDocument(context.request, apiUrl, cookieHeader, id);
    const raced = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        state: {
          ...before,
          nodes: before.nodes.map((node) => ({
            ...node,
            data: { ...node.data, text: 'сервер изменился снова' },
          })),
        },
        rev: before.__rev ?? 0,
      },
    });
    expect(raced.ok()).toBe(true);

    await stalePage.getByTestId('board-conflict-overwrite').click();
    await expect(stalePage.getByTestId('board-conflict-error')).toContainText(
      'Борд снова изменили',
    );
    const afterRace = await readBoardDocument(context.request, apiUrl, cookieHeader, id);
    expect(afterRace.nodes.some((node) => node.data['text'] === 'сервер изменился снова')).toBe(
      true,
    );

    await Promise.all([
      stalePage.waitForNavigation(),
      stalePage.getByTestId('board-conflict-overwrite').click(),
    ]);
    await expect(stalePage.locator('.react-flow__node-note textarea')).toHaveValue(
      'локальная версия',
    );
    const after = await readBoardDocument(context.request, apiUrl, cookieHeader, id);
    expect(after.__rev).toBe((before.__rev ?? 0) + 2);
    expect(after.nodes.some((node) => node.data['text'] === 'локальная версия')).toBe(true);
    expect(after.nodes.some((node) => node.data['text'] === 'серверная версия')).toBe(false);
  });
});

const mediaNode = (nid: string, x: number) => ({
  id: nid,
  type: 'media',
  position: { x, y: 80 },
  data: { url: `http://example.test/${nid}.png`, mediaKind: 'image' },
});
const genNode = (nid: string, mode: 'video' | 'image', x: number) => ({
  id: nid,
  type: 'generate',
  position: { x, y: 320 },
  data: { mode, prompt: '', status: 'idle' },
});
const refEdge = (eid: string, src: string, slot: string) => ({
  id: eid,
  source: src,
  target: 'g1',
  sourceHandle: 'out',
  targetHandle: slot,
  animated: true,
});

test.describe('reference slots', () => {
  test('one wired ref shows an extra empty slot; video caps at 2', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [mediaNode('m1', 80), genNode('g1', 'video', 460)],
      edges: [refEdge('e1', 'm1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // slot 0 occupied → slot 1 appears; video caps at 2 so no slot 2
    await expect(gen.locator('[data-handleid="images[0]"]')).toBeVisible();
    await expect(gen.locator('[data-handleid="images[1]"]')).toBeVisible();
    await expect(gen.locator('[data-handleid="images[2]"]')).toHaveCount(0);
    // the wired edge renders
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('image mode grows past 2 slots (cap 14)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [mediaNode('m1', 40), mediaNode('m2', 240), genNode('g1', 'image', 520)],
      edges: [refEdge('e1', 'm1', 'images[0]'), refEdge('e2', 'm2', 'images[1]')],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // two occupied → a third empty slot appears (image cap is 14)
    await expect(gen.locator('[data-handleid="images[0]"]')).toBeVisible();
    await expect(gen.locator('[data-handleid="images[1]"]')).toBeVisible();
    await expect(gen.locator('[data-handleid="images[2]"]')).toBeVisible();
  });

  test('legacy single «images» edge migrates to images[0] on load', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [mediaNode('m1', 80), genNode('g1', 'video', 460)],
      edges: [refEdge('e1', 'm1', 'images')], // pre-slot board
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // normalizeRefEdges remaps images → images[0], so slot 1 appears and the edge still renders
    await expect(gen.locator('[data-handleid="images[0]"]')).toBeVisible();
    await expect(gen.locator('[data-handleid="images[1]"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
});

test.describe('typed edges', () => {
  test('edge shows a payload-type chip and a midpoint remove handle', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [mediaNode('m1', 80), genNode('g1', 'video', 460)],
      edges: [refEdge('e1', 'm1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();

    // Edge renders with the model-aware semantic role. A still wired into the
    // first video slot is more useful as «первый кадр» than generic «картинка».
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.locator('.react-flow__edgelabel-renderer')).toContainText('первый кадр');

    // midpoint remove handle deletes the edge (Delete-key path is covered separately)
    await page.getByTestId('edge-remove-e1').click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);

    // and it's undoable
    await page.locator('.react-flow__pane').click({ position: { x: 40, y: 420 } });
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
});

interface MockBoardJob {
  jobId: string;
  prompt: string;
}

async function mockBoardJobs(page: Page, takesPerJob = 1, assetExtension = 'png') {
  const submitted: MockBoardJob[] = [];
  const completed = new Set<string>();
  const failed = new Map<string, { errorCode: string; errorMessage: string }>();
  await page.route(/\/v1\/jobs(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/v1/jobs' && request.method() === 'POST') {
      const body = request.postDataJSON() as { prompt?: string };
      const jobId = `mock-job-${submitted.length + 1}`;
      submitted.push({ jobId, prompt: body.prompt ?? '' });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId }),
      });
      return;
    }
    const match = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname);
    if (match && match[1] !== 'events' && request.method() === 'GET') {
      const jobId = match[1]!;
      const done = completed.has(jobId);
      const failure = failed.get(jobId);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: jobId,
          status: failure ? 'failed' : done ? 'succeeded' : 'running',
          resultAssets: done
            ? Array.from(
                { length: takesPerJob },
                (_, i) => `http://example.test/${jobId}${i ? `-${i + 1}` : ''}.${assetExtension}`,
              )
            : [],
          ...(failure ?? {}),
        }),
      });
      return;
    }
    await route.continue();
  });

  return {
    submitted,
    complete: async (jobId: string) => {
      completed.add(jobId);
      await page.evaluate((id) => {
        window.dispatchEvent(
          new CustomEvent('seed:job-event', {
            detail: { jobId: id, status: 'succeeded', source: 'generation' },
          }),
        );
      }, jobId);
    },
    fail: async (jobId: string, errorCode: string, errorMessage: string) => {
      failed.set(jobId, { errorCode, errorMessage });
      await page.evaluate((id) => {
        window.dispatchEvent(
          new CustomEvent('seed:job-event', {
            detail: { jobId: id, status: 'failed', source: 'generation' },
          }),
        );
      }, jobId);
    },
  };
}

// Every board fixture pins a LIVE model id on purpose. `seedream-4-5` was retired on
// 2026-08-10 (seed `isActive: false`), and a node whose persisted pick is no longer in the
// catalogue resolves to no model at all: the run button goes disabled with "Для кадра не
// выбрана доступная модель", every run-all test sits on that click for the full 120s
// timeout, and the gate reads as "slow and flaky" rather than "pointed at a dead row".
const schedulerNode = (id: string, prompt: string, x: number, y: number) => ({
  id,
  type: 'generate',
  position: { x, y },
  data: {
    mode: 'image',
    modelId: 'seedream-5-0-pro',
    prompt,
    imageAspect: '1:1',
    imageQuality: '2K',
    count: 1,
    status: 'idle',
  },
});

test.describe('run-all cost preview', () => {
  test('lists shots upstream-first with a total; cancel runs nothing', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 80, y: 80 },
          data: { mode: 'image', prompt: 'первый кадр', status: 'idle' },
        },
        {
          id: 'g2',
          type: 'generate',
          position: { x: 460, y: 80 },
          data: { mode: 'video', prompt: 'второй кадр', status: 'idle' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'g1',
          target: 'g2',
          sourceHandle: 'out',
          targetHandle: 'images[0]',
          type: 'typed',
          animated: true,
        },
      ],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate').first()).toBeVisible();

    await page.getByTestId('board-run-all').click();
    await expect(page.getByTestId('run-all-dialog')).toBeVisible();

    // upstream shot (feeds the other) listed first
    const rows = page.getByTestId('run-all-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('первый');
    await expect(rows.nth(1)).toContainText('второй');

    // Total is a positive credit figure. It is a SERVER quote per row now, not a
    // local sum, and the sheet deliberately shows «—» until every row has been
    // quoted — so poll for it instead of reading the first paint.
    await expect
      .poll(async () =>
        parseInt((await page.getByTestId('run-all-total').innerText()).replace(/\D/g, '')),
      )
      .toBeGreaterThan(0);
    const total = parseInt(
      (await page.getByTestId('run-all-total').innerText()).replace(/\D/g, ''),
    );

    // cancel → closes, nothing submitted (no node enters running)
    await page.getByTestId('run-all-cancel').click();
    await expect(page.getByTestId('run-all-dialog')).toHaveCount(0);
    await expect(page.getByTestId('board-run-all')).toContainText('Снять всё');
  });

  test('a fully-rendered board has nothing left to shoot', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 120, y: 120 },
          data: {
            mode: 'video',
            prompt: 'готовый кадр',
            status: 'done',
            resultUrl: 'http://example.test/g1.mp4',
            resultKind: 'video',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();

    await page.getByTestId('board-run-all').click();
    await expect(page.getByTestId('run-all-dialog')).toContainText('Все кадры уже сняты');
    await expect(page.getByTestId('run-all-confirm')).toHaveCount(0);
  });

  test('scheduler runs a diamond by dependencies and never double-submits upstream', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const jobs = await mockBoardJobs(page);
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        schedulerNode('root', 'root', 40, 40),
        schedulerNode('left', 'left', 360, 40),
        schedulerNode('right', 'right', 360, 340),
        schedulerNode('leaf', 'leaf', 680, 180),
      ],
      edges: [
        { ...refEdge('root-left', 'root', 'images[0]'), target: 'left' },
        { ...refEdge('root-right', 'root', 'images[0]'), target: 'right' },
        { ...refEdge('left-leaf', 'left', 'images[0]'), target: 'leaf' },
        { ...refEdge('right-leaf', 'right', 'images[1]'), target: 'leaf' },
      ],
    });
    // refEdge defaults to target g1; this graph sets every target explicitly.
    const seeded = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    expect(seeded.ok()).toBe(true);
    await page.goto(`/boards/${id}`);
    await page.getByTestId('board-run-all').click();
    await page.getByTestId('run-all-confirm').click();

    await expect.poll(() => jobs.submitted.map((job) => job.prompt)).toEqual(['root']);
    await page.waitForTimeout(100);
    await jobs.complete(jobs.submitted[0]!.jobId);
    await expect
      .poll(() => jobs.submitted.map((job) => job.prompt).sort())
      .toEqual(['left', 'right', 'root']);

    await page.waitForTimeout(100);
    await jobs.complete(jobs.submitted.find((job) => job.prompt === 'left')!.jobId);
    await page.waitForTimeout(250);
    expect(jobs.submitted.some((job) => job.prompt === 'leaf')).toBe(false);
    await jobs.complete(jobs.submitted.find((job) => job.prompt === 'right')!.jobId);
    await expect
      .poll(() => jobs.submitted.map((job) => job.prompt).sort())
      .toEqual(['leaf', 'left', 'right', 'root']);
    await page.waitForTimeout(100);
    await jobs.complete(jobs.submitted.find((job) => job.prompt === 'leaf')!.jobId);
    await expect(page.getByTestId('board-run-all')).toHaveAttribute('aria-label', 'Снять всё');
    expect(jobs.submitted.filter((job) => job.prompt === 'root')).toHaveLength(1);
  });

  test('generated images stay inside their own card — no loose media cards spawn', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    // Generated stills belong to the shot that made them: the take-strip picks
    // the best one and the card itself is what you wire into a video shot.
    // Loose media cards are for attachments only (audit 2026-07-29).
    //
    // The shot is seeded mid-flight and finished by the job event: that is the
    // exact code path under test, and it needs no model catalogue (the run
    // button is disabled when `models` is empty, as it is on the test DB).
    const jobs = await mockBoardJobs(page, 2);
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...schedulerNode('g1', 'кадр с дублями', 80, 80),
          data: {
            ...schedulerNode('g1', 'кадр с дублями', 80, 80).data,
            status: 'running',
            jobId: 'mock-job-1',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();
    await jobs.complete('mock-job-1');

    const thumbs = page.getByTestId('take-thumb');
    await expect(thumbs).toHaveCount(2);
    await expect(page.locator('.react-flow__node-media')).toHaveCount(0);
    await expect(page.getByTestId('node-result')).toHaveAttribute('src', /mock-job-1\.png/);

    // picking a variant in the strip makes it the card's result — and therefore
    // the reference any downstream video shot consumes.
    await thumbs.nth(1).click();
    await expect(thumbs.nth(1)).toHaveAttribute('data-chosen', 'true');
    await expect(page.getByTestId('node-result')).toHaveAttribute('src', /mock-job-1-2\.png/);
  });

  test('generated videos stay inside their own card — no loose media cards spawn', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const jobs = await mockBoardJobs(page, 2, 'mp4');
    const shot = schedulerNode('g1', 'клип с дублями', 80, 80);
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...shot,
          data: {
            ...shot.data,
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            status: 'running',
            jobId: 'mock-job-1',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();
    await jobs.complete('mock-job-1');

    const takeStrip = page.getByTestId('take-strip');
    await expect(takeStrip).toBeVisible();
    await expect(takeStrip.getByTestId('take-thumb')).toHaveCount(2);
    await expect(takeStrip.locator('video')).toHaveCount(2);
    await expect(page.locator('.react-flow__node-media')).toHaveCount(0);
  });

  test('one failed branch blocks only its descendants while independent work finishes', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const jobs = await mockBoardJobs(page);
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        schedulerNode('root', 'root-fails', 40, 80),
        schedulerNode('child', 'blocked-child', 360, 80),
        schedulerNode('independent', 'independent-finishes', 360, 380),
      ],
      edges: [{ ...refEdge('root-child', 'root', 'images[0]'), target: 'child' }],
    });
    await page.goto(`/boards/${id}`);
    await page.getByTestId('board-run-all').click();
    await page.getByTestId('run-all-confirm').click();
    await expect
      .poll(() => jobs.submitted.map((job) => job.prompt).sort())
      .toEqual(['independent-finishes', 'root-fails']);

    const rootJob = jobs.submitted.find((job) => job.prompt === 'root-fails')!;
    const independentJob = jobs.submitted.find((job) => job.prompt === 'independent-finishes')!;
    await jobs.fail(rootJob.jobId, 'RUNNING_TIMEOUT', 'job reaped after running timeout');
    await jobs.complete(independentJob.jobId);

    await expect(page.getByTestId('board-run-all')).toHaveAttribute('aria-label', 'Снять всё');
    expect(jobs.submitted.some((job) => job.prompt === 'blocked-child')).toBe(false);
    await expect(page.locator('.react-flow__node[data-id="root"]')).toContainText(
      'Кредиты возвращены',
    );
    await expect(
      page.locator('.react-flow__node[data-id="independent"]').getByTestId('node-result'),
    ).toBeVisible();
  });

  test('Stop run leaves in-flight jobs to settle and launches no queued work', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const jobs = await mockBoardJobs(page);
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: Array.from({ length: 5 }, (_, index) =>
        schedulerNode(`independent-${index}`, `shot-${index}`, 40 + index * 260, 120),
      ),
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await page.getByTestId('board-run-all').click();
    await page.getByTestId('run-all-confirm').click();
    await expect.poll(() => jobs.submitted.length).toBe(3);
    await page.waitForTimeout(250);
    expect(jobs.submitted).toHaveLength(3);

    await page.getByTestId('board-run-all').click();
    await expect(page.getByTestId('board-run-all')).toHaveAttribute(
      'aria-label',
      'Остановить запуск',
    );
    for (const job of [...jobs.submitted]) {
      await page.waitForTimeout(100);
      await jobs.complete(job.jobId);
    }
    await expect(page.getByTestId('board-run-all')).toHaveAttribute('aria-label', 'Снять всё');
    await page.waitForTimeout(300);
    expect(jobs.submitted).toHaveLength(3);
  });

  test('reload reconciles a persisted job id without a duplicate submission', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const jobs = await mockBoardJobs(page);
    const running = schedulerNode('running', 'running', 80, 100);
    running.data.status = 'running';
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [running],
      edges: [],
    });
    // The job id is persisted exactly as it would be after a successful submit.
    const board = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const current = (await board.json()) as { state: Record<string, unknown> };
    const state = current.state as { __rev: number; nodes: Record<string, unknown>[] };
    const seededRunning = await context.request.put(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        rev: state.__rev,
        state: {
          ...state,
          nodes: state.nodes.map((node) => ({
            ...node,
            data: { ...(node['data'] as object), status: 'running', jobId: 'persisted-job' },
          })),
        },
      },
    });
    expect(seededRunning.ok()).toBe(true);

    await page.goto(`/boards/${id}`);
    await expect(page.getByTestId('board-run-all')).toHaveAttribute(
      'aria-label',
      'Восстановление задач',
    );
    expect(jobs.submitted).toHaveLength(0);
    await jobs.complete('persisted-job');
    await expect(page.getByTestId('board-run-all')).toHaveAttribute('aria-label', 'Снять всё');
    expect(jobs.submitted).toHaveLength(0);
  });
});

test.describe('node polish', () => {
  test('idle, loading, and recoverable error states stay distinct', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'idle-node',
          type: 'generate',
          position: { x: 40, y: 120 },
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: 'ожидание',
            status: 'idle',
          },
        },
        {
          id: 'loading-node',
          type: 'generate',
          position: { x: 420, y: 120 },
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: 'в процессе',
            status: 'running',
          },
        },
        {
          id: 'failed-node',
          type: 'generate',
          position: { x: 800, y: 120 },
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: 'ошибка',
            status: 'failed',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);

    const shots = page.locator('.react-flow__node-generate');
    await expect(shots).toHaveCount(3);
    await expect(shots.nth(0).getByTestId('node-run')).toBeEnabled();
    await expect(shots.nth(1).locator('.seed-spin')).toHaveCount(2);
    await expect(shots.nth(1).getByTestId('node-run')).toBeDisabled();
    await expect(shots.nth(2)).toContainText('Генерация не завершилась. Повторите запуск.');
    await expect(shots.nth(2).getByTestId('node-run')).toBeEnabled();
  });

  test('terminal provider failure keeps its exact reason and corrective action', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'failed-detail-node',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: 'портрет',
            status: 'running',
            jobId: 'failure-job',
          },
        },
      ],
      edges: [],
    });
    await page.route(`${apiUrl}/v1/jobs/failure-job`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'failure-job',
          status: 'failed',
          resultAssets: [],
          errorCode: 'InputVideoSensitiveContentDetected.PrivacyInformation',
          errorMessage: 'reference may contain a real person',
        }),
      }),
    );

    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('seed:job-event', {
          detail: { jobId: 'failure-job', status: 'failed', source: 'generation' },
        }),
      ),
    );

    const reason = page.getByTestId('node-failure-reason');
    await expect(reason).toContainText('реального человека');
    await expect(reason).toContainText('Замените');
    await expect(reason).not.toContainText('попробуйте ещё раз');

    await expect
      .poll(async () => {
        const response = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
          headers: { cookie: cookieHeader },
        });
        const body = (await response.json()) as {
          state: { nodes: { id: string; data: Record<string, unknown> }[] };
        };
        return body.state.nodes.find((node) => node.id === 'failed-detail-node')?.data;
      })
      .toMatchObject({
        status: 'failed',
        failureAction: 'replace_reference',
        failureMessage: expect.stringContaining('Замените'),
      });
  });

  test('image batch stepper clamps 1–4', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: { mode: 'image', prompt: 'кадр', count: 1, status: 'idle' },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();

    // Tries/batch stepper lives on the node control row (Higgsfield).
    await expect(page.getByTestId('batch-count')).toHaveText('1');
    await expect(page.getByTestId('batch-dec')).toBeDisabled(); // floor
    await page.getByTestId('batch-inc').click();
    await expect(page.getByTestId('batch-count')).toHaveText('2');
    await page.getByTestId('batch-inc').click();
    await page.getByTestId('batch-inc').click();
    await expect(page.getByTestId('batch-count')).toHaveText('4');
    await expect(page.getByTestId('batch-inc')).toBeDisabled(); // ceiling
  });

  test('the node body is a preview screen — placeholder until a take exists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const empty = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: { mode: 'video', prompt: 'кадр', status: 'idle' },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${empty}`);
    const gen0 = page.locator('.react-flow__node-generate');
    await expect(gen0).toBeVisible();
    // The body is now a preview "screen" (§4) — no inline prompt textarea, and
    // an empty node shows the placeholder, not a take.
    await expect(page.getByTestId('node-screen')).toBeVisible();
    await expect(page.getByTestId('node-generate-prompt')).toHaveCount(0);
    await expect(gen0.locator('video')).toHaveCount(0);

    const done = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: {
            mode: 'video',
            prompt: 'кадр',
            status: 'done',
            resultUrl: 'http://example.test/g1.mp4',
            resultKind: 'video',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${done}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();
    // The take fills the screen automatically (no tab to flip).
    await expect(page.getByTestId('node-screen').locator('video')).toBeVisible();
  });

  test('the card body drags the node; the controls do not', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 200, y: 200 },
          data: { mode: 'video', prompt: 'кадр', status: 'idle' },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // dragging the preview screen (the card body) MOVES the node
    const screen = page.getByTestId('node-screen');
    const sb = (await screen.boundingBox())!;
    const before = (await gen.boundingBox())!;
    await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2 + 200, sb.y + sb.height / 2 + 140, { steps: 12 });
    await page.mouse.up();
    const afterBody = (await gen.boundingBox())!;
    expect(Math.abs(afterBody.x - before.x)).toBeGreaterThan(120);

    // dragging a control (the model trigger, nodrag) must NOT move the node
    const moved = (await gen.boundingBox())!;
    const trig = (await page.getByTestId('node-model-trigger').boundingBox())!;
    await page.mouse.move(trig.x + trig.width / 2, trig.y + trig.height / 2);
    await page.mouse.down();
    await page.mouse.move(trig.x + 160, trig.y + 120, { steps: 8 });
    await page.mouse.up();
    const afterCtrl = (await gen.boundingBox())!;
    expect(Math.abs(afterCtrl.x - moved.x)).toBeLessThan(8);
  });

  test('drag rails move every widget type while controls keep their own gestures', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'p1',
          type: 'prompt',
          position: { x: 120, y: 120 },
          data: { text: 'prompt text' },
        },
        {
          id: 'ai1',
          type: 'aiprompt',
          position: { x: 430, y: 120 },
          data: { brief: 'brief', model: 'claude', status: 'idle', view: 'brief' },
        },
        {
          id: 'n1',
          type: 'note',
          position: { x: 740, y: 120 },
          data: { text: 'note' },
        },
        {
          id: 'm1',
          type: 'media',
          position: { x: 120, y: 420 },
          data: { url: 'http://example.test/m1.png', mediaKind: 'image' },
        },
        {
          id: 'c1',
          type: 'cast',
          position: { x: 430, y: 420 },
          data: { castKind: 'character', name: 'Алиса', imageUrls: [], videoUrl: undefined },
        },
      ],
      edges: [],
      viewport: { x: 40, y: 30, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);

    for (const selector of [
      '.react-flow__node-prompt',
      '.react-flow__node-aiprompt',
      '.react-flow__node-note',
      '.react-flow__node-media',
      '.react-flow__node-cast',
    ]) {
      const node = page.locator(selector);
      await expect(node).toBeVisible();
      const before = (await node.boundingBox())!;
      const dragTarget =
        selector === '.react-flow__node-cast'
          ? node.getByTestId('node-cast-header')
          : node.getByTestId('node-drag-rail-bottom');
      const rail = (await dragTarget.boundingBox())!;
      await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2);
      await page.mouse.down();
      await page.mouse.move(rail.x + rail.width / 2 + 120, rail.y + rail.height / 2 + 60, {
        steps: 10,
      });
      await page.mouse.up();
      const after = (await node.boundingBox())!;
      expect(
        Math.abs(after.x - before.x),
        `${selector} should move from rail drag`,
      ).toBeGreaterThan(60);
    }

    // Grab the bare GRIP, not the footer's geometric centre: the footer also
    // holds `nodrag` buttons, and a longer CTA label legitimately moves the
    // centre onto one of them (2026-07-27, the «· N кр.» price did exactly
    // that). The grip is the affordance, so assert its size and drag it.
    const ai = page.locator('.react-flow__node-aiprompt');
    const aiBefore = (await ai.boundingBox())!;
    const grip = (await ai.getByTestId('ai-footer-grip').boundingBox())!;
    expect(grip.width, 'the footer drag grip must stay grabbable').toBeGreaterThanOrEqual(72);
    const aiFooter = grip;
    await page.mouse.move(aiFooter.x + aiFooter.width / 2, aiFooter.y + aiFooter.height / 2);
    await page.mouse.down();
    await page.mouse.move(aiFooter.x + aiFooter.width / 2 + 140, aiFooter.y + aiFooter.height / 2, {
      steps: 10,
    });
    await page.mouse.up();
    const aiAfter = (await ai.boundingBox())!;
    expect(Math.abs(aiAfter.x - aiBefore.x), 'AI prompt footer gap should drag').toBeGreaterThan(
      80,
    );
  });
});

test.describe('keyboard shortcuts', () => {
  test('? and the rail button open the shortcuts sheet; Esc closes', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await focusPane(page);

    await page.keyboard.press('Shift+/'); // '?'
    await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-sheet')).toHaveCount(0);

    await page.getByTestId('rail-help').click();
    await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
  });

  test('Ctrl+D duplicates the selection', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const node = page.locator('.react-flow__node-prompt');
    const h = (await page.getByTestId('node-prompt-header').boundingBox())!;
    await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2); // select via the title above
    await expect(node).toHaveClass(/selected/);
    await page.keyboard.press('Control+d');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(2);
  });

  test('wheel over a long prompt scrolls the card, not the canvas zoom', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const text = page.getByTestId('node-prompt-text');
    await text.fill(Array.from({ length: 60 }, (_, i) => `строка промпта ${i + 1}`).join('\n'));
    const zoomBefore = await getZoom(page);
    const box = (await text.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);

    await expect
      .poll(() => text.evaluate((el) => (el as HTMLTextAreaElement).scrollTop))
      .toBeGreaterThan(0);
    expect(await getZoom(page)).toBe(zoomBefore);

    // an empty card has nothing to scroll, so the wheel still zooms the canvas
    await text.fill('коротко');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => getZoom(page)).not.toBe(zoomBefore);
  });

  test('Ctrl+C / Ctrl+V copies cards, including onto another board', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    const other = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);
    await page.getByTestId('node-prompt-text').fill('скопируй меня');

    const h = (await page.getByTestId('node-prompt-header').boundingBox())!;
    await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2); // select via the title above
    await expect(page.locator('.react-flow__node-prompt')).toHaveClass(/selected/);
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(2);
    await expect(page.getByTestId('node-prompt-text').nth(1)).toHaveValue('скопируй меня');

    // paste is undoable, and the buffer survives moving to another board
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
    await page.goto(`/boards/${other}`);
    await focusPane(page);
    await page.keyboard.press('Control+v');
    await expect(page.getByTestId('node-prompt-text')).toHaveValue('скопируй меня');
  });

  test('Ctrl+C / Ctrl+V round-trips a multi-card selection', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);
    await page.getByTestId('board-add').click();
    await page.getByTestId('add-note').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    const promptHeader = (await page.getByTestId('node-prompt-header').boundingBox())!;
    const noteHeader = (await page.getByTestId('node-note-header').boundingBox())!;
    await page.mouse.click(
      promptHeader.x + promptHeader.width / 2,
      promptHeader.y + promptHeader.height / 2,
    );
    await page.keyboard.down('Control');
    await page.mouse.click(
      noteHeader.x + noteHeader.width / 2,
      noteHeader.y + noteHeader.height / 2,
    );
    await page.keyboard.up('Control');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
    // Adding the note leaves its textarea focused; move focus to a board
    // control so this gesture exercises the canvas shortcut, not native text copy.
    await page.getByTestId('board-add').focus();
    await page.keyboard.press('Control+c');
    await page.keyboard.press('Control+v');
    // The canvas virtualises (`onlyRenderVisibleElements`), so a pasted card can
    // land off-screen and never reach the DOM. Fit to content first, or this
    // counts what is rendered instead of what is on the board.
    await page.getByTestId('rail-fit').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(4);

    await page.keyboard.press('Control+z');
    await page.getByTestId('rail-fit').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
  });

  test('Ctrl+X removes the selection as one undoable action', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const header = (await page.getByTestId('node-prompt-header').boundingBox())!;
    await page.mouse.click(header.x + header.width / 2, header.y + header.height / 2);
    await page.keyboard.press('Control+x');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(0);

    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  });

  test('Delete and Backspace stay in a focused textarea', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const textarea = page.getByTestId('node-prompt-text');
    const header = (await page.getByTestId('node-prompt-header').boundingBox())!;
    await page.mouse.click(header.x + header.width / 2, header.y + header.height / 2);
    await expect(page.locator('.react-flow__node-prompt')).toHaveClass(/selected/);
    await textarea.fill('текст');
    await textarea.press('End');
    await textarea.press('Backspace');
    await textarea.press('Home');
    await textarea.press('Delete');

    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
    await expect(textarea).toHaveValue('екс');
  });

  test('Ctrl+A then Delete is fully undoable (no unrecoverable wipe)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);
    await page.getByTestId('board-add').click();
    await page.getByTestId('add-note').click();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);

    await focusPane(page);
    await page.keyboard.press('Control+a');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);

    await page.keyboard.press('Delete');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    // the hazard both playbooks flag — here it's recoverable
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
  });
});

test.describe('board undo/redo', () => {
  test('add node → Ctrl+Z removes it → Ctrl+Shift+Z restores it', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    await focusPane(page);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(0);

    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  });

  test('a typing burst undoes as ONE step, not per keystroke', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const textarea = page.getByTestId('node-prompt-text');
    await textarea.click();
    await page.keyboard.type('дождь в городе', { delay: 25 });
    await expect(textarea).toHaveValue('дождь в городе');

    await focusPane(page);
    await page.keyboard.press('Control+z');
    // one undo reverts the whole burst; the node itself is still there
    await expect(textarea).toHaveValue('');
    await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  });

  test('Delete-key removal is undoable', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    // select via the floating title (the textarea would swallow Delete)
    const node = page.locator('.react-flow__node-prompt');
    const h = (await page.getByTestId('node-prompt-header').boundingBox())!;
    await page.mouse.click(h.x + h.width / 2, h.y + h.height / 2);
    await page.keyboard.press('Delete');
    await expect(node).toHaveCount(0);

    await page.keyboard.press('Control+z');
    await expect(node).toHaveCount(1);
  });

  test('node drag is undoable back to the original position', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await addPromptNode(page);

    const node = page.locator('.react-flow__node-prompt');
    const before = (await node.boundingBox())!;
    const h = (await page.getByTestId('node-prompt-header').boundingBox())!;
    const hx = h.x + h.width / 2;
    const hy = h.y + h.height / 2;
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 220, hy + 130, { steps: 10 });
    await page.mouse.up();

    const after = (await node.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(100);

    await focusPane(page);
    await page.keyboard.press('Control+z');
    const restored = (await node.boundingBox())!;
    expect(Math.abs(restored.x - before.x)).toBeLessThan(2);
    expect(Math.abs(restored.y - before.y)).toBeLessThan(2);
  });
});

/* ----------------------------------------------------------------------- *
 *  Per-node settings drawer + model picker (P9). All UI/persistence/cost —
 *  NO generation job is ever submitted (zero credit spend).
 * ----------------------------------------------------------------------- */
const onlyDigits = (s: string) => parseInt(s.replace(/\D/g, ''), 10);

test.describe('per-node settings (P9)', () => {
  test('video gear opens a drawer; a changed setting survives reload', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [genNode('g1', 'video', 160)],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // closed; the gear swaps the body for the settings panel (in-widget).
    await expect(page.getByTestId('node-settings-popover')).toHaveCount(0);
    await page.getByTestId('node-settings-open').click();
    const pop = page.getByTestId('node-settings-popover');
    await expect(pop).toBeVisible();

    // Seedance Fast is capped at 720p: change resolution → 480p, aspect → 16:9,
    // duration → 10 с and verify the exact supported values persist.
    await pop.getByTestId('vres').click();
    await page.getByTestId('vres-480p').click();
    await pop.getByTestId('vaspect').click();
    await page.getByTestId('vaspect-16:9').click();
    await pop.getByTestId('vduration').click();
    await page.getByTestId('vduration-10').click();
    await expect(pop.getByTestId('vres')).toContainText('480p');
    await expect(pop.getByTestId('vduration')).toContainText('10');

    // wait for the debounced PUT to land, then reload from the server
    await page.waitForTimeout(1300);
    await page.reload();
    const gen2 = page.locator('.react-flow__node-generate');
    await expect(gen2).toBeVisible();
    await page.getByTestId('node-settings-open').click();
    const pop2 = page.getByTestId('node-settings-popover');
    await expect(pop2.getByTestId('vres')).toContainText('480p');
    await expect(pop2.getByTestId('vaspect')).toContainText('16:9');
    await expect(pop2.getByTestId('vduration')).toContainText('10');

    // verify it persisted on the server, not just in the DOM
    const res = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const board = (await res.json()) as { state: { nodes: { data: Record<string, unknown> }[] } };
    const data = board.state.nodes[0]!.data;
    expect(data['durationSeconds']).toBe(10);
    expect(data['videoResolution']).toBe('480p');
    expect(data['videoAspect']).toBe('16:9');
  });

  test('image node exposes ratio + resolution (not video fields)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'image', 160),
          data: {
            mode: 'image',
            // The `lite` row, not `pro`: this test drives the ladder to 4K, and 5.0 pro
            // stops at 2K. Lite carries the 2K/3K/4K ladder the retired 4.5 row had.
            modelId: 'seedream-5-0-lite',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();
    await page.getByTestId('node-settings-open').click();
    const pop = page.getByTestId('node-settings-popover');

    // Seedream declares aspect + resolution dropdowns; no video duration field.
    await expect(pop.getByTestId('iquality')).toBeVisible();
    await expect(pop.getByTestId('iaspect')).toBeVisible();
    await expect(pop.getByTestId('vduration')).toHaveCount(0);

    // switch resolution → 4K, aspect → portrait, confirm it persists
    await pop.getByTestId('iquality').click();
    await page.getByTestId('iquality-4K').click();
    await pop.getByTestId('iaspect').click();
    await page.getByTestId('iaspect-9:16').click();
    await page.waitForTimeout(1300);

    const res = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const board = (await res.json()) as { state: { nodes: { data: Record<string, unknown> }[] } };
    expect(board.state.nodes[0]!.data['imageQuality']).toBe('4K');
    expect(board.state.nodes[0]!.data['imageAspect']).toBe('9:16');
  });

  // Was written against flux-2-pro on 2026-07-12, when that row declared no controls.
  // `237ad331` moved Flux to kie primary and opened `resolutions: ['1K','2K']` plus a
  // seven-value aspect enum, so the popover started offering both — correctly — and this
  // test failed in prod CI on a claim the catalogue no longer makes. recraft-v4 is the
  // live image row that genuinely declares neither (`resolutions: []`, no `aspect_ratios`),
  // so the assertion is about the CONTROL GATE again rather than about one model's menu.
  test('an image model without size controls does not offer inert settings', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'image', 160),
          data: {
            mode: 'image',
            modelId: 'recraft-v4',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await page.getByTestId('node-settings-open').click();
    const pop = page.getByTestId('node-settings-popover');
    await expect(pop.getByTestId('iaspect')).toHaveCount(0);
    await expect(pop.getByTestId('iquality')).toHaveCount(0);
    await expect(pop).toContainText('Формат и разрешение определяет выбранная модель');
  });

  // The other half of the same gate, and the behaviour the stale test above was reading
  // as a defect: a row that DOES declare a menu must offer it. Pins Flux's opened 2K rung
  // so the next catalogue move has to face this test rather than silently pass one that
  // asserts the opposite.
  test('an image model that declares a menu offers it — flux 2K', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'image', 160),
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await page.getByTestId('node-settings-open').click();
    const pop = page.getByTestId('node-settings-popover');
    await expect(pop.getByTestId('iquality')).toBeVisible();
    await expect(pop.getByTestId('iaspect')).toBeVisible();

    await pop.getByTestId('iquality').click();
    await page.getByTestId('iquality-2K').click();
    await page.waitForTimeout(1300);

    const res = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const board = (await res.json()) as { state: { nodes: { data: Record<string, unknown> }[] } };
    expect(board.state.nodes[0]!.data['imageQuality']).toBe('2K');
  });

  test('a model-managed video route hides unsupported controls and explains fixed audio', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'video', 160),
          data: {
            mode: 'video',
            modelId: 'gemini-omni-flash',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await page.getByTestId('node-settings-open').click();
    const pop = page.getByTestId('node-settings-popover');
    await expect(pop.getByTestId('vduration')).toBeVisible();
    // Omni now exposes concrete aspect_ratios ['16:9','9:16'] (kie requires one),
    // so the aspect selector renders instead of the "model decides format" note.
    await expect(pop.getByTestId('vaspect')).toBeVisible();
    await expect(pop.getByTestId('vres')).toHaveCount(0);
    await expect(pop.getByTestId('vaudio')).toHaveCount(0);
    await expect(pop).toContainText('Звук создаётся автоматически');
  });

  test('model picker lists video models and changing it updates the cost', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      // default video model is the mid-priced seedance-2-0-fast
      nodes: [
        { ...genNode('g1', 'video', 160), data: { mode: 'video', prompt: 'кадр', status: 'idle' } },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();

    // The node cost is a server quote (debounced + a round trip), not the instant
    // local number it used to be, so wait for it exactly as the reroll assertion
    // below already does. The asserted value is unchanged.
    await expect
      .poll(async () => onlyDigits(await page.getByTestId('node-cost').innerText()))
      .toBeGreaterThan(0);
    const costBefore = onlyDigits(await page.getByTestId('node-cost').innerText());

    // The model name bar is the pressable switcher now (Runway pattern).
    await page.getByTestId('node-model-trigger').click();

    // the picker offers active video models only (image and inactive models are excluded)
    await expect(page.getByTestId('node-model-seedance-2-0-fast')).toBeVisible();
    await expect(page.getByTestId('node-model-seedance-2-0')).toBeVisible();
    await expect(page.getByTestId('node-model-seedance-1-0-pro-fast')).toHaveCount(0);
    await expect(page.getByTestId('node-model-seedream-5-0-pro')).toHaveCount(0);

    // pick the priciest model (seedance-2-0, 320/sec) → cost must rise
    await page.getByTestId('node-model-seedance-2-0').click();
    await expect
      .poll(async () => onlyDigits(await page.getByTestId('node-cost').innerText()))
      .toBeGreaterThan(costBefore);
    const costPricey = onlyDigits(await page.getByTestId('node-cost').innerText());

    // return to the cheaper active model → cost must drop
    await page.getByTestId('node-model-trigger').click();
    await page.getByTestId('node-model-seedance-2-0-fast').click();
    await expect
      .poll(async () => onlyDigits(await page.getByTestId('node-cost').innerText()))
      .toBeLessThan(costPricey);

    // persisted choice survives reload
    await page.waitForTimeout(1300);
    const res = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const board = (await res.json()) as { state: { nodes: { data: Record<string, unknown> }[] } };
    expect(board.state.nodes[0]!.data['modelId']).toBe('seedance-2-0-fast');
  });
});

test.describe('model-aware graph diagnostics (BRD-2)', () => {
  test('image wires expose first/last-frame roles for the selected video model', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        mediaNode('m1', 40),
        mediaNode('m2', 240),
        {
          ...genNode('g1', 'video', 540),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'кадр',
            status: 'idle',
          },
        },
      ],
      edges: [refEdge('first-edge', 'm1', 'images[0]'), refEdge('last-edge', 'm2', 'images[1]')],
    });
    await page.goto(`/boards/${id}`);

    await expect(page.getByTestId('edge-role-first-edge')).toHaveText('первый кадр');
    await expect(page.getByTestId('edge-role-last-edge')).toHaveText('последний кадр');
    const shot = page.getByTestId('generate-node-shell');
    await expect(shot.getByText('первый кадр', { exact: true })).toBeVisible();
    await expect(shot.getByText('последний кадр', { exact: true })).toBeVisible();
    await page.getByTestId('node-settings-open').click();
    await expect(page.getByTestId('image-input-mode')).toHaveAttribute('data-mode', 'frame');
    await expect(page.getByTestId('image-input-mode')).toContainText(
      'Backend получает каждое изображение с этой ролью',
    );
    await page.getByTestId('swap-frame-inputs').click();
    await expect(page.getByTestId('edge-role-first-edge')).toHaveText('последний кадр');
    await expect(page.getByTestId('edge-role-last-edge')).toHaveText('первый кадр');
    await page.getByTestId('node-settings-close').click();
    await expect(page.getByTestId('node-run')).toBeEnabled();
  });

  test('an incompatible stored edge highlights its edge and port and disables Run', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        castNode('c1', 'character', 60, {
          name: 'Алиса',
          imageUrls: ['http://example.test/alice.png'],
        }),
        {
          ...genNode('g1', 'video', 520),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'кадр',
            status: 'idle',
          },
        },
      ],
      edges: [refEdge('invalid-cast', 'c1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);

    await expect(page.getByTestId('generate-node-shell')).toHaveAttribute('data-invalid', 'true');
    await expect(page.getByTestId('edge-role-invalid-cast')).toHaveAttribute(
      'data-invalid',
      'true',
    );
    await expect(page.getByTestId('edge-role-invalid-cast')).toHaveText('ошибка');
    await expect(page.getByTestId('node-invalid-reason')).toContainText('отдельный кадр');
    await expect(
      page.locator('.react-flow__node-generate [data-handleid="images[0]"]'),
    ).toHaveAttribute('data-invalid', 'true');
    await expect(page.getByTestId('node-run')).toBeDisabled();
    await expect(page.getByTestId('board-run-all')).toBeDisabled();
  });

  test('an unsupported stored setting names the problem and repairs every normalized value', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'video', 320),
          data: {
            mode: 'video',
            modelId: 'veo-3-1-lite',
            prompt: 'кадр',
            status: 'idle',
            durationSeconds: 7,
            videoResolution: '480p',
            videoAspect: '21:9',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);

    await expect(page.getByTestId('generate-node-shell')).toHaveAttribute('data-invalid', 'true');
    await expect(page.getByTestId('node-invalid-reason')).toContainText('длительность 6 с');
    await expect(page.getByTestId('node-run')).toBeDisabled();

    await page.getByTestId('node-repair-settings').click();
    await expect(page.getByTestId('generate-node-shell')).toHaveAttribute('data-invalid', 'false');
    await expect(page.getByTestId('node-run')).toBeEnabled();

    await expect
      .poll(async () => {
        const response = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
          headers: { cookie: cookieHeader },
        });
        const board = (await response.json()) as {
          state: { nodes: { data: Record<string, unknown> }[] };
        };
        return board.state.nodes[0]!.data;
      })
      .toMatchObject({
        durationSeconds: 6,
        videoResolution: '720p',
        videoAspect: '16:9',
      });
  });

  test('an incompatible drop explains the rejection next to the attempted port', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...castNode('c1', 'character', 60, {
            name: 'Алиса',
            imageUrls: ['http://example.test/alice.png'],
          }),
          // Keep the source handle below the fixed title/gateway toolbar so
          // the pointer-down reaches React Flow rather than the overlay.
          position: { x: 60, y: 320 },
        },
        {
          ...genNode('g1', 'video', 520),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'кадр',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const source = page.locator('.react-flow__node-cast [data-handleid="out"]');
    const target = page.locator('.react-flow__node-generate [data-handleid="images[0]"]');
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2);
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 14 });
    await page.mouse.up();

    await expect(page.getByTestId('port-rejection')).toContainText('отдельный кадр');
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('model switch previews impact, preserves data on cancel, and removes edges only explicitly', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        castNode('c1', 'character', 60, {
          name: 'Алиса',
          imageUrls: ['http://example.test/alice.png'],
        }),
        {
          ...genNode('g1', 'video', 520),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast-reference-to-video',
            prompt: 'кадр',
            status: 'idle',
          },
        },
      ],
      edges: [refEdge('cast-edge', 'c1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.getByTestId('edge-role-cast-edge')).toHaveText('объект');

    await page.getByTestId('node-model-trigger').click();
    await page.getByTestId('node-model-seedance-2-0-fast').click();
    const dialog = page.getByTestId('model-change-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Несовместимые входы · 1');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.getByTestId('model-change-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await page.getByTestId('node-model-trigger').click();
    await page.getByTestId('node-model-seedance-2-0-fast').click();
    await page.getByTestId('model-change-apply').click();
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
    // the catalogue display name, not the raw slug — one name on every surface
    await expect(page.getByTestId('node-model-trigger')).toContainText('Seedance 2.0 Fast');

    await focusPane(page);
    await page.keyboard.press('Control+z');
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByTestId('edge-role-cast-edge')).toHaveText('объект');
  });
});

/* ------------------------------------------------------------------ *
 *  Cast nodes — Персонаж / Локация + «Состав» panel (previz S2).
 *  State-seeded; no jobs are submitted (zero credit spend).
 * ------------------------------------------------------------------ */
const castNode = (
  nid: string,
  castKind: 'character' | 'location' | 'product',
  x: number,
  data: Record<string, unknown> = {},
) => ({
  id: nid,
  type: 'cast',
  position: { x, y: 80 },
  data: { castKind, name: '', imageUrls: [], ...data },
});

test.describe('cast nodes (previz S2)', () => {
  test('seeded Персонаж renders: name, stills, out-port; edge keeps its identity-pack role', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        castNode('c1', 'character', 60, {
          name: 'Алиса',
          imageUrls: ['http://example.test/alice.png'],
        }),
        {
          ...genNode('g1', 'video', 480),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast-reference-to-video',
            prompt: 'кадр',
            status: 'idle',
          },
        },
      ],
      edges: [refEdge('e1', 'c1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);

    const cast = page.getByTestId('cast-node-character');
    await expect(cast).toBeVisible();
    await expect(cast.getByTestId('cast-name')).toHaveValue('Алиса');
    // ready cast (≥1 still) exposes its source handle and the edge renders typed
    await expect(cast.locator('[data-handleid="out"]')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByTestId('edge-role-e1')).toHaveText('объект');
    await expect(page.getByTestId('cast-route-support')).toHaveAttribute(
      'data-support',
      'specialized',
    );
    await expect(page.getByTestId('cast-route-support')).toContainText(
      'без гарантии точного совпадения',
    );

    // The persistent bottom toolbar can overlap controls on a node near the
    // montage tray after the initial whole-board fit. Exercise the shipped
    // select + "focus selected" path before opening the node settings; the
    // final action remains a real pointer click (not a force-click bypass).
    await page.getByTestId('node-generate-header').click();
    await page.getByTestId('rail-zoom-selection').click();
    await page.getByTestId('node-settings-open').click();
    await expect(page.getByTestId('image-input-mode')).toHaveAttribute('data-mode', 'reference');
    await expect(page.getByTestId('image-input-mode')).toContainText('без ролей first/last');
  });

  test('Локация exposes the motion-ref control; the out-port is always present', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [castNode('c1', 'location', 60)],
      edges: [],
    });
    await page.goto(`/boards/${id}`);

    const cast = page.getByTestId('cast-node-location');
    await expect(cast).toBeVisible();
    await expect(cast.getByTestId('cast-add-motion')).toBeVisible();
    // out-port renders even with no stills so a planned (drag-to-create) wire
    // is visible immediately; isValid still blocks a manual wire until ready.
    await expect(cast.locator('[data-handleid="scene"]')).toHaveCount(1);
    await expect(cast.locator('[data-handleid="out"]')).toHaveCount(1);
  });

  test('«Состав» panel lists cast subject-first and persists a rename', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        castNode('l1', 'location', 60, { name: 'Кафе у моря' }),
        castNode('c1', 'character', 320, {
          name: 'Алиса',
          imageUrls: ['http://example.test/alice.png'],
        }),
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.getByTestId('cast-node-character')).toBeVisible();

    await page.getByTestId('board-cast').click();
    const panel = page.getByTestId('cast-panel');
    await expect(panel).toBeVisible();
    // characters sort above locations (subject-first, mirroring ref order)
    const rows = panel.locator('[data-testid^="cast-row-"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Алиса');
    await expect(rows.nth(1)).toContainText('Кафе у моря');
    // saved-characters section is reachable
    await expect(panel.getByTestId('cast-from-saved')).toBeVisible();

    // rename on the node persists through the board autosave
    await page.getByTestId('cast-node-character').getByTestId('cast-name').fill('Алиса Грей');
    await page.waitForTimeout(1300);
    const res = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const board = (await res.json()) as {
      state: { nodes: { id: string; data: Record<string, unknown> }[] };
    };
    const c1 = board.state.nodes.find((n) => n.id === 'c1');
    expect(c1?.data['name']).toBe('Алиса Грей');
  });
});

/* ------------------------------------------------------------------ *
 *  Typed motion references preserve their media role on the canvas.
 * ------------------------------------------------------------------ */
test.describe('board media references', () => {
  test('a seeded video media ref renders into a video shot (motion ref, видео chip)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'm1',
          type: 'media',
          position: { x: 60, y: 80 },
          data: { url: 'http://example.test/motion.mp4', mediaKind: 'video' },
        },
        genNode('g1', 'video', 480),
      ],
      edges: [refEdge('e1', 'm1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    // the chip reads the SOURCE payload type — видео (motion ref)
    // generous timeout: edge-chip labels render late under full-suite load
    await expect(page.locator('.react-flow__viewport')).toContainText('видео', {
      timeout: 30_000,
    });
  });
});

/* ------------------------------------------------------------------ *
 *  Экспорт — раскадровка PDF + ссылка для читки + аниматик (previz S5).
 * ------------------------------------------------------------------ */
test.describe('storyboard export (previz S5)', () => {
  test('share link mints a working public PDF; animatic disabled without renders', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        castNode('c1', 'character', 60, {
          name: 'Алиса',
          imageUrls: ['http://example.test/alice.png'],
        }),
        genNode('g1', 'video', 480),
      ],
      edges: [refEdge('e1', 'c1', 'images[0]')],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.locator('.react-flow__node-generate')).toBeVisible();

    await page.getByTestId('board-export').click();
    const menu = page.getByTestId('export-menu');
    await expect(menu).toBeVisible();

    // owner PDF link points at the API route
    await expect(menu.getByTestId('export-storyboard-pdf')).toHaveAttribute(
      'href',
      `${apiUrl}/v1/boards/${id}/storyboard.pdf`,
    );
    // no rendered shots → animatic disabled
    await expect(menu.getByTestId('export-animatic')).toBeDisabled();

    // mint the share link; the public route must answer with a real PDF
    await menu.getByTestId('export-share').click();
    await expect(menu).toContainText(`${apiUrl}/v1/storyboard/sb-`);
    const shown = await menu.locator('p.break-all').innerText();
    const pub = await context.request.get(shown.trim());
    expect(pub.status()).toBe(200);
    expect(pub.headers()['content-type']).toContain('application/pdf');
    expect((await pub.body()).subarray(0, 4).toString()).toBe('%PDF');

    // owner route also serves the PDF (with the session cookie)
    const own = await context.request.get(`${apiUrl}/v1/boards/${id}/storyboard.pdf`, {
      headers: { cookie: cookieHeader },
    });
    expect(own.status()).toBe(200);
    expect(own.headers()['content-type']).toContain('application/pdf');
  });

  test('a completed tray opens Studio and provides an obvious return to the Board', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'studio-ready',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'готовый монтажный кадр',
            status: 'done',
            resultUrl: 'http://example.test/studio-ready.mp4',
            resultKind: 'video',
          },
        },
      ],
      edges: [],
      tray: ['studio-ready'],
    });
    await page.goto(`/boards/${id}`);
    await expect(page.getByTestId('board-assemble')).toBeEnabled();
    await page.getByTestId('board-assemble').click();
    await expect(page.getByTestId('studio-sheet')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'К борду' }).click();
    await expect(page.getByTestId('studio-sheet')).toHaveCount(0);
    await expect(page.getByTestId('board-canvas')).toBeVisible();
  });

  test('an unavailable Studio handoff stays on the Board with retryable feedback', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    let handoffs = 0;
    await page.route('**/v1/studio/project', async (route) => {
      handoffs += 1;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'service_unavailable' }),
      });
    });
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'studio-unavailable',
          type: 'generate',
          position: { x: 120, y: 100 },
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'кадр для недоступного монтажа',
            status: 'done',
            resultUrl: 'http://example.test/studio-unavailable.mp4',
            resultKind: 'video',
          },
        },
      ],
      edges: [],
      tray: ['studio-unavailable'],
    });

    await page.goto(`/boards/${id}`);
    await page.getByTestId('board-assemble').click();
    await expect.poll(() => handoffs).toBe(1);
    await expect.soft(page.getByTestId('studio-sheet')).toHaveCount(0);
    await expect.soft(page.getByTestId('board-toast')).toContainText(/не удалось|недоступ/i);
    await expect(page.getByTestId('board-canvas')).toBeVisible();
    await expect(page.getByTestId('board-assemble')).toBeEnabled();

    const stored = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await stored.json()) as { state: { tray: string[] } };
    expect(body.state.tray).toEqual(['studio-unavailable']);
  });
});

/* ------------------------------------------------------------------ *
 *  Temp operator gateway widget (dev) — policy drives the per-shot
 *  `provider` on POST /v1/jobs. Route-intercepted → zero credit spend.
 * ------------------------------------------------------------------ */
test.describe('gateway policy widget (dev)', () => {
  test('a sparse second slot submits an explicit last-frame role', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        mediaNode('last-frame', 80),
        {
          ...genNode('g1', 'video', 460),
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast',
            prompt: 'финальный кадр',
            status: 'idle',
          },
        },
      ],
      edges: [refEdge('last-only', 'last-frame', 'images[1]')],
    });
    let body: Record<string, unknown> | null = null;
    await page.route('**/v1/jobs', async (route) => {
      body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'fake-last-frame' }),
      });
    });

    await page.goto(`/boards/${id}`);
    await page.getByTestId('node-run').click();
    await expect.poll(() => body).not.toBeNull();
    const params = body!['params'] as Record<string, unknown>;
    expect(params['frameImages']).toEqual([
      { role: 'last', url: 'http://example.test/last-frame.png' },
    ]);
    expect(params).not.toHaveProperty('imageUrls');
  });

  test('Авто sends openrouter for a plain shot; AtlasCloud forces atlascloud; persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    // two shots — each runs ONCE (a run leaves the node 'busy' forever here
    // since the fake job never completes, so we can't re-run the same node)
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 120, y: 200 },
          data: { mode: 'video', prompt: 'кит на рассвете', status: 'idle' },
        },
        {
          id: 'g2',
          type: 'generate',
          position: { x: 520, y: 200 },
          data: { mode: 'video', prompt: 'чайка над морем', status: 'idle' },
        },
      ],
      edges: [],
    });

    // capture POST /v1/jobs bodies; fulfill so no real job/spend
    const bodies: Record<string, unknown>[] = [];
    await page.route('**/v1/jobs', async (route) => {
      bodies.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: `fake-${bodies.length}` }),
      });
    });

    await page.goto(`/boards/${id}`);
    const widget = page.getByTestId('gateway-widget');
    if ((await widget.count()) === 0) {
      // Operator routing controls are intentionally absent from production builds.
      await expect(widget).toHaveCount(0);
      return;
    }
    await expect(widget).toBeVisible();
    // default policy is Авто → a plain (no video ref) shot routes to openrouter
    await expect(widget.getByTestId('gateway-auto')).toHaveAttribute('aria-pressed', 'true');

    const g1 = page.locator('.react-flow__node-generate').first();
    await g1.click();
    await g1.getByTestId('node-run').click();
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    expect(bodies[0]!['provider']).toBe('openrouter');

    // force AtlasCloud → the SECOND node's run carries it
    await widget.getByTestId('gateway-atlascloud').click();
    await expect(widget.getByTestId('gateway-atlascloud')).toHaveAttribute('aria-pressed', 'true');
    const g2 = page.locator('.react-flow__node-generate').nth(1);
    await g2.click();
    await g2.getByTestId('node-run').click();
    await expect.poll(() => bodies.length).toBeGreaterThan(1);
    expect(bodies[bodies.length - 1]!['provider']).toBe('atlascloud');

    // policy persists across reload (localStorage)
    await page.reload();
    await expect(
      page.getByTestId('gateway-widget').getByTestId('gateway-atlascloud'),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('connect-drop menu (Runway drag-to-create)', () => {
  test('dragging the prompt input to empty canvas offers a Промпт and wires it', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'video', 480),
          position: { x: 480, y: 280 },
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast-reference-to-video',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    // grab the prompt INPUT handle and release on blank canvas → connect menu
    const handle = gen.locator('[data-handleid="prompt"]');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 10, hb.y + 10); // nudge to start the connection
    await page.mouse.move(hb.x - 220, hb.y + 220, { steps: 12 });
    await page.mouse.up();

    await expect(page.getByTestId('connect-menu')).toBeVisible();
    // a prompt input offers the two text sources — no image refs
    await expect(page.getByTestId('connect-add-prompt')).toBeVisible();
    await expect(page.getByTestId('connect-add-aiprompt')).toBeVisible();
    await expect(page.getByTestId('connect-add-media')).toHaveCount(0);

    await page.getByTestId('connect-add-prompt').click();
    // the created prompt node is auto-wired into g1.prompt
    await expect(page.locator('.react-flow__node-prompt')).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    await expect(page.getByTestId('connect-menu')).toHaveCount(0);

    // The common downward drop must not put the editor underneath the fixed
    // bottom toolbar/montage controls.
    const promptBox = (await page.locator('.react-flow__node-prompt').boundingBox())!;
    expect(promptBox.y + promptBox.height).toBeLessThanOrEqual(page.viewportSize()!.height - 129);
  });

  test('dragging an image ref input offers reference / character / location / product nodes', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          ...genNode('g1', 'video', 480),
          position: { x: 480, y: 280 },
          data: {
            mode: 'video',
            modelId: 'seedance-2-0-fast-reference-to-video',
            prompt: '',
            status: 'idle',
          },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const gen = page.locator('.react-flow__node-generate');
    await expect(gen).toBeVisible();

    const handle = gen.locator('[data-handleid="images[0]"]');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x - 10, hb.y + 10); // nudge to start the connection
    await page.mouse.move(hb.x - 220, hb.y + 240, { steps: 12 });
    await page.mouse.up();

    await expect(page.getByTestId('connect-menu')).toBeVisible();
    await expect(page.getByTestId('connect-add-media')).toBeVisible();
    await expect(page.getByTestId('connect-add-character')).toContainText('Человек');
    await expect(page.getByTestId('connect-add-location')).toContainText('Место');
    await expect(page.getByTestId('connect-add-product')).toContainText('Товар');
    // an image ref does NOT offer a bare prompt
    await expect(page.getByTestId('connect-add-prompt')).toHaveCount(0);

    await page.getByTestId('connect-add-product').click();
    const product = page.getByTestId('cast-node-product');
    await expect(product).toBeVisible();
    await expect(product.getByTestId('node-cast-header')).toHaveText('Объект · Товар');
    await expect(product.getByTestId('cast-identity')).toBeVisible();
    await expect(product.getByTestId('cast-add-motion')).toHaveCount(0);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });
});

test.describe('mobile review surface', () => {
  test('phone can inspect the graph and open the shot list without editing it', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'p1',
          type: 'prompt',
          position: { x: 40, y: 80 },
          data: { text: 'Ночной город' },
        },
        {
          id: 'g1',
          type: 'generate',
          position: { x: 360, y: 80 },
          data: {
            mode: 'image',
            modelId: 'flux-2-pro',
            prompt: 'Ночной город',
            status: 'idle',
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'p1',
          target: 'g1',
          sourceHandle: 'text',
          targetHandle: 'prompt',
          type: 'typed',
        },
      ],
    });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/boards/${id}`);

    await expect(page.getByTestId('mobile-board')).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await page.getByRole('button', { name: 'Кадры' }).click();
    await expect(page.getByRole('heading', { name: 'Кадры' })).toBeVisible();
    const shot = page.getByRole('button', { name: /Кадр 1 · изображение/ });
    await expect(shot).toContainText('Кадр 1 · изображение');
    await expect(shot).toContainText('не снят');
  });

  test('phone confirms one prepared run, persists its job id, and reconciles after reload', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const submissions: Array<Record<string, unknown>> = [];
    await page.route('**/v1/jobs', async (route) => {
      submissions.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'mobile-zero-spend-job' }),
      });
    });

    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'mobile-ready-shot',
          type: 'generate',
          position: { x: 120, y: 120 },
          data: {
            mode: 'image',
            modelId: 'seedream-5-0-pro',
            prompt: 'Подготовленный ночной город',
            imageAspect: '1:1',
            imageQuality: '2K',
            count: 1,
            status: 'idle',
          },
        },
      ],
      edges: [],
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/boards/${id}`);
    await page.locator('.react-flow__node[data-id="mobile-ready-shot"]').click();
    await page.getByTestId('mobile-board-run').click();

    const confirmation = page.getByTestId('mobile-run-confirm');
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText('Запустить подготовленный кадр?');
    await expect(confirmation).toContainText('Настройки и связи меняются только на компьютере');
    await expect(confirmation.getByTestId('mobile-run-submit')).toContainText(/Запустить ·\s*\d+/);
    await confirmation.getByTestId('mobile-run-submit').click();

    await expect(page.getByTestId('mobile-board-notice')).toContainText('Кадр запущен');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      source: 'boards',
      modelId: 'seedream-5-0-pro',
      prompt: 'Подготовленный ночной город',
    });
    expect(submissions[0]?.['idempotencyKey']).toEqual(expect.any(String));

    await expect
      .poll(async () => {
        const response = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
          headers: { cookie: cookieHeader },
        });
        const body = (await response.json()) as {
          state: { nodes: Array<{ id: string; data: Record<string, unknown> }> };
        };
        return body.state.nodes.find((node) => node.id === 'mobile-ready-shot')?.data;
      })
      .toMatchObject({ status: 'running', jobId: 'mobile-zero-spend-job' });

    await page.reload();
    await page.getByRole('button', { name: 'Кадры' }).click();
    await expect(page.getByRole('button', { name: /Кадр 1 · изображение/ })).toContainText('идёт…');
    expect(submissions).toHaveLength(1);
  });

  test('phone exposes an insufficient-credit failure above confirmation and cancels safely', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    let submissions = 0;
    await page.route('**/v1/jobs', async (route) => {
      submissions += 1;
      await route.fulfill({
        status: 402,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'insufficient_credits' }),
      });
    });
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'mobile-unaffordable-shot',
          type: 'generate',
          position: { x: 120, y: 120 },
          data: {
            mode: 'image',
            modelId: 'seedream-5-0-pro',
            prompt: 'Кадр без достаточного баланса',
            imageAspect: '1:1',
            imageQuality: '2K',
            count: 1,
            status: 'idle',
          },
        },
      ],
      edges: [],
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/boards/${id}`);
    await page.locator('.react-flow__node[data-id="mobile-unaffordable-shot"]').click();
    await page.getByTestId('mobile-board-run').click();
    await page.getByTestId('mobile-run-submit').click();

    const notice = page.getByTestId('mobile-board-notice');
    await expect(notice).toContainText('Недостаточно токенов');
    const noticeIsTopLayer = await notice.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return top === element || (top !== null && element.contains(top));
    });
    expect.soft(noticeIsTopLayer, 'the 402 explanation must not be hidden by the modal').toBe(true);

    await page.getByRole('button', { name: 'Отменить запуск' }).click();
    await expect(page.getByTestId('mobile-run-confirm')).toHaveCount(0);
    expect(submissions).toBe(1);
    const stored = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await stored.json()) as {
      state: { nodes: Array<{ id: string; data: Record<string, unknown> }> };
    };
    expect(
      body.state.nodes.find((node) => node.id === 'mobile-unaffordable-shot')?.data,
    ).toMatchObject({ status: 'idle' });
  });

  for (const failure of [
    {
      name: 'tier-gate 403',
      key: '403',
      response: { status: 403, body: JSON.stringify({ error: 'tier_required' }) },
      // A tier refusal names the plan that unlocks the shot instead of saying
      // "недоступна" and stopping. The label comes from the node's own model —
      // seedream 5.0 pro is creator-tier — so it moves with the catalogue.
      message: 'Открыть в тарифе «Креатор»',
    },
    {
      name: 'server 503',
      key: '503',
      response: { status: 503, body: JSON.stringify({ error: 'service_unavailable' }) },
      message: 'Не удалось запустить (HTTP 503)',
    },
    {
      name: 'network abort',
      key: 'network-abort',
      response: undefined,
      message: 'Нет связи с сервером',
    },
  ]) {
    test(`phone exposes ${failure.name} above confirmation and leaves the shot retry-safe`, async ({
      signedInPage: page,
      context,
      cookieHeader,
      apiUrl,
    }) => {
      const submissions: Array<Record<string, unknown>> = [];
      await page.route('**/v1/jobs', async (route) => {
        submissions.push(route.request().postDataJSON() as Record<string, unknown>);
        if (failure.key === 'network-abort' && submissions.length === 2) {
          await route.fulfill({
            status: 201,
            contentType: 'application/json',
            body: JSON.stringify({ jobId: 'mobile-network-retry-job' }),
          });
          return;
        }
        if (failure.response) {
          await route.fulfill({
            status: failure.response.status,
            contentType: 'application/json',
            body: failure.response.body,
          });
        } else {
          await route.abort('connectionfailed');
        }
      });
      const nodeId = `mobile-${failure.key}-shot`;
      const id = await seedBoard(context.request, apiUrl, cookieHeader, {
        nodes: [
          {
            id: nodeId,
            type: 'generate',
            position: { x: 120, y: 120 },
            data: {
              mode: 'image',
              modelId: 'seedream-5-0-pro',
              prompt: `Кадр для проверки ${failure.name}`,
              imageAspect: '1:1',
              imageQuality: '2K',
              count: 1,
              status: 'idle',
            },
          },
        ],
        edges: [],
      });

      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/boards/${id}`);
      await page.locator(`.react-flow__node[data-id="${nodeId}"]`).click();
      await page.getByTestId('mobile-board-run').click();
      await page.getByTestId('mobile-run-submit').click();

      const notice = page.getByTestId('mobile-board-notice');
      await expect(notice).toContainText(failure.message);
      const noticeIsTopLayer = await notice.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const top = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return top === element || (top !== null && element.contains(top));
      });
      expect
        .soft(noticeIsTopLayer, `the ${failure.name} explanation must not be hidden by the modal`)
        .toBe(true);

      if (failure.key === 'network-abort') {
        await page.getByTestId('mobile-run-submit').click();
        await expect(page.getByTestId('mobile-board-notice')).toContainText('Кадр запущен');
        expect(submissions).toHaveLength(2);
        expect(submissions[1]?.['idempotencyKey']).toBe(submissions[0]?.['idempotencyKey']);
        await expect
          .poll(async () => {
            const stored = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
              headers: { cookie: cookieHeader },
            });
            const body = (await stored.json()) as {
              state: { nodes: Array<{ id: string; data: Record<string, unknown> }> };
            };
            return body.state.nodes.find((node) => node.id === nodeId)?.data;
          })
          .toMatchObject({ status: 'running', jobId: 'mobile-network-retry-job' });
        return;
      }

      await page.getByRole('button', { name: 'Отменить запуск' }).click();
      await expect(page.getByTestId('mobile-run-confirm')).toHaveCount(0);
      expect(submissions).toHaveLength(1);
      const stored = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
        headers: { cookie: cookieHeader },
      });
      const body = (await stored.json()) as {
        state: { nodes: Array<{ id: string; data: Record<string, unknown> }> };
      };
      expect(body.state.nodes.find((node) => node.id === nodeId)?.data).toMatchObject({
        status: 'idle',
      });
    });
  }
});

test.describe('AI-промпт node', () => {
  test('pick a model, draft from a brief, and switch between brief and result without redrafting', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    // mock the LLM endpoint so the test never hits live OpenRouter
    let draftRequests = 0;
    await page.route('**/v1/prompt-studio/draft', (route) => {
      draftRequests += 1;
      return route.fulfill({ json: { prompt: 'Канонический промпт из мока.', mode: 'stub' } });
    });

    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);

    await page.getByTestId('board-add').click();
    await page.getByTestId('add-aiprompt').click();
    const node = page.locator('.react-flow__node-aiprompt');
    await expect(node).toBeVisible();

    // model picker (dropdown opens DOWN inside the widget)
    await expect(node.getByTestId('ai-model-trigger')).toContainText('Claude Sonnet 5');
    await node.getByTestId('ai-model-trigger').click();
    await node.getByTestId('ai-model-gemini').click();
    await expect(node.getByTestId('ai-model-trigger')).toContainText('Gemini 3 Flash');

    // write a brief and draft → flips to the result
    await node.getByTestId('ai-brief').fill('кот в шапке зимой');
    await node.getByTestId('ai-draft').click();
    await expect(node.getByTestId('ai-result')).toContainText('Канонический промпт из мока');

    // Back to the brief, then restore the already drafted result without another request.
    await node.getByTestId('ai-edit').click();
    await expect(node.getByTestId('ai-brief')).toBeVisible();
    await node.getByTestId('ai-result-view').click();
    await expect(node.getByTestId('ai-result')).toContainText('Канонический промпт из мока');
    expect(draftRequests).toBe(1);
  });

  test('the drafted text wires into a shot prompt', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await page.route('**/v1/prompt-studio/draft', (route) =>
      route.fulfill({ json: { prompt: 'Промпт для кадра.', mode: 'stub' } }),
    );
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'ai1',
          type: 'aiprompt',
          position: { x: 80, y: 120 },
          data: { brief: 'идея', model: 'gpt' },
        },
        genNode('g1', 'video', 480),
      ],
      edges: [
        {
          id: 'e1',
          source: 'ai1',
          sourceHandle: 'text',
          target: 'g1',
          targetHandle: 'prompt',
          animated: true,
        },
      ],
    });
    await page.goto(`/boards/${id}`);
    const node = page.locator('.react-flow__node-aiprompt');
    await expect(node).toBeVisible();
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);

    await node.getByTestId('ai-draft').click();
    await expect(node.getByTestId('ai-result')).toContainText('Промпт для кадра');
  });

  test('reuses the AI draft claim key after a lost response', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const submissions: Array<Record<string, unknown>> = [];
    let first = true;
    await page.route('**/v1/prompt-studio/draft', async (route) => {
      submissions.push(route.request().postDataJSON() as Record<string, unknown>);
      if (first) {
        first = false;
        // The API may already have committed before this response disappears.
        // The second click must therefore replay the same durable claim key.
        await route.abort('connectionfailed');
        return;
      }
      await route.fulfill({ json: { prompt: 'Повторно полученный промпт.', mode: 'stub' } });
    });

    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'ai-retry',
          type: 'aiprompt',
          position: { x: 80, y: 120 },
          data: { brief: 'идея для повтора', model: 'gpt' },
        },
      ],
      edges: [],
    });
    await page.goto(`/boards/${id}`);
    const node = page.locator('.react-flow__node-aiprompt');
    await expect(node).toBeVisible();

    await node.getByTestId('ai-draft').click();
    await expect(node).toContainText('Не получилось — попробуйте ещё.');
    await node.getByTestId('ai-draft').click();
    await expect(node.getByTestId('ai-result')).toContainText('Повторно полученный промпт');

    expect(submissions).toHaveLength(2);
    expect(submissions[0]?.['idempotencyKey']).toEqual(expect.any(String));
    expect(submissions[1]?.['idempotencyKey']).toBe(submissions[0]?.['idempotencyKey']);
  });
});
