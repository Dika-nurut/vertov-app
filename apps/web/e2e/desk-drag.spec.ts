import { expect, test, type Page, type Route } from '@playwright/test';

// Playwright's synthesized drop events do not exercise the browser's native
// drag-and-drop state machine. This spec therefore covers the React handler
// contract explicitly: its cancelable dragover must be prevented before the
// synthetic addressed-drop flow below can be considered meaningful.

const asset = {
  id: 'asset-1',
  assetUrl: '/landing/kadr-neon-city.webp',
  thumbnailUrl: null,
  kind: 'image',
  title: 'РЕФ_СВЕТ',
  originalName: 'реф_свет.png',
  sourceKind: 'upload',
  sourceLine: 'загрузка',
  mimeType: 'image/png',
  createdAt: new Date().toISOString(),
  addedAt: new Date().toISOString(),
};

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockDesk(
  page: Page,
  options: {
    empty?: boolean;
    deleteRefusal?: boolean;
    duplicateUpload?: boolean;
    truncated?: boolean;
    recentCreatedAt?: string;
    recentAddedAt?: string;
    layoutPositions?: Array<{
      itemKind: string;
      itemId: string;
      x: number;
      y: number;
    }>;
  } = {},
) {
  const calls = {
    placements: 0,
    removals: 0,
    uploads: 0,
    deletes: 0,
    reorders: 0,
    folders: 0,
    layoutWrites: [] as Array<{
      revision: number;
      positions: Array<{ itemKind: string; itemId: string; x: number; y: number }>;
    }>,
  };
  let layoutPositions = [...(options.layoutPositions ?? [])];
  let layoutRevision = 0;
  const recentAssets: Array<typeof asset> = options.empty
    ? []
    : [
        {
          ...asset,
          createdAt: options.recentCreatedAt ?? asset.createdAt,
          addedAt: options.recentAddedAt ?? asset.addedAt,
        },
      ];
  const folderAssets: Array<typeof asset> = options.empty ? [] : [asset];
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'desk-e2e-session',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/v1/projects') {
      return json(route, {
        items: [
          {
            id: 'mock-floor',
            title: 'Ночное кафе',
            productionFormat: { aspect: '16:9' },
            rooms: { scenario: 4, boards: 1, studio: 1, assets: 1 },
          },
        ],
      });
    }
    if (path === '/v1/projects/mock-floor') {
      return json(route, {
        id: 'mock-floor',
        title: 'Ночное кафе',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: null,
        rooms: { scenario: 1, boards: 1, studio: 1, assets: options.empty ? 0 : 1 },
      });
    }
    if (path === '/v1/projects/mock-floor/folders') {
      if (request.method() === 'POST') {
        calls.folders += 1;
        const name = (request.postDataJSON() as { name: string }).name;
        const folder = { id: `folder-created-${calls.folders}`, name, ord: 1, count: 0 };
        return json(route, folder, 201);
      }
      return json(route, {
        folders: options.empty
          ? []
          : [{ id: 'folder-1', name: 'Референсы', ord: 0, count: folderAssets.length }],
        limit: 24,
      });
    }
    if (path === '/v1/projects/mock-floor/recents') {
      return json(route, { items: recentAssets, nextCursor: null });
    }
    if (path === '/v1/projects/mock-floor/desk-items') {
      const documents = options.empty
        ? []
        : [
            {
              type: 'script',
              id: 'script-1',
              title: 'Пилот',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              sortAt: new Date().toISOString(),
              href: '/scenario/script-1',
            },
            {
              type: 'board',
              id: 'board-1',
              title: 'Сцена у кафе',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              sortAt: new Date().toISOString(),
              href: '/boards/board-1',
            },
          ];
      const surfaceMedia = recentAssets.map((item) => ({
        type: 'media',
        id: item.id,
        sortAt: item.addedAt,
        asset: item,
      }));
      return json(route, {
        items: [...surfaceMedia, ...documents],
        apps: {
          scenario: documents.filter((item) => item.type === 'script'),
          boards: documents.filter((item) => item.type === 'board'),
          studio: options.empty
            ? []
            : [
                {
                  type: 'studio',
                  id: 'studio-1',
                  title: 'Финальный монтаж',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  href: '/studio/studio-1',
                },
              ],
        },
        truncated: {
          media: Boolean(options.truncated),
          scenario: Boolean(options.truncated),
          boards: Boolean(options.truncated),
          studio: Boolean(options.truncated),
        },
        retention: {
          mode: 'expiring',
          reminder: 'Хранится 30 дней · Скачать · Оставить навсегда → тариф',
        },
      });
    }
    if (path === '/v1/projects/mock-floor/desk-layout') {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON() as {
          revision: number;
          positions: Array<{ itemKind: string; itemId: string; x: number; y: number }>;
        };
        const { positions } = body;
        calls.layoutWrites.push(body);
        const byKey = new Map(
          layoutPositions.map((position) => [`${position.itemKind}:${position.itemId}`, position]),
        );
        if (body.revision > layoutRevision) {
          for (const position of positions) {
            byKey.set(`${position.itemKind}:${position.itemId}`, position);
          }
          layoutPositions = [...byKey.values()];
          layoutRevision = body.revision;
        }
        return json(route, {
          ok: true,
          persisted: positions.length,
          revision: body.revision,
          updatedAt: new Date().toISOString(),
        });
      }
      return json(route, { revision: layoutRevision, positions: layoutPositions });
    }
    if (path === '/v1/projects/mock-floor/media/asset-1') {
      return json(route, { asset });
    }
    if (path === '/v1/assets/usage') {
      return json(route, {
        usages: Object.fromEntries(
          recentAssets.map((item) => [
            item.id,
            folderAssets.some((folderAsset) => folderAsset.id === item.id) ? ['Референсы'] : [],
          ]),
        ),
      });
    }
    if (path === '/v1/credits/balance') {
      return json(route, { available: 1240 });
    }
    if (path === '/v1/folders/folder-1/assets') {
      return json(route, {
        items: folderAssets.map((item) => ({ asset: item, placedAt: new Date().toISOString() })),
        nextCursor: null,
      });
    }
    if (path === '/v1/assets/asset-1/placements' && request.method() === 'POST') {
      calls.placements += 1;
      if (!folderAssets.some((item) => item.id === asset.id)) folderAssets.push(asset);
      return json(route, { ok: true, created: true, destination: { id: 'folder-1' } });
    }
    if (path === '/v1/folders/folder-1' && request.method() === 'PATCH') {
      calls.reorders += 1;
      return json(route, { id: 'folder-1' });
    }
    if (path === '/v1/assets/asset-1/placements/new-folder') {
      calls.placements += 1;
      return json(
        route,
        {
          ok: true,
          folder: { id: 'folder-new', name: 'Отбор', ord: 1, count: 1 },
        },
        201,
      );
    }
    if (path === '/v1/assets/asset-1/placements/folder-1' && request.method() === 'DELETE') {
      calls.removals += 1;
      folderAssets.splice(
        folderAssets.findIndex((item) => item.id === asset.id),
        1,
      );
      return json(route, {
        ok: true,
        removed: true,
        undo: { assetId: 'asset-1', folderId: 'folder-1' },
      });
    }
    if (path === '/v1/assets/asset-1' && request.method() === 'DELETE') {
      calls.deletes += 1;
      if (options.deleteRefusal) {
        return json(
          route,
          {
            error: 'asset_in_use',
            count: 2,
            usages: [
              { type: 'studio_clip', refId: 'studio-ref-1' },
              { type: 'board_node', refId: 'board-ref-1' },
            ],
          },
          409,
        );
      }
      recentAssets.splice(
        recentAssets.findIndex((item) => item.id === asset.id),
        1,
      );
      folderAssets.splice(
        folderAssets.findIndex((item) => item.id === asset.id),
        1,
      );
      return json(route, { ok: true, undoUntil: new Date(Date.now() + 15_000).toISOString() });
    }
    if (path === '/v1/projects/mock-floor/assets/preflight') {
      const files = (request.postDataJSON() as { files: Array<{ name: string }> }).files;
      return json(route, {
        accepted: files.map((file, index) => ({ index, name: file.name })),
        rejected: [],
        canUpload: true,
      });
    }
    if (path === '/v1/projects/mock-floor/assets') {
      calls.uploads += 1;
      const folderId = url.searchParams.get('folderId');
      const name = url.searchParams.get('name') ?? 'кадр.png';
      const reused = options.duplicateUpload === true && name === 'дубль.png';
      const uploadedAsset = {
        ...asset,
        id: reused ? asset.id : `asset-upload-${calls.uploads}`,
        title: 'КАДР',
        originalName: name,
        createdAt: new Date().toISOString(),
        addedAt: new Date().toISOString(),
      };
      if (!reused && !recentAssets.some((item) => item.id === uploadedAsset.id))
        recentAssets.push(uploadedAsset);
      if (
        !reused &&
        folderId === 'folder-1' &&
        !folderAssets.some((item) => item.id === uploadedAsset.id)
      ) {
        folderAssets.push(uploadedAsset);
      }
      return json(
        route,
        {
          assetId: uploadedAsset.id,
          destinationId: folderId,
          reused,
          alreadyMember: reused,
          receipt: reused ? 'Уже в этом проекте' : 'Материал загружен',
        },
        reused ? 200 : 201,
      );
    }
    return json(route, { error: 'mock_not_found', path }, 404);
  });
  await page.goto('/workspace/mock-floor');
  await expect(page.getByTestId('workspace-desk')).toBeVisible();
  return calls;
}

