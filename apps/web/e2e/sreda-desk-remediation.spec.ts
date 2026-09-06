import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

/**
 * Goal 8C — the corrected desktop contracts the independent UX review found
 * broken. Every scenario here is deterministic and zero-spend: the session is a
 * fixture cookie and every `/v1/**` call is fulfilled locally.
 *
 * Covered contracts:
 *  · folder windows stay recoverable at both desktop sizes (drag + resize);
 *  · Search is the top layer over every desk-local transient;
 *  · ⌘/Ctrl+K works on a Russian layout and toggles exactly one launcher;
 *  · compact Search exposes an all-results path;
 *  · desk dialogs honour Escape, keep Tab inside, and restore focus;
 *  · the context-menu key is suppressed on objects with no object menu;
 *  · asset previews open from the keyboard;
 *  · reduced motion disables the drag ghost transition AND its bounce-back.
 */

const EVIDENCE = '../../docs/evidence/sreda-goal-8c';
const NOW = '2026-07-25T09:00:00.000Z';

const folderAsset = {
  id: 'asset-ref-1',
  assetUrl: '/landing/kadr-neon-city.webp',
  thumbnailUrl: null,
  kind: 'image',
  title: 'РЕФ_СВЕТ',
  originalName: 'ref-light.png',
  sourceLine: 'загрузка',
  mimeType: 'image/png',
  createdAt: NOW,
};

const searchResult = {
  type: 'media',
  id: 'asset-ref-1',
  title: 'РЕФ_СВЕТ',
  href: '/media/asset-ref-1',
  mediaKind: 'image',
  thumbnailUrl: null,
  projects: [{ id: 'conv-project', title: 'Клип «Восход»' }],
  projectCount: 1,
  association: 'project',
  updatedAt: NOW,
};

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installDeskFixture(page: Page) {
  let positions: Array<{ itemKind: string; itemId: string; x: number; y: number }> = [];
  let revision = 0;
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'desk-remediation-zero-spend',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
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
            count: 1,
            childCount: 0,
            version: 1,
            parentId: null,
            createdAt: NOW,
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
            createdAt: NOW,
            updatedAt: NOW,
            sortAt: NOW,
            href: '/scenario/script-1',
          },
          { type: 'media', id: 'media-1', sortAt: NOW, asset: { ...folderAsset, id: 'media-1' } },
        ],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scenario: false, boards: false, studio: false },
        retention: { mode: 'permanent', reminder: null },
      });
    }
    if (path === '/v1/projects/conv-project/desk-layout') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as {
          revision: number;
          positions: typeof positions;
        };
        revision = body.revision;
        positions = body.positions;
        return json(route, { ok: true, persisted: positions.length, revision, updatedAt: NOW });
      }
      return json(route, { revision, positions });
    }
    if (path === '/v1/folders/folder-ref/assets') {
      return json(route, { items: [{ asset: folderAsset }] });
    }
    if (path === '/v1/search') {
      return json(route, {
        query: url.searchParams.get('q') ?? '',
        groups: [{ type: 'media', items: [searchResult] }],
        page: 1,
        limit: Number(url.searchParams.get('limit') ?? 10),
        total: 42,
        totalPages: 5,
        hasPrevious: false,
        hasNext: true,
      });
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

async function openDesk(page: Page, viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport);
  await installDeskFixture(page);
  await page.goto('/workspace/conv-project');
  await expect(page.getByTestId('folder-target-folder-ref')).toBeVisible();
}

/** Drag a window's title bar by an absolute screen delta. */
async function dragWindowBar(page: Page, folderWindow: Locator, toX: number, toY: number) {
  const bar = folderWindow.locator('header').first();
  const bounds = (await bar.boundingBox())!;
  await page.mouse.move(bounds.x + 60, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 8 });
  await page.mouse.up();
}

async function openFolderWindow(page: Page): Promise<Locator> {
  await page.getByTestId('folder-target-folder-ref').dblclick();
  const folderWindow = page.getByTestId('folder-window-folder:folder-ref');
  await expect(folderWindow).toBeVisible();
  return folderWindow;
}

