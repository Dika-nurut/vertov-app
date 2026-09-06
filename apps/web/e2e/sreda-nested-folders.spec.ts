import { expect, test, type Page, type Route } from '@playwright/test';
import { resolve } from 'node:path';

interface MockFolder {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  ord: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  count: number;
  childCount: number;
}

const now = '2026-07-24T12:00:00.000Z';
const evidenceDir = resolve(process.cwd(), '../../docs/evidence/sreda-nested-folders/2026-07-24');

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function nestedDesk(
  page: Page,
  options: { extraChildren?: number; delayedFolderId?: string; failedFolderId?: string } = {},
) {
  let sequence = 3;
  const folders: MockFolder[] = [
    folder('campaign', null, 'Кампания', 0),
    folder('archive', null, 'Архив', 1),
    folder('scene', 'campaign', 'Сцена 01', 0),
    folder('takes', 'scene', 'Дубли', 0),
  ];
  for (let index = 0; index < (options.extraChildren ?? 0); index += 1) {
    folders.push(folder(`extra-${index}`, 'campaign', `Дополнительно ${index + 1}`, index + 2));
  }
  const updateCounts = () => {
    for (const item of folders) {
      item.childCount = folders.filter((candidate) => candidate.parentId === item.id).length;
    }
  };
  updateCounts();

  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'nested-folder-session',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/v1/projects/mock-nested') {
      return json(route, {
        id: 'mock-nested',
        title: 'Рекламный ролик',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: null,
        rooms: { scenario: 0, boards: 0, studio: 0, assets: 0 },
      });
    }
    if (path === '/v1/projects/mock-nested/folders') {
      if (request.method() === 'POST') {
        const body = request.postDataJSON() as { name: string; parentId: string | null };
        sequence += 1;
        const created = folder(`folder-${sequence}`, body.parentId, body.name, sequence);
        folders.push(created);
        updateCounts();
        return json(route, created, 201);
      }
      return json(route, { folders, limit: 24 });
    }
    if (path === '/v1/projects/mock-nested/recents') {
      return json(route, { items: [], nextCursor: null });
    }
    if (path === '/v1/projects/mock-nested/desk-items') {
      return json(route, {
        items: [],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scenario: false, boards: false, studio: false },
        retention: { mode: 'expiring', reminder: 'Хранится 30 дней' },
      });
    }
    if (path === '/v1/projects/mock-nested/desk-layout') {
      return request.method() === 'PUT'
        ? json(route, { ok: true, revision: request.postDataJSON().revision })
        : json(route, { revision: 0, positions: [] });
    }
    if (path === '/v1/assets/usage') return json(route, { usages: {} });
    if (path === '/v1/credits/balance') return json(route, { available: 100 });
    const assetsMatch = path.match(/^\/v1\/folders\/([^/]+)\/assets$/);
    if (assetsMatch) {
      if (assetsMatch[1] === options.delayedFolderId) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      if (assetsMatch[1] === options.failedFolderId) {
        return json(route, { error: 'folder_unavailable' }, 503);
      }
      return json(route, { items: [], nextCursor: null });
    }
    const folderMatch = path.match(/^\/v1\/folders\/([^/]+)$/);
    if (folderMatch && request.method() === 'PATCH') {
      const current = folders.find((item) => item.id === folderMatch[1]);
      if (!current) return json(route, { error: 'not_found' }, 404);
      const body = request.postDataJSON() as {
        name?: string;
        parentId?: string | null;
        expectedVersion?: number;
      };
      if (body.expectedVersion !== undefined && body.expectedVersion !== current.version) {
        return json(route, { error: 'stale_folder', currentVersion: current.version }, 409);
      }
      if (body.name !== undefined) current.name = body.name;
      if (body.parentId !== undefined) current.parentId = body.parentId;
      current.version += 1;
      current.updatedAt = now;
      updateCounts();
      return json(route, current);
    }
    if (folderMatch && request.method() === 'DELETE') {
      const root = folders.find((item) => item.id === folderMatch[1]);
      if (!root) return json(route, { error: 'not_found' }, 404);
      const removed = new Set([root.id]);
      for (let index = 0; index < folders.length; index += 1) {
        if (folders[index]?.parentId && removed.has(folders[index]!.parentId!)) {
          removed.add(folders[index]!.id);
        }
      }
      const before = folders.length;
      for (let index = folders.length - 1; index >= 0; index -= 1) {
        if (removed.has(folders[index]!.id)) folders.splice(index, 1);
      }
      updateCounts();
      return json(route, {
        ok: true,
        foldersDeleted: before - folders.length,
        placementsRemoved: 0,
        assetsDeleted: 0,
      });
    }
    return json(route, { error: 'mock_not_found', path }, 404);
  });
  await page.goto('/workspace/mock-nested');
  await expect(page.getByTestId('workspace-desk')).toBeVisible();
  return folders;
}