test('targeted drag highlights only addressed targets, labels the verb, places, and bounces misses', async ({
  page,
}) => {
  const calls = await mockDesk(page);
  await page.getByTestId('recent-folder').dblclick();
  const card = page.getByTestId('asset-card-asset-1');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', { dataTransfer: transfer });
  await expect(page.getByTestId('drag-verb')).toContainText('Добавить в папку');
  const smartFolderOpacity = await page
    .getByTestId('recent-folder')
    .evaluate((node) => getComputedStyle(node).opacity);
  expect(Number(smartFolderOpacity)).toBeLessThan(0.5);
  const targetOutline = await page
    .getByTestId('folder-target-folder-1')
    .locator('span')
    .first()
    .evaluate((node) => getComputedStyle(node).outlineStyle);
  expect(targetOutline).toBe('solid');
  const target = page.getByTestId('folder-target-folder-1');
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  const hotShadow = await target
    .locator('span')
    .first()
    .evaluate((node) => getComputedStyle(node).boxShadow);
  expect(hotShadow).not.toBe('none');
  const targetChild = await target.locator('span').first().elementHandle();
  await target.dispatchEvent('dragleave', {
    dataTransfer: transfer,
    relatedTarget: targetChild,
  });
  await expect
    .poll(() =>
      target
        .locator('span')
        .first()
        .evaluate((node) => getComputedStyle(node).boxShadow),
    )
    .toBe(hotShadow);
  await card.dispatchEvent('dragend', { dataTransfer: transfer });

  await card.dragTo(page.getByTestId('folder-target-folder-1'));
  await expect(page.getByTestId('desk-receipt')).toContainText('Добавлено в папку');
  expect(calls.placements).toBe(1);

  await card.dragTo(page.getByTestId('recent-folder'));
  expect(calls.placements).toBe(1);
  await expect(page.getByTestId('recent-folder')).toHaveText('Недавние');
  await expect(page.getByTestId('drag-verb')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('drag-verb')).toBeHidden();
});

