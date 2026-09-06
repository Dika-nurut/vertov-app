import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Desktop workspace conventions (Goal 7 §1). Every desk icon must open on a
 * double click, on Enter, and on Space — not only user folders. Folders must
 * also expose a clear right-click context menu (rename + the other folder
 * actions), mirroring a desktop OS. Zero provider spend: every `/v1/**` call is
 * fulfilled locally and the session is a fixture cookie.
 */

type Position = { itemKind: string; itemId: string; x: number; y: number };

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installDeskFixture(page: Page, initialPositions: Position[] = []) {
  const now = new Date().toISOString();
  let positions: Position[] = [...initialPositions];
  let revision = 0;
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'desk-conventions-zero-spend',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/projects/conv-project') {
      return json(route, {
        id: 'conv-project',
        title: 'Клип «Восход»',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: 'script-1',
        rooms: { scenario: 1, boards: 0, studio: 0, assets: 1 },
      });
    }
    if (path === '/v1/projects/conv-project/folders') {
      return json(route, {
        folders: [
          {
            id: 'folder-ref',
            name: 'Референсы',
            ord: 0,
            count: 0,
            childCount: 0,
            version: 1,
            parentId: null,
            createdAt: now,
          },
        ],
        limit: 24,
      });
    }
    if (path === '/v1/projects/conv-project/recents')
      return json(route, { items: [], nextCursor: null });
    if (path === '/v1/projects/conv-project/desk-items') {
      return json(route, {
        items: [
          {
            type: 'script',
            id: 'script-1',
            title: 'Сценарий: Восход',
            createdAt: now,
            updatedAt: now,
            sortAt: now,
            href: '/scenario/script-1',
          },
          {
            type: 'media',
            id: 'media-1',
            sortAt: now,
            asset: {
              id: 'media-1',
              assetUrl: 'https://example.com/a.jpg',
              thumbnailUrl: null,
              kind: 'image',
              title: 'Кадр 1',
              originalName: 'shot1.jpg',
              mimeType: 'image/jpeg',
              createdAt: now,
            },
          },
        ],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scenario: false, boards: false, studio: false },
        retention: { mode: 'permanent', reminder: null },
      });
    }
    if (path === '/v1/projects/conv-project/desk-layout') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as { revision: number; positions: Position[] };
        revision = body.revision;
        positions = body.positions;
        return json(route, {
          ok: true,
          persisted: body.positions.length,
          revision,
          updatedAt: now,
        });
      }
      return json(route, { revision, positions });
    }
    if (path === '/v1/assets/usage') return json(route, { usages: {} });
    if (path === '/v1/credits/balance') return json(route, { available: 0 });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture_not_found', path }),
    });
  });
}

async function openDesk(page: Page, initialPositions: Position[] = []) {
  await installDeskFixture(page, initialPositions);
  await page.goto('/workspace/conv-project');
  await expect(page.getByTestId('folder-target-folder-ref')).toBeVisible();
}

test('Enter opens a selected user folder', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-window-folder:folder-ref')).toBeVisible();
});

test('Space opens a selected user folder', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').click();
  await page.keyboard.press(' ');
  await expect(page.getByTestId('folder-window-folder:folder-ref')).toBeVisible();
});

test('Enter opens the Недавние system folder', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('recent-folder').click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-window-recents')).toBeVisible();
});

test('Enter opens the Кадры system folder', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('frames-folder').click();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-window-frames')).toBeVisible();
});

test('Enter on a document icon opens its editor in the project context', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('desk-item-script-script-1').click();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/scenario\/script-1\?projectId=conv-project/);
});

test('Enter on a media icon opens the project media viewer', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('desk-item-media-media-1').click();
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/workspace\/conv-project\/media\/media-1/);
});

test('right-click a folder opens a context menu with rename and folder actions', async ({
  page,
}) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').click({ button: 'right' });
  const menu = page.getByTestId('folder-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Открыть' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Переименовать' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Новая вложенная папка' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Переместить…' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Удалить папку' })).toBeVisible();
});

test('the folder context menu rename action opens the rename dialog prefilled', async ({
  page,
}) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').click({ button: 'right' });
  await page.getByTestId('folder-menu-rename').click();
  const dialog = page.getByTestId('folder-action-rename');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#folder-action-value')).toHaveValue('Референсы');
});