/* ─── 3. Folder windows stay recoverable ─────────────────────────────────── */

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  const label = `${viewport.width}x${viewport.height}`;

  test(`a folder window dragged past the right/bottom edge stays recoverable at ${label}`, async ({
    page,
  }) => {
    await openDesk(page, viewport);
    const folderWindow = await openFolderWindow(page);
    await dragWindowBar(page, folderWindow, viewport.width + 900, viewport.height + 900);

    const box = (await folderWindow.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    // A full title bar's worth of window is still inside the viewport, so the
    // bar can be grabbed and dragged back.
    expect(viewport.height - box.y).toBeGreaterThanOrEqual(46);

    // The close control is the recovery of last resort — it must be usable.
    const close = folderWindow.getByRole('button', { name: 'Закрыть' });
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(viewport.width);
    expect(closeBox.y).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({ path: `${EVIDENCE}/folder-window-clamped-${label}.png` });
    await close.click();
    await expect(folderWindow).toHaveCount(0);
  });
}

test('an open folder window is re-clamped when the viewport shrinks under it', async ({ page }) => {
  await openDesk(page, { width: 1440, height: 900 });
  const folderWindow = await openFolderWindow(page);
  await dragWindowBar(page, folderWindow, 1430, 880);
  const before = (await folderWindow.boundingBox())!;
  expect(before.x + before.width).toBeLessThanOrEqual(1440);

  await page.setViewportSize({ width: 1280, height: 720 });
  await expect
    .poll(async () => {
      const box = (await folderWindow.boundingBox())!;
      return box.x + box.width <= 1280 && 720 - box.y >= 46;
    })
    .toBe(true);
  await page.screenshot({ path: `${EVIDENCE}/folder-window-reclamped-1280x720.png` });
});

test('window positions stay ephemeral — dragging a window never writes the desk layout', async ({
  page,
}) => {
  const layoutWrites: string[] = [];
  await openDesk(page, { width: 1280, height: 720 });
  // Let the initial icon-layout reconciliation settle before watching writes.
  await page.waitForTimeout(800);
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().includes('/desk-layout')) {
      layoutWrites.push(request.url());
    }
  });
  const folderWindow = await openFolderWindow(page);
  await dragWindowBar(page, folderWindow, 4_000, 4_000);
  await page.waitForTimeout(600);
  expect(layoutWrites).toEqual([]);
});

/* ─── 2 + 4 + 5. Search: layer, shortcut, all-results ────────────────────── */

async function openDeskContextMenu(page: Page) {
  const plane = (await page.locator('[data-desk-plane]').boundingBox())!;
  await page.mouse.move(plane.x + plane.width - 8, plane.y + plane.height - 8);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await expect(page.getByTestId('desk-context-menu')).toBeVisible();
}

test('Search opens ABOVE an open desk context menu and stays interactive', async ({ page }) => {
  await openDesk(page, { width: 1280, height: 720 });
  await openDeskContextMenu(page);
  await page.keyboard.press('ControlOrMeta+k');

  const dialog = page.getByTestId('search-dialog');
  await expect(dialog).toBeVisible();

  const layers = await page.evaluate(() => {
    const read = (node: Element | null) =>
      node ? Number(getComputedStyle(node).zIndex) : Number.NaN;
    return {
      dialog: read(document.querySelector('[data-testid="search-dialog"]')),
      overlay: read(document.querySelector('[data-slot="dialog-overlay"], .ui-overlay')),
      menu: read(document.querySelector('[data-testid="desk-context-menu"]')),
    };
  });
  expect(layers.menu).toBeGreaterThan(0);
  expect(layers.dialog).toBeGreaterThan(layers.menu);
  expect(layers.overlay).toBeGreaterThan(layers.menu);

  // Visually on top: the element under the dialog's own centre is the dialog.
  const box = (await dialog.boundingBox())!;
  const topmostIsDialog = await page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return Boolean(node?.closest('[data-testid="search-dialog"]'));
    },
    [box.x + box.width / 2, box.y + 40],
  );
  expect(topmostIsDialog).toBe(true);

  // Interactively on top: the palette accepts typing and returns results.
  const input = page.getByRole('combobox', { name: 'Поиск по рабочей среде' });
  await input.fill('реф');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.screenshot({ path: `${EVIDENCE}/search-over-desk-menu-1280x720.png` });
});