test('an OS file drop uploads as one addressed folder batch', async ({ page }) => {
  const calls = await mockDesk(page);
  await page.getByTestId('folder-target-folder-1').dblclick();
  const openFolder = page.getByTestId('folder-window-folder:folder-1');
  await expect(openFolder).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'кадр.png', {
        type: 'image/png',
      }),
    );
    return data;
  });
  await page.getByTestId('workspace-desk').dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(page.getByTestId('drag-verb')).toContainText('Загрузить');
  const target = page.getByTestId('folder-target-folder-1');
  const dragoverPrevented = await target.evaluate((node) => {
    const event = new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      dataTransfer: new DataTransfer(),
    });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(dragoverPrevented).toBe(true);
  await target.dispatchEvent('dragenter', { dataTransfer: transfer });
  await target.dispatchEvent('dragover', { dataTransfer: transfer });
  await target.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('desk-receipt')).toContainText('Материалы загружены');
  await expect(openFolder.getByTestId('asset-card-asset-upload-1')).toBeVisible();
  expect(calls.uploads).toBe(1);
});

test('an OS file drop on the empty desk uploads unfiled and shows the retention reminder', async ({
  page,
}) => {
  const calls = await mockDesk(page, { empty: true });
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'на_стол.png', {
        type: 'image/png',
      }),
    );
    return data;
  });
  const desk = page.getByTestId('workspace-desk');
  await desk.dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(page.getByTestId('desk-drop-target')).toContainText('НА СТОЛ');
  await desk.dispatchEvent('dragover', { dataTransfer: transfer });
  await desk.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.getByTestId('desk-receipt')).toContainText('Материалы загружены');
  await expect(page.getByTestId('retention-reminder')).toHaveText(
    'Хранится 30 дней · Скачать · Оставить навсегда → тариф',
  );
  await expect(page.getByTestId('desk-item-media-asset-upload-1')).toBeVisible();
  expect(calls.uploads).toBe(1);
});

