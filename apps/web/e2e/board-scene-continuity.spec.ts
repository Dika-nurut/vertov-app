import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * Scene → continuity → first frame, in a real browser.
 *
 * Every decision the author makes here is a real in-board dialog: the per-shot
 * object subset, the «вещь → товар» question and the linked-chip menu. This
 * spec exists because none of that is reachable from a unit test, and because
 * the shipped first version used `window.prompt` where the mockup has a sheet.
 *
 * No job is submitted and nothing is debited: the scaffold is structure only.
 */

const stills = (tag: string) =>
  Array.from({ length: 4 }, (_, index) => `https://example.invalid/${tag}-${index}.png`);

function castNode(id: string, name: string, castKind: string, y: number) {
  return {
    id,
    type: 'cast',
    version: 1,
    position: { x: 520, y },
    width: 300,
    height: 260,
    data: { castKind, name, imageUrls: stills(id) },
  };
}

const SCENE_OBJECTS = [
  { kind: 'person', name: 'Анна', description: 'Главная героиня.', castNodeId: 'cast-0' },
  { kind: 'person', name: 'Официант', castNodeId: 'cast-1' },
  { kind: 'person', name: 'Посетитель', castNodeId: 'cast-2' },
  { kind: 'place', name: 'Кафе', castNodeId: 'cast-3' },
  { kind: 'thing', name: 'Чашка' },
];

const BOARD_STATE = {
  schemaVersion: 1,
  nodes: [
    {
      id: 'scene-1',
      type: 'scene',
      version: 1,
      position: { x: 40, y: 40 },
      width: 360,
      height: 320,
      data: {
        title: 'ИНТ. КАФЕ — ВЕЧЕР',
        synopsis: 'Анна ждёт за столом у окна.',
        sourceText: 'ПОЛНЫЙ ТЕКСТ СЦЕНЫ НЕ ДОЛЖЕН ПОПАСТЬ В ПРОМПТ',
        sourceStatus: 'current',
        collapsed: true,
        objects: SCENE_OBJECTS,
      },
    },
    castNode('cast-0', 'Анна', 'character', 40),
    castNode('cast-1', 'Официант', 'character', 320),
    castNode('cast-2', 'Посетитель', 'character', 600),
    castNode('cast-3', 'Кафе', 'location', 880),
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 0.75 },
  tray: [],
};

async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Мост сцены e2e' },
  });
  expect(created.status()).toBe(201);
  const boardId = ((await created.json()) as { id: string }).id;
  const saved = await request.put(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state: BOARD_STATE, rev: 0 },
  });
  expect(saved.ok()).toBe(true);
  return boardId;
}

test('four full reference packs overflow the model, and the author picks the subset', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const boardId = await seedBoard(context.request, apiUrl, cookieHeader);
  // Structure creation is free. A price *estimate* is a read-only quote and is
  // expected; an actual submit to /v1/jobs is a defect, not a cost.
  const jobRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/v1/jobs') jobRequests.push(request.url());
  });
  await page.goto(`/boards/${boardId}`);

  await page.getByRole('button', { name: /Добавить (первый|ещё) кадр/ }).click();

  const sheet = page.getByTestId('scene-subset-sheet');
  await expect(sheet).toBeVisible();
  // 4 cards × 4 stills = 16 against a 14-reference model: nothing was created.
  await expect(page.getByTestId('scene-subset-confirm')).toBeDisabled();
  await expect(page.locator('.react-flow__node-generate')).toHaveCount(0);

  await page.getByTestId('scene-subset-item-cast-3').click();
  await expect(page.getByTestId('scene-subset-confirm')).toBeEnabled();
  await page.getByTestId('scene-subset-confirm').click();

  await expect(sheet).toBeHidden();
  await expect(page.locator('.react-flow__node-prompt')).toHaveCount(1);
  await expect(page.locator('.react-flow__node-generate')).toHaveCount(1);

  const prompt = page.locator('.react-flow__node-prompt textarea').first();
  await expect(prompt).toContainText('ИНТ. КАФЕ — ВЕЧЕР');
  await expect(prompt).toContainText('Объекты:');
  await expect(prompt).toContainText('- Анна: Главная героиня.');
  // The screenplay body would bury the author's own instruction.
  await expect(prompt).not.toContainText('ПОЛНЫЙ ТЕКСТ СЦЕНЫ');
  // The card the author unchecked is neither wired nor named.
  await expect(prompt).not.toContainText('Кафе');

  // The graph, not just the node count: one prompt edge + one edge per kept card.
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);
  expect(jobRequests).toEqual([]);

  // It must survive the round trip, not just live in memory. The API copy is the
  // authority — React Flow only renders nodes inside the viewport, so a DOM count
  // after reload would measure the camera, not the document.
  //
  // Poll rather than await the autosave PUT: the debounce can fire before a
  // listener is attached, and then waiting for it hangs until the timeout on a
  // board that was in fact already saved.
  await expect
    .poll(
      async () => {
        const persisted = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
          headers: { cookie: cookieHeader },
        });
        const state = (
          (await persisted.json()) as {
            state: { nodes: { type: string }[]; edges: { targetHandle: string }[] };
          }
        ).state;
        return {
          generate: state.nodes.filter((node) => node.type === 'generate').length,
          prompt: state.nodes.filter((node) => node.type === 'prompt').length,
          handles: state.edges.map((edge) => edge.targetHandle).sort(),
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      generate: 1,
      prompt: 1,
      handles: ['images[0]', 'images[1]', 'images[2]', 'prompt'],
    });
});

test('a linked chip opens a real menu, and a вещь says out loud that it becomes a товар', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const boardId = await seedBoard(context.request, apiUrl, cookieHeader);
  await page.goto(`/boards/${boardId}`);

  const linkedChip = page.getByTestId('scene-object-chip-0');
  await expect(linkedChip).toHaveAttribute('aria-haspopup', 'menu');
  await linkedChip.click();
  await expect(page.getByTestId('scene-object-menu-0')).toBeVisible();
  await expect(linkedChip).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scene-object-menu-0')).toBeHidden();

  // «Чашка» is the only unpromoted object, and it is a вещь.
  await page.getByTestId('scene-object-chip-4').click();
  await expect(page.getByTestId('scene-promote-product')).toBeVisible();
  await page.getByTestId('scene-promote-cancel').click();
  await expect(page.getByTestId('scene-promote-product')).toBeHidden();
  // Cancel changed nothing: still four cast cards.
  await expect(page.locator('.react-flow__node-cast')).toHaveCount(4);

  // Confirming creates exactly one card, links the chip, and runs nothing.
  await page.getByTestId('scene-object-chip-4').click();
  await page.getByTestId('scene-promote-confirm').click();
  await expect(page.locator('.react-flow__node-cast')).toHaveCount(5);
  await expect(page.getByTestId('scene-object-chip-4')).toHaveAttribute('aria-haspopup', 'menu');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);

  // Unlink drops the pointer without deleting the shared card.
  await page.getByTestId('scene-object-chip-4').click();
  await page.getByTestId('scene-object-unlink-4').click();
  await expect(page.locator('.react-flow__node-cast')).toHaveCount(5);
  await expect(page.getByTestId('scene-object-chip-4')).toHaveAttribute('aria-pressed', 'false');
});