test('Search opens above the desk name prompt at 1440x900', async ({ page }) => {
  await openDesk(page, { width: 1440, height: 900 });
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-folder-prompt')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByTestId('search-dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  const topmostIsDialog = await page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return Boolean(node?.closest('[data-testid="search-dialog"]'));
    },
    [box.x + box.width / 2, box.y + 40],
  );
  expect(topmostIsDialog).toBe(true);
  await page.screenshot({ path: `${EVIDENCE}/search-over-name-prompt-1440x900.png` });
});

test('the ⌘/Ctrl+K shortcut fires under a Russian layout, where event.key is Cyrillic', async ({
  page,
}) => {
  await openDesk(page);
  const opened = await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'к',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  });
  expect(opened).toBe(true);
  await expect(page.getByTestId('search-dialog')).toBeVisible();
  // Exactly one launcher reacted — a second dialog would mean two listeners
  // toggling on the same keypress.
  await expect(page.getByTestId('search-dialog')).toHaveCount(1);
});

test('one keypress toggles the launcher exactly once, in both directions', async ({ page }) => {
  await openDesk(page);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('search-dialog')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('search-dialog')).toHaveCount(0);
});

test('compact Search exposes a keyboard-reachable all-results path carrying query and scope', async ({
  page,
}) => {
  await openDesk(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Поиск по рабочей среде' });
  await input.fill('реф');
  await expect(page.getByRole('option')).toHaveCount(1);

  // No in-dialog pagination — the palette hands off instead.
  await expect(page.getByRole('navigation', { name: 'Страницы поиска' })).toHaveCount(0);
  const allResults = page.getByTestId('search-all-results');
  await expect(allResults).toHaveAttribute(
    'href',
    '/search?q=%D1%80%D0%B5%D1%84&projectId=conv-project',
  );
  // Reachable and activatable from the keyboard alone. (The landing page itself
  // needs a real session, so `global-search.spec.ts` walks the navigation and
  // the Back behaviour against the live stack.)
  await allResults.focus();
  await expect(allResults).toBeFocused();
});

test('the all-results path drops the project when the scope is «Вся Среда»', async ({ page }) => {
  await openDesk(page);
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.getByRole('combobox', { name: 'Поиск по рабочей среде' });
  await input.fill('реф');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('button', { name: 'Вся Среда' }).click();
  await expect(page.getByTestId('search-all-results')).toHaveAttribute(
    'href',
    '/search?q=%D1%80%D0%B5%D1%84',
  );
});

/* ─── 6. Desk dialog keyboard + focus ────────────────────────────────────── */

test('Escape cancels the folder rename dialog and returns focus to the folder icon', async ({
  page,
}) => {
  await openDesk(page);
  const folder = page.getByTestId('folder-target-folder-ref');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('folder-menu-rename').click();
  await expect(page.getByTestId('folder-action-rename')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('folder-action-rename')).toHaveCount(0);
  await expect(folder).toBeFocused();
});

test('Cancel in the folder rename dialog returns focus to the folder icon', async ({ page }) => {
  await openDesk(page);
  const folder = page.getByTestId('folder-target-folder-ref');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('folder-menu-rename').click();
  await page.getByTestId('folder-action-rename').getByRole('button', { name: 'Отмена' }).click();
  await expect(page.getByTestId('folder-action-rename')).toHaveCount(0);
  await expect(folder).toBeFocused();
});

test('Tab and Shift+Tab stay inside the folder action dialog', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('folder-target-folder-ref').focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('folder-menu-rename').click();
  const dialog = page.getByTestId('folder-action-rename');
  await expect(dialog.locator('#folder-action-value')).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
  // Wraps back to the first control instead of leaking into the desk behind.
  await page.keyboard.press('Tab');
  await expect(dialog.locator('#folder-action-value')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
});

test('a successful folder rename restores focus to the folder icon', async ({ page }) => {
  await openDesk(page);
  await page.route('**/v1/folders/folder-ref', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    return json(route, {
      id: 'folder-ref',
      name: 'Референсы 2',
      ord: 0,
      count: 1,
      childCount: 0,
      version: 2,
      parentId: null,
      createdAt: NOW,
    });
  });
  const folder = page.getByTestId('folder-target-folder-ref');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('folder-menu-rename').click();
  await page.getByTestId('folder-action-rename').locator('#folder-action-value').fill('Свет');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('folder-action-rename')).toHaveCount(0);
  await expect(folder).toBeFocused();
});