test('the folder context menu dismisses on an outside click', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').click({ button: 'right' });
  await expect(page.getByTestId('folder-context-menu')).toBeVisible();
  await page.getByTestId('desk-items').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('folder-context-menu')).toHaveCount(0);
});

test('Shift+F10 on a folder opens the folder menu, not the desktop menu', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('folder-context-menu')).toBeVisible();
  // The generic desk menu must not open behind it.
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
});

test('the ContextMenu key on a folder opens the folder menu', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('ContextMenu');
  await expect(page.getByTestId('folder-context-menu')).toBeVisible();
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
});

test('the folder context menu exposes menu semantics and takes focus', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: /Референсы/ });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(5);
  await expect(menu.getByRole('menuitem', { name: 'Открыть' })).toBeFocused();
});

test('arrow keys move through the folder context menu items', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('folder-context-menu');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Переименовать' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Открыть' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Удалить папку' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Открыть' })).toBeFocused();
});

test('Escape closes the folder context menu and returns focus to the folder', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('folder-context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('folder-context-menu')).toHaveCount(0);
  await expect(page.getByTestId('folder-target-folder-ref')).toBeFocused();
});

test('the keyboard-opened menu can run a folder action', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-action-rename')).toBeVisible();
});

/**
 * The generic empty-desk menu must honour the same keyboard contract as the
 * folder menu — an audit found it did not, despite the decision log claiming
 * both behaved identically.
 */

/**
 * Right-click bare desk. Icons are laid out from the top-left of the plane
 * (the first cell is the Недавние folder), so the reliably empty spot — the one
 * that reaches the plane rather than a `[data-desk-object]` — is the far corner.
 */
async function rightClickEmptyDesk(page: Page) {
  const plane = (await page.locator('[data-desk-plane]').boundingBox())!;
  await page.mouse.move(plane.x + plane.width - 8, plane.y + plane.height - 8);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
}

test('right-click on empty desk opens the generic menu and moves focus into it', async ({
  page,
}) => {
  await openDesk(page);
  await rightClickEmptyDesk(page);
  const menu = page.getByTestId('desk-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeFocused();
});

test('Shift+F10 on the desk plane opens the generic menu with focus on its first item', async ({
  page,
}) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('desk-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeFocused();
  // A folder menu must not open alongside the generic one.
  await expect(page.getByTestId('folder-context-menu')).toHaveCount(0);
});

test('the ContextMenu key on the desk plane opens the generic menu with focus', async ({
  page,
}) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('ContextMenu');
  const menu = page.getByTestId('desk-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeFocused();
});

test('arrow keys and Home/End move through the generic desk menu items', async ({ page }) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByTestId('desk-context-menu');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Добавить файлы…' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // The ring wraps, exactly like the folder menu.
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Добавить файлы…' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Добавить файлы…' })).toBeFocused();
});

test('Escape closes the generic desk menu and returns focus to the desk plane', async ({
  page,
}) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('desk-context-menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
  await expect(page.locator('[data-desk-plane]')).toBeFocused();
});

test('Tab closes the generic desk menu instead of leaking focus behind it', async ({ page }) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByTestId('desk-context-menu')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
  await expect(page.locator('[data-desk-plane]')).toBeFocused();
});

test('the keyboard-opened generic desk menu can run an action', async ({ page }) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
  await expect(page.locator('#new-folder-name')).toBeVisible();
});

test('the generic desk menu still dismisses on an outside pointer press', async ({ page }) => {
  await openDesk(page);
  await rightClickEmptyDesk(page);
  await expect(page.getByTestId('desk-context-menu')).toBeVisible();
  await page.getByTestId('folder-target-folder-ref').click();
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
});

test('a generic desk menu opened at the bottom-right edge stays fully visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openDesk(page);
  // The far corner is where an unclamped menu would spill outside the viewport.
  await rightClickEmptyDesk(page);
  const menu = page.getByTestId('desk-context-menu');
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
});

test('a folder at the bottom-right edge still gets a fully visible menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  // Huge coordinates are clamped by the layout engine into the last usable
  // desk cell, i.e. the bottom-right corner — where an unclamped menu would
  // spill outside the viewport.
  await openDesk(page, [{ itemKind: 'folder', itemId: 'folder-ref', x: 20_000, y: 20_000 }]);
  await page.getByTestId('folder-target-folder-ref').click({ button: 'right' });
  const menu = page.getByTestId('folder-context-menu');
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  expect(box.y + box.height).toBeLessThanOrEqual(720);
});