test('dock single-click launches real app routes and files open full-screen in native viewers', async ({
  page,
}) => {
  await mockDesk(page);
  const looseMedia = page.getByTestId('desk-item-media-asset-1');
  await expect(looseMedia).toBeVisible();
  await expect(page.getByTestId('desk-item-script-script-1')).toBeVisible();
  await expect(page.getByTestId('desk-item-board-board-1')).toBeVisible();
  await looseMedia.dblclick();
  await page.waitForURL('**/workspace/mock-floor/media/asset-1');
  await expect(page.getByTestId('media-viewer')).toContainText('РЕФ_СВЕТ');
  await expect(page.getByRole('link', { name: '← НА СТОЛ' })).toHaveAttribute(
    'href',
    '/workspace/mock-floor',
  );
  await page.getByRole('link', { name: '← НА СТОЛ' }).click();
  await expect(page.getByTestId('workspace-desk')).toBeVisible();
  // NB the resolved-document paths listed here never actually fire: Playwright
  // does not route the target a fulfilled 303 redirects to, so those three land
  // on the real route. They are kept in the pattern so the intent is legible and
  // so this stub starts working if that behaviour ever changes; the loop below
  // is written not to depend on it either way.
  await page.route(
    /\/(scenario(?:\/(?:new|script-1|resolved-script))?|boards(?:\/resolved-board)?|studio\/(?:projects|resolved-studio)|generate|gallery)\?projectId=mock-floor$/,
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue();
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<main>APP</main>' });
    },
  );
  await page.route(
    /\/workspace\/resolve\/(scenario|boards|studio)\?projectId=mock-floor$/,
    async (route) => {
      const product = route
        .request()
        .url()
        .match(/resolve\/(scenario|boards|studio)/)?.[1];
      const destination =
        product === 'scenario'
          ? '/scenario/new?projectId=mock-floor'
          : product === 'boards'
            ? '/boards/resolved-board?projectId=mock-floor'
            : '/studio/resolved-studio?projectId=mock-floor';
      return route.fulfill({ status: 303, headers: { location: destination } });
    },
  );
  const routes = [
    ['scenario', '/scenario/new'],
    ['boards', '/boards/resolved-board'],
    ['studio', '/studio/resolved-studio'],
    ['generate', '/generate'],
    ['gallery', '/gallery'],
  ] as const;
  for (const [key, pathname] of routes) {
    await page.getByTestId(`dock-${key}`).click({ noWaitAfter: true });
    // A resolving tile POSTs and lands via a 303, so the URL becomes the
    // destination while that document is still being fetched. Neither polling
    // page.url() nor waitForURL is enough — both can pass at the redirect's
    // commit — and going back to the desk then aborts the in-flight load, which
    // Playwright reports as ERR_ABORTED on the goto. Intermittently: the same
    // spec passed 17/17 twice before failing three runs in a row.
    //
    // So wait for the destination to RENDER, then read the URL. That is
    // unambiguous, and it asserts something stronger than a URL change: the
    // tile really landed on a document rather than merely repointing the
    // address bar.
    //
    // Deliberately not asserting the stub's «APP» body: verified from the
    // trace, page.route does NOT intercept the target a fulfilled 303 redirects
    // to, so the three resolving tiles land on the real route (a 404 here,
    // there being no `resolved-board`). What this loop is for is that the tile
    // resolves and navigates — which page + URL prove. Any <main> means a
    // document rendered.
    await expect(page.getByTestId(`dock-${key}`)).toHaveCount(0);
    await expect(page.locator('main')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(pathname);
    expect(new URL(page.url()).searchParams.get('projectId')).toBe('mock-floor');
    await page.goto('/workspace/mock-floor');
    await expect(page.getByTestId('workspace-desk')).toBeVisible();
  }

  await page.getByTestId('desk-item-script-script-1').dblclick({ noWaitAfter: true });
  await expect.poll(() => new URL(page.url()).pathname).toBe('/scenario/script-1');
});