test('the new-folder prompt is a real modal: Escape cancels and focus returns to the desk', async ({
  page,
}) => {
  await openDesk(page);
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  const prompt = page.getByTestId('new-folder-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#new-folder-name')).toBeFocused();

  // Tab stays inside the prompt.
  await page.keyboard.press('Tab');
  await expect(prompt.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#new-folder-name')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.locator('[data-desk-plane]')).toBeFocused();
});

test('an open desk dialog really is modal to the pointer, and outside clicks do not dismiss it', async ({
  page,
}) => {
  await openDesk(page, { width: 1280, height: 720 });
  const folder = page.getByTestId('folder-target-folder-ref');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('folder-menu-rename').click();
  const dialog = page.getByTestId('folder-action-rename');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const input = dialog.locator('#folder-action-value');
  await expect(input).toBeFocused();

  // The scrim, not a desk control, is what the pointer lands on out there.
  const folderBox = (await folder.boundingBox())!;
  const overFolder = await page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return {
        scrim: Boolean(node?.closest('[data-testid="desk-dialog-scrim"]')),
        deskObject: Boolean(node?.closest('[data-desk-object]')),
      };
    },
    [folderBox.x + folderBox.width / 2, folderBox.y + folderBox.height / 2],
  );
  expect(overFolder.scrim).toBe(true);
  expect(overFolder.deskObject).toBe(false);

  // A real click out there activates nothing: no folder window opens, no desk
  // menu appears, and focus never leaves the dialog.
  await page.mouse.click(folderBox.x + folderBox.width / 2, folderBox.y + folderBox.height / 2);
  await page.mouse.dblclick(folderBox.x + folderBox.width / 2, folderBox.y + folderBox.height / 2);
  await expect(page.getByTestId('folder-window-folder:folder-ref')).toHaveCount(0);
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
  // …and the dialog is still open with the work in it, not silently dismissed.
  await expect(dialog).toBeVisible();
  await expect(input).toBeFocused();

  // The dock is a desk-local layer too — it must not be clickable through.
  const dock = (await page.getByTestId('dock-generate').boundingBox())!;
  const overDock = await page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return Boolean(node?.closest('[data-testid="desk-dialog-scrim"]'));
    },
    [dock.x + dock.width / 2, dock.y + dock.height / 2],
  );
  expect(overDock).toBe(true);

  // Search still wins the layer contract over the scrim.
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByTestId('search-dialog');
  await expect(search).toBeVisible();
  const searchBox = (await search.boundingBox())!;
  const topmostIsSearch = await page.evaluate(
    ([x, y]) => {
      const node = document.elementFromPoint(x as number, y as number);
      return Boolean(node?.closest('[data-testid="search-dialog"]'));
    },
    [searchBox.x + searchBox.width / 2, searchBox.y + 40],
  );
  expect(topmostIsSearch).toBe(true);
});

test('the new-folder prompt blocks the pointer from the desk as well', async ({ page }) => {
  await openDesk(page, { width: 1280, height: 720 });
  await page.locator('[data-desk-plane]').focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('new-folder-prompt')).toBeVisible();

  const folder = page.getByTestId('folder-target-folder-ref');
  const box = (await folder.boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('folder-window-folder:folder-ref')).toHaveCount(0);
  await expect(page.getByTestId('new-folder-prompt')).toBeVisible();
  await expect(page.locator('#new-folder-name')).toBeFocused();
});

