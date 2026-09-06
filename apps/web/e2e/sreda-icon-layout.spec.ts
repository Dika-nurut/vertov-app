import { expect, test, type Page, type Route } from '@playwright/test';

type Position = { itemKind: string; itemId: string; x: number; y: number };

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installDeskFixture(page: Page, initial: Position[] = []) {
  let positions = [...initial];
  let persistedRevision = 0;
  const writes: Array<{ revision: number; positions: Position[] }> = [];
  let heldFirst:
    | {
        route: Route;
        revision: number;
        positions: Position[];
      }
    | undefined;
  let holdFirstPut = false;
  const applyWrite = (revision: number, incoming: Position[]) => {
    if (revision <= persistedRevision) return;
    const merged = new Map(positions.map((item) => [`${item.itemKind}:${item.itemId}`, item]));
    incoming.forEach((item) => merged.set(`${item.itemKind}:${item.itemId}`, item));
    positions = [...merged.values()];
    persistedRevision = revision;
  };
  const fulfillWrite = (route: Route, revision: number, incoming: Position[]) =>
    json(route, {
      ok: true,
      persisted: incoming.length,
      revision,
      updatedAt: new Date().toISOString(),
    });
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'sreda-layout-zero-spend',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/projects/layout-project') {
      return json(route, {
        id: 'layout-project',
        title: 'Раскладка',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: null,
        rooms: { scenario: 1, boards: 0, studio: 0, assets: 0 },
      });
    }
    if (path === '/v1/projects/layout-project/folders') {
      return json(route, {
        folders: [{ id: 'folder-layout', name: 'Референсы', ord: 0, count: 0 }],
        limit: 24,
      });
    }
    if (path === '/v1/projects/layout-project/recents') {
      return json(route, { items: [], nextCursor: null });
    }
    if (path === '/v1/projects/layout-project/desk-items') {
      const now = new Date().toISOString();
      return json(route, {
        items: [
          {
            type: 'script',
            id: 'script-layout',
            title: 'Сценарий',
            createdAt: now,
            updatedAt: now,
            sortAt: now,
            href: '/scenario/script-layout',
          },
        ],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scenario: false, boards: false, studio: false },
        retention: { mode: 'permanent', reminder: null },
      });
    }
    if (path === '/v1/projects/layout-project/desk-layout') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { revision: number; positions: Position[] };
        writes.push(body);
        if (holdFirstPut && !heldFirst) {
          heldFirst = { route, ...body };
          return;
        }
        applyWrite(body.revision, body.positions);
        return fulfillWrite(route, body.revision, body.positions);
      }
      return json(route, { revision: persistedRevision, positions });
    }
    if (path === '/v1/assets/usage') return json(route, { usages: {} });
    if (path === '/v1/credits/balance') return json(route, { available: 0 });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture_not_found', path }),
    });
  });
  return {
    getPositions: () => positions,
    getRevision: () => persistedRevision,
    writes,
    holdNextPut: () => {
      holdFirstPut = true;
    },
    releaseHeldPut: async () => {
      if (!heldFirst) throw new Error('no_held_layout_put');
      applyWrite(heldFirst.revision, heldFirst.positions);
      await fulfillWrite(heldFirst.route, heldFirst.revision, heldFirst.positions);
      heldFirst = undefined;
    },
  };
}

test('desktop icon placement is persisted, restored after reload, and still opens on double click', async ({
  page,
}) => {
  const fixture = await installDeskFixture(page);
  await page.goto('/workspace/layout-project');
  const folder = page.getByTestId('folder-target-folder-layout');
  const surface = page.getByTestId('desk-items');
  await expect(folder).toBeVisible();

  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await folder.dispatchEvent('dragstart', { dataTransfer: transfer });
  const surfaceBox = await surface.boundingBox();
  await surface.dispatchEvent('dragover', {
    dataTransfer: transfer,
    clientX: surfaceBox!.x + 400,
    clientY: surfaceBox!.y + 180,
  });
  await surface.dispatchEvent('drop', {
    dataTransfer: transfer,
    clientX: surfaceBox!.x + 400,
    clientY: surfaceBox!.y + 180,
  });

  await expect
    .poll(() =>
      fixture
        .getPositions()
        .find((item) => item.itemKind === 'folder' && item.itemId === 'folder-layout'),
    )
    .toMatchObject({ x: 378, y: 136 });
  const placed = await folder.boundingBox();

  await page.reload();
  const restored = await page.getByTestId('folder-target-folder-layout').boundingBox();
  expect(restored!.x).toBeCloseTo(placed!.x, 0);
  expect(restored!.y).toBeCloseTo(placed!.y, 0);
  await page.screenshot({
    path: '../../docs/evidence/sreda-icon-layout/2026-07-24/layout-restored.png',
    fullPage: true,
  });
  await page.getByTestId('folder-target-folder-layout').dblclick();
  await expect(page.getByTestId('folder-window-folder:folder-layout')).toBeVisible();
});

test('keyboard placement and resize keep all icons in the usable desktop', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installDeskFixture(page, [
    { itemKind: 'folder', itemId: 'folder-layout', x: 20_000, y: 20_000 },
  ]);
  await page.goto('/workspace/layout-project');
  const folder = page.getByTestId('folder-target-folder-layout');
  await folder.focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect
    .poll(
      () =>
        fixture
          .getPositions()
          .find((item) => item.itemKind === 'folder' && item.itemId === 'folder-layout')?.x,
    )
    .toBe(882);

  await page.setViewportSize({ width: 1024, height: 700 });
  await expect
    .poll(() => {
      const saved = fixture
        .getPositions()
        .find((item) => item.itemKind === 'folder' && item.itemId === 'folder-layout');
      return saved ? saved.x : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(882);
  const box = await folder.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(1024);
  expect(box!.y + box!.height).toBeLessThanOrEqual(700);
  expect(await folder.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.screenshot({
    path: '../../docs/evidence/sreda-icon-layout/2026-07-24/layout-resized-reduced-motion.png',
    fullPage: true,
  });
});

test('pagehide issues the final layout write immediately and its revision wins out of order', async ({
  page,
}) => {
  const fixture = await installDeskFixture(page, [
    { itemKind: 'system', itemId: 'recents', x: 0, y: 0 },
    { itemKind: 'system', itemId: 'frames', x: 126, y: 0 },
    { itemKind: 'script', itemId: 'script-layout', x: 252, y: 0 },
    { itemKind: 'folder', itemId: 'folder-layout', x: 0, y: 136 },
  ]);
  await page.goto('/workspace/layout-project');
  const folder = page.getByTestId('folder-target-folder-layout');
  await folder.focus();

  fixture.holdNextPut();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => fixture.writes.length).toBe(1);

  await page.keyboard.press('Alt+ArrowRight');
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));

  await expect.poll(() => fixture.writes.length).toBe(2);
  expect(fixture.writes.map((write) => write.revision)).toEqual([1, 2]);
  expect(fixture.writes[1]?.positions).toEqual([
    expect.objectContaining({
      itemKind: 'folder',
      itemId: 'folder-layout',
      x: 252,
      y: 136,
    }),
  ]);
  await expect.poll(() => fixture.getRevision()).toBe(2);

  await fixture.releaseHeldPut();
  expect(fixture.getRevision()).toBe(2);
  expect(
    fixture
      .getPositions()
      .find((item) => item.itemKind === 'folder' && item.itemId === 'folder-layout'),
  ).toMatchObject({ x: 252, y: 136 });
});