test('right-click empty desk creates a folder and exposes the keyboard-safe file picker', async ({
  page,
}) => {
  const calls = await mockDesk(page);
  await page.getByRole('region', { name: 'Рабочий стол проекта' }).click({
    button: 'right',
    position: { x: 700, y: 360 },
  });
  const menu = page.getByTestId('desk-context-menu');
  // Desk menus expose real menu/menuitem semantics (Goal 7 §1 keyboard access).
  await expect(menu.getByRole('menuitem', { name: 'Новая папка' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Добавить файлы…' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Новая папка' }).click();
  // The prompt is now a real dialog labelled by the same element as the input,
  // so `getByLabel` matches both. Address the field by its role.
  await page.getByRole('textbox', { name: 'НАЗВАНИЕ НОВОЙ ПАПКИ' }).fill('Отбор');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(page.getByTestId('desk-receipt')).toContainText('Папка создана');
  expect(calls.folders).toBe(1);
});

// NB the narrowing since the dock's resolving tiles became form buttons: this
// asserts only that the desk does not swallow the native context menu on the
// dock, as it deliberately does on desk objects. It no longer covers "open this
// app in a new tab" — a <button> has no link menu — because that behaviour was
// knowingly given up when the tiles had to POST (see DeskClient's dock comment).
test('right-click suppresses native menus on desk objects but not on the dock', async ({
  page,
}) => {
  await mockDesk(page);
  const objectPrevented = await page.getByTestId('recent-folder').evaluate((node) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(objectPrevented).toBe(true);
  await expect(page.getByTestId('desk-context-menu')).toHaveCount(0);

  const dockPrevented = await page.getByTestId('dock-scenario').evaluate((node) => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    node.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(dockPrevented).toBe(false);
});

test('no-drag upload uses the shelf; contextual removal offers undo', async ({ page }) => {
  const calls = await mockDesk(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'кадр.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await expect(page.getByTestId('upload-shelf')).toBeVisible();
  await expect(page.getByTestId('desk-receipt')).toContainText('Материалы загружены');
  await page.getByTestId('upload-shelf').click();
  await expect(page.getByText('На стол · Готово', { exact: true })).toBeVisible();
  await expect(page.getByText('done', { exact: true })).toHaveCount(0);
  expect(calls.uploads).toBe(1);

  await page.getByTestId('folder-target-folder-1').dblclick();
  await page
    .getByTestId('asset-card-asset-1')
    .getByRole('button', { name: 'Убрать из папки' })
    .click();
  await expect(page.getByTestId('desk-receipt')).toContainText('Убрано из папки');
  await expect(page.getByTestId('asset-card-asset-1')).toBeHidden();
  expect(calls.removals).toBe(1);
  await page.getByTestId('desk-receipt').getByRole('button', { name: 'Отменить' }).click();
  await expect(page.getByTestId('asset-card-asset-1')).toBeVisible();
  expect(calls.placements).toBe(1);

  await page
    .getByTestId('asset-card-asset-1')
    .getByRole('button', { name: 'Удалить материал' })
    .click();
  await expect(page.getByTestId('desk-receipt')).toContainText('Материал удалён');
  await expect(page.getByTestId('asset-card-asset-1')).toHaveCount(0);
  expect(calls.deletes).toBe(1);
});

test('delete refusal lists labeled production usages without invented links', async ({ page }) => {
  const calls = await mockDesk(page, { deleteRefusal: true });
  await page.getByTestId('folder-target-folder-1').dblclick();
  const card = page.getByTestId('asset-card-asset-1');
  await card.getByRole('button', { name: 'Удалить материал' }).click();

  await expect(page.getByTestId('desk-receipt')).toContainText(
    'Нельзя удалить: используется в 2 местах',
  );
  const usages = page.getByTestId('delete-refusal-usage');
  await expect(usages).toHaveText(['Студия · studio-ref-1', 'Борды · board-ref-1']);
  expect(await usages.evaluateAll((nodes) => nodes.every((node) => node.tagName === 'SPAN'))).toBe(
    true,
  );
  await expect(card).toBeVisible();
  expect(calls.deletes).toBe(1);
});

test('upload shelf annotates only duplicate files with their per-file receipt', async ({
  page,
}) => {
  await mockDesk(page, { duplicateUpload: true });
  await page.locator('input[type=file]').setInputFiles([
    {
      name: 'обычный.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    },
    {
      name: 'дубль.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    },
  ]);
  await expect(page.getByTestId('desk-receipt')).toContainText('уже были в библиотеке: 1');
  await page.getByTestId('upload-shelf').click();
  const shelf = page.getByTestId('upload-shelf-panel');
  await expect(shelf.getByText('обычный.png', { exact: true })).toBeVisible();
  await expect(shelf.getByText('дубль.png — Уже в этом проекте', { exact: true })).toBeVisible();
  await expect(shelf.getByText('обычный.png — Материал загружен', { exact: true })).toHaveCount(0);
});

test('completed unfiled batch opens Recents and marks it read', async ({ page }) => {
  await mockDesk(page);
  await page.locator('input[type=file]').setInputFiles({
    name: 'в_недавние.png',
    mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  await page.getByTestId('upload-shelf').click();
  await page.getByTestId('upload-shelf-panel').getByRole('button', { name: 'Открыть' }).click();
  await expect(page.getByTestId('folder-window-recents')).toBeVisible();
  expect(
    await page.evaluate(() => window.localStorage.getItem('sreda:recents-opened:mock-floor')),
  ).not.toBeNull();
});

test('Recents relative time uses membership addedAt without adding a desktop sublabel', async ({
  page,
}) => {
  const now = Date.now();
  await page.addInitScript(
    (openedAt) => {
      window.localStorage.setItem('sreda:recents-opened:mock-floor', openedAt);
    },
    new Date(now - 24 * 60 * 60 * 1000).toISOString(),
  );
  await mockDesk(page, {
    recentCreatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    recentAddedAt: new Date(now - 2 * 60 * 1000).toISOString(),
  });
  await expect(page.getByTestId('recent-folder')).toHaveText('Недавние');
  await page.getByTestId('recent-folder').dblclick();
  await expect(page.getByTestId('folder-window-recents')).toContainText('2 мин · загрузка');
});

test('empty desk teaches the addressed drag and upload paths', async ({ page }) => {
  await mockDesk(page, { empty: true });
  await expect(page.getByTestId('empty-teaching')).toHaveText(
    'Перетащите файлы сюда · Выбрать файлы',
  );
  await expect(page.getByRole('button', { name: 'Загрузить материалы' })).toHaveCount(0);
});

test('truncated desk sources link to their complete project-scoped products', async ({ page }) => {
  await mockDesk(page, { truncated: true });
  const notices = page.getByTestId('desk-overflow-notices');
  await expect(notices).toBeVisible();
  await expect(notices.getByRole('link')).toHaveCount(4);
  await expect(page.getByTestId('desk-overflow-media')).toHaveAttribute(
    'href',
    '/gallery?projectId=mock-floor',
  );
  await expect(page.getByTestId('desk-overflow-scenario')).toHaveAttribute(
    'href',
    '/scenario?projectId=mock-floor',
  );
  await expect(page.getByTestId('desk-overflow-boards')).toHaveAttribute(
    'href',
    '/boards?projectId=mock-floor',
  );
  await expect(page.getByTestId('desk-overflow-studio')).toHaveAttribute(
    'href',
    '/studio/projects?projectId=mock-floor',
  );
  await expect(notices).toContainText('Показаны первые 500');
});

test('approved desktop composition has one name-only plane and separate hover-lift dock tiles', async ({
  page,
}) => {
  await mockDesk(page);
  await expect(page.getByTestId('desk-exit')).toHaveText('ВЫЙТИ');
  await expect(page.getByText('ПРОЕКТ', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ВИД', { exact: true })).toHaveCount(0);
  await expect(page.getByText('ПОМОЩЬ', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Авто ·|Континуитет|Лаунчер/i)).toHaveCount(0);
  await expect(page.getByTestId('desk-items')).toContainText('Недавние');
  await expect(page.getByTestId('desk-items')).toContainText('Референсы');
  await expect(page.getByTestId('desk-items')).toContainText('IMG');
  await expect(page.getByTestId('desk-items')).toContainText('SCN');
  await expect(page.getByTestId('desk-items')).toContainText('BRD');

  const dock = page.getByRole('navigation', { name: 'Приложения' });
  const dockChrome = await dock.evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor,
    border: getComputedStyle(node).borderTopWidth,
  }));
  expect(dockChrome.border).toBe('0px');
  expect(dockChrome.background).toBe('rgba(0, 0, 0, 0)');
  await page.getByTestId('dock-generate').hover();
  await expect(page.getByText('Генерация', { exact: true })).toBeVisible();
  expect(
    await page.getByTestId('dock-generate').evaluate((node) => getComputedStyle(node).transform),
  ).not.toBe('none');
  await page.mouse.move(1000, 400);
  await page.screenshot({
    path: '../../docs/evidence/sreda-desktop-redesign/2026-07-22/project-desktop.png',
    fullPage: true,
  });
});

test('folder windows move by their hard-edged title bar', async ({ page }) => {
  await mockDesk(page);
  await page.getByTestId('folder-target-folder-1').dblclick();
  const folderWindow = page.getByTestId('folder-window-folder:folder-1');
  const before = await folderWindow.boundingBox();
  const bar = folderWindow.locator('header');
  const bounds = await bar.boundingBox();
  expect(before).not.toBeNull();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 80, bounds!.y + 18);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 180, bounds!.y + 78, { steps: 4 });
  await page.mouse.up();
  const after = await folderWindow.boundingBox();
  expect(after!.x).toBeGreaterThan(before!.x + 60);
  expect(after!.y).toBeGreaterThan(before!.y + 30);
});

test('home is a project desktop: single click selects and double click opens', async ({ page }) => {
  await mockDesk(page);
  await page.goto('/workspace');
  await expect(page.getByTestId('workspace-home')).toBeVisible();
  const project = page.getByTestId('workspace-project-mock-floor');
  await expect(project).toContainText('Ночное кафе');
  await expect(project).toContainText('16:9 · 4 сцены');
  await page.screenshot({
    path: '../../docs/evidence/sreda-desktop-redesign/2026-07-22/home-desktop.png',
    fullPage: true,
  });
  await project.click();
  await expect(page).toHaveURL(/\/workspace$/);
  await project.dblclick();
  await expect(page).toHaveURL(/\/workspace\/mock-floor$/);
});
