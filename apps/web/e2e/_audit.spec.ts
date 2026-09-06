import { expect, test, type Page, type Route } from '@playwright/test';

// TEMPORARY audit spec — used to confirm §1/§2 defects in real Chromium at
// 1280x720 and 1440x900. Deleted before the final gate.

type Position = { itemKind: string; itemId: string; x: number; y: number };

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installDeskFixture(page: Page) {
  const now = new Date().toISOString();
  let positions: Position[] = [];
  let revision = 0;
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'audit-zero-spend',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/v1/projects/audit-project') {
      return json(route, {
        id: 'audit-project',
        title: 'Клип «Восход»',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: 'script-1',
        rooms: { scenario: 2, boards: 1, studio: 1, assets: 3 },
      });
    }
    if (path === '/v1/projects/audit-project/folders') {
      return json(route, {
        folders: [
          {
            id: 'folder-ref',
            name: 'Референсы',
            ord: 0,
            count: 2,
            childCount: 1,
            version: 1,
            parentId: null,
            createdAt: now,
          },
          {
            id: 'folder-music',
            name: 'Музыка',
            ord: 1,
            count: 1,
            childCount: 0,
            version: 1,
            parentId: null,
            createdAt: now,
          },
        ],
        limit: 24,
      });
    }
    if (path === '/v1/projects/audit-project/recents')
      return json(route, { items: [], nextCursor: null });
    if (path === '/v1/projects/audit-project/desk-items') {
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
            type: 'board',
            id: 'board-1',
            title: 'Раскадровка',
            createdAt: now,
            updatedAt: now,
            sortAt: now,
            href: '/boards/board-1',
          },
          {
            type: 'studio',
            id: 'studio-1',
            title: 'Монтаж v1',
            createdAt: now,
            updatedAt: now,
            sortAt: now,
            href: '/studio/studio-1',
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
    if (path === '/v1/projects/audit-project/desk-layout') {
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
    if (path === '/v1/credits/balance') return json(route, { available: 120 });
    if (path === '/v1/search') {
      return json(route, {
        query: 'вос',
        page: 1,
        limit: 10,
        total: 2,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
        scope: { kind: 'project', projectId: 'audit-project' },
        groups: [
          {
            type: 'script',
            items: [
              {
                type: 'script',
                id: 'script-1',
                title: 'Сценарий: Восход',
                href: '/scenario/script-1?projectId=audit-project',
                mediaKind: null,
                thumbnailUrl: null,
                projects: [{ id: 'audit-project', title: 'Клип «Восход»' }],
                projectCount: 1,
                association: 'single',
                updatedAt: now,
              },
            ],
          },
          {
            type: 'media',
            items: [
              {
                type: 'media',
                id: 'media-1',
                title: 'Кадр 1',
                href: '/media/media-1',
                mediaKind: 'image',
                thumbnailUrl: null,
                projects: [
                  { id: 'audit-project', title: 'Клип «Восход»' },
                  { id: 'p2', title: 'Другой' },
                ],
                projectCount: 2,
                association: 'multiple',
                updatedAt: now,
              },
            ],
          },
        ],
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture_not_found', path }),
    });
  });
}

for (const vp of [
  { w: 1280, h: 720 },
  { w: 1440, h: 900 },
]) {
  test(`audit desk @ ${vp.w}x${vp.h}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await installDeskFixture(page);
    await page.goto('/workspace/audit-project');
    await expect(page.getByTestId('folder-target-folder-ref')).toBeVisible();
    await page.screenshot({
      path: `../../docs/evidence/sreda-desktop-ux/audit-before/desk-${vp.w}x${vp.h}.png`,
      fullPage: true,
    });

    // §1 — Enter opens the selected item?
    const results: Record<string, string> = {};
    // folder
    await page.getByTestId('folder-target-folder-ref').click();
    await page.keyboard.press('Enter');
    results['enter_folder'] = (await page.getByTestId('folder-window-folder:folder-ref').count())
      ? 'OPENS'
      : 'NO-OP';
    // close any window
    await page.keyboard.press('Escape').catch(() => {});
    // script doc
    await page.getByTestId('desk-item-script-script-1').click();
    const navPromise = page
      .waitForURL(/scenario\/script-1/, { timeout: 1500 })
      .then(() => 'NAVIGATES')
      .catch(() => 'NO-OP');
    await page.keyboard.press('Enter');
    results['enter_script'] = await navPromise;

    console.log('AUDIT_ENTER_RESULTS ' + JSON.stringify(results));
  });
}

test('audit folder right-click context menu', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installDeskFixture(page);
  await page.goto('/workspace/audit-project');
  await expect(page.getByTestId('folder-target-folder-ref')).toBeVisible();
  await page.getByTestId('folder-target-folder-ref').click({ button: 'right' });
  const menuCount = await page.getByTestId('desk-context-menu').count();
  const renameVisible = await page.getByRole('button', { name: /Переименовать/ }).count();
  console.log('AUDIT_FOLDER_CTX ' + JSON.stringify({ menuCount, renameVisible }));
});

test('audit search dialog', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installDeskFixture(page);
  await page.goto('/workspace/audit-project');
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder(/Проекты, сценарии/).fill('вос');
  await expect(page.getByRole('listbox')).toBeVisible({ timeout: 3000 });
  await page.screenshot({
    path: '../../docs/evidence/sreda-desktop-ux/audit-before/search-1280x720.png',
    fullPage: true,
  });
  // multi-project media association label present?
  const assoc = await page.getByText(/В 2 проектах|В \d проектах/).count();
  console.log('AUDIT_SEARCH ' + JSON.stringify({ multiProjectLabel: assoc }));
});