function folder(id: string, parentId: string | null, name: string, ord: number): MockFolder {
  return {
    id,
    projectId: 'mock-nested',
    parentId,
    name,
    ord,
    version: 1,
    createdAt: now,
    updatedAt: now,
    count: 0,
    childCount: 0,
  };
}

test('desktop journey: opens three levels, follows breadcrumbs, creates and renames a child', async ({
  page,
}) => {
  await nestedDesk(page);
  await page.getByTestId('folder-target-campaign').dblclick();
  const window = page.getByTestId('folder-window-folder:campaign');
  await expect(window).toBeVisible();
  const scene = window.getByTestId('nested-folder-scene');
  await scene.click();
  await expect(scene).toHaveAttribute('aria-pressed', 'true');
  await expect(window.getByTestId('nested-folder-takes')).toHaveCount(0);
  await scene.dblclick();
  await window.getByTestId('nested-folder-takes').dblclick();
  await expect(window.getByRole('navigation', { name: 'Путь к папке' })).toContainText(
    'Рекламный ролик/Кампания/Сцена 01/Дубли',
  );
  await expect(window.getByTestId('folder-breadcrumb-root')).toBeVisible();
  await expect(window.getByTestId('folder-window-empty')).toBeVisible();

  await window.getByRole('button', { name: /Новая вложенная/ }).click();
  await page.getByTestId('folder-action-create').locator('input').fill('  Финал  ');
  await page.getByTestId('folder-action-create').getByRole('button', { name: 'Сохранить' }).click();
  await expect(window.getByTestId('nested-folder-folder-4')).toContainText('Финал');

  await window.getByRole('button', { name: 'Переименовать' }).click();
  const rename = page.getByTestId('folder-action-rename');
  await rename.locator('input').fill('Дубли героя');
  await rename.getByRole('button', { name: 'Сохранить' }).click();
  await expect(window.getByTestId('folder-breadcrumb-takes')).toHaveText('Дубли героя');
  await page.screenshot({ path: resolve(evidenceDir, 'three-level-folder-window.png') });
});

test('desktop journey: accessible move returns a nested folder to root and delete explains retention', async ({
  page,
}) => {
  const folders = await nestedDesk(page);
  await page.getByTestId('folder-target-campaign').dblclick();
  const window = page.getByTestId('folder-window-folder:campaign');
  await window.getByTestId('nested-folder-scene').dblclick();
  await window.getByRole('button', { name: 'Переместить…' }).click();
  const move = page.getByTestId('folder-action-move');
  await move.locator('select').selectOption('__project_root__');
  await move.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByTestId('folder-target-scene')).toBeVisible();
  expect(folders.find((item) => item.id === 'scene')?.parentId).toBeNull();

  await window.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByTestId('folder-target-campaign').dblclick();
  const rootWindow = page.getByTestId('folder-window-folder:campaign');
  await rootWindow.getByRole('button', { name: 'Удалить…' }).click();
  const deletion = page.getByTestId('folder-action-delete');
  await expect(deletion).toContainText('Сами материалы останутся в библиотеке проекта');
  await deletion.getByRole('button', { name: 'Удалить папку' }).click();
  await expect(page.getByTestId('folder-target-campaign')).toHaveCount(0);
  await expect(page.getByTestId('desk-receipt')).toContainText('материалы остались в проекте');
});

test('desktop journey: folder tiles are drag targets for nesting', async ({ page }) => {
  const folders = await nestedDesk(page);
  await page
    .getByTestId('folder-target-campaign')
    .dragTo(page.getByTestId('folder-target-archive'));
  await expect(page.getByTestId('desk-receipt')).toContainText('Папка перемещена');
  await expect(page.getByTestId('folder-target-campaign')).toHaveCount(0);
  expect(folders.find((item) => item.id === 'campaign')?.parentId).toBe('archive');

  await page.getByTestId('folder-target-archive').dblclick();
  await expect(
    page.getByTestId('folder-window-folder:archive').getByTestId('nested-folder-campaign'),
  ).toBeVisible();
});

test('desktop journey: folder windows expose loading, overflow, and recoverable error states', async ({
  page,
}) => {
  await nestedDesk(page, { extraChildren: 13, delayedFolderId: 'campaign' });
  await page.getByTestId('folder-target-campaign').dblclick();
  const window = page.getByTestId('folder-window-folder:campaign');
  await expect(window.getByTestId('folder-window-loading')).toBeVisible();
  await expect(window.getByTestId('folder-overflow')).toBeVisible();

  await page.unrouteAll({ behavior: 'wait' });
  await nestedDesk(page, { failedFolderId: 'campaign' });
  await page.getByTestId('folder-target-campaign').dblclick();
  await expect(page.getByTestId('folder-window-error')).toContainText('Не удалось открыть папку');
  await expect(
    page.getByTestId('folder-window-error').getByRole('button', { name: 'Повторить' }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, 'folder-error-state.png') });
});