test('opening a folder from the keyboard menu leaves focus on the folder icon', async ({
  page,
}) => {
  await openDesk(page);
  const folder = page.getByTestId('folder-target-folder-ref');
  await folder.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Открыть' }).click();
  await expect(page.getByTestId('folder-window-folder:folder-ref')).toBeVisible();
  await expect(folder).toBeFocused();
});

/* ─── 7. No misleading menu on objects that have none ────────────────────── */

for (const object of [
  { name: 'a media icon', testId: 'desk-item-media-media-1' },
  { name: 'a document icon', testId: 'desk-item-script-script-1' },
  { name: 'the Недавние system folder', testId: 'recent-folder' },
  { name: 'the Кадры system folder', testId: 'frames-folder' },
]) {
  test(`Shift+F10 on ${object.name} opens no menu at all`, async ({ page }) => {
    await openDesk(page);
    await page.getByTestId(object.testId).focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
    await expect(page.getByTestId('folder-context-menu')).toHaveCount(0);
  });

  test(`the ContextMenu key on ${object.name} opens no menu at all`, async ({ page }) => {
    await openDesk(page);
    await page.getByTestId(object.testId).focus();
    await page.keyboard.press('ContextMenu');
    await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);
    await expect(page.getByTestId('folder-context-menu')).toHaveCount(0);
  });
}

/* ─── 8. Asset previews open from the keyboard ───────────────────────────── */

for (const key of ['Enter', ' ']) {
  test(`${key === ' ' ? 'Space' : key} on a folder-window asset preview opens that exact asset`, async ({
    page,
  }) => {
    await openDesk(page);
    await openFolderWindow(page);
    const preview = page.getByTestId(`asset-preview-${folderAsset.id}`);
    await expect(preview).toBeVisible();
    await preview.focus();
    await page.keyboard.press(key);
    await page.waitForURL(/\/workspace\/conv-project\/media\/asset-ref-1/);
  });
}

test('a single pointer click on an asset preview still does not navigate', async ({ page }) => {
  await openDesk(page);
  await openFolderWindow(page);
  await page.getByTestId(`asset-preview-${folderAsset.id}`).click();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/workspace\/conv-project$/);
  // The labelled action button keeps its own behaviour. `exact` matters: the
  // preview is now a button too, named «Открыть РЕФ_СВЕТ».
  await page
    .getByTestId(`asset-card-${folderAsset.id}`)
    .getByRole('button', { name: 'Открыть', exact: true })
    .click();
  await page.waitForURL(/\/workspace\/conv-project\/media\/asset-ref-1/);
});

/* ─── 12. Reduced motion ─────────────────────────────────────────────────── */

test.describe('under prefers-reduced-motion: reduce', () => {
  test('the drag ghost neither transitions nor bounces back', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDesk(page);
    await openFolderWindow(page);
    const card = page.getByTestId(`asset-card-${folderAsset.id}`);
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await card.dispatchEvent('dragstart', { dataTransfer: transfer });

    const ghost = page.getByTestId('drag-verb');
    await expect(ghost).toBeVisible();
    expect(await ghost.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
    await card.dispatchEvent('dragend', { dataTransfer: transfer });

    // Miss the drop: the failure state must stay legible without animating.
    await card.dragTo(page.getByTestId('recent-folder'));
    await expect(ghost).toBeVisible();
    const failed = await ghost.evaluate((node) => {
      const style = getComputedStyle(node);
      return { animationName: style.animationName, opacity: style.opacity };
    });
    expect(failed.animationName).toBe('none');
    expect(Number(failed.opacity)).toBeLessThan(1);
    expect(Number(failed.opacity)).toBeGreaterThan(0);
  });
});

test('with motion allowed the drag ghost still animates its bounce-back', async ({ page }) => {
  await openDesk(page);
  await openFolderWindow(page);
  const card = page.getByTestId(`asset-card-${folderAsset.id}`);
  await card.dragTo(page.getByTestId('recent-folder'));
  const ghost = page.getByTestId('drag-verb');
  await expect(ghost).toBeVisible();
  expect(await ghost.evaluate((node) => getComputedStyle(node).animationName)).not.toBe('none');
});
