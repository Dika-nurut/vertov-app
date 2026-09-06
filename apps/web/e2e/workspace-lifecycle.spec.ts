import { expect, test, type Page, type Route } from '@playwright/test';

interface Project {
  id: string;
  title: string;
  productionFormat: { aspect: string };
  rooms: { scenario: number; boards: number; studio: number; assets: number };
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockWorkspace(page: Page) {
  let projects: Project[] = [];
  let trash: Array<Project & { deletedAt: string; purgeAfter: string }> = [];
  const calls = { create: 0, rename: 0, delete: 0, restore: 0, permanent: 0 };
  await page.context().addCookies([
    {
      name: 'better-auth.session_token',
      value: 'workspace-lifecycle-session',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/v1/projects' && request.method() === 'GET') {
      return json(route, { items: projects });
    }
    if (path === '/v1/projects' && request.method() === 'POST') {
      calls.create += 1;
      const { title } = request.postDataJSON() as { title: string };
      projects = [
        {
          id: 'project-1',
          title,
          productionFormat: { aspect: '16:9' },
          rooms: { scenario: 0, boards: 0, studio: 0, assets: 1 },
        },
      ];
      return json(route, { id: 'project-1' }, 201);
    }
    if (path === '/v1/projects/project-1' && request.method() === 'PATCH') {
      calls.rename += 1;
      const { title } = request.postDataJSON() as { title: string };
      projects = projects.map((project) => ({ ...project, title }));
      return json(route, projects[0]);
    }
    if (path === '/v1/projects/project-1' && request.method() === 'DELETE') {
      calls.delete += 1;
      trash = projects.map((project) => ({
        ...project,
        deletedAt: '2026-07-24T12:00:00.000Z',
        purgeAfter: '2026-08-23T12:00:00.000Z',
      }));
      projects = [];
      return json(route, {
        ok: true,
        alreadyTrashed: false,
        deletedAt: '2026-07-24T12:00:00.000Z',
        purgeAfter: '2026-08-23T12:00:00.000Z',
        retentionDays: 30,
      });
    }
    if (path === '/v1/projects/trash' && request.method() === 'GET') {
      return json(route, { retentionDays: 30, items: trash });
    }
    if (path === '/v1/projects/trash/project-1' && request.method() === 'GET') {
      return json(route, {
        ...trash[0],
        retentionDays: 30,
        recovery: {
          expected: { scripts: 0, boards: 0, studio: 0, media: 1 },
          restored: { scripts: 0, boards: 0, studio: 0, media: 0 },
          unavailable: { scripts: 0, boards: 0, studio: 0, media: 1 },
          partial: true,
        },
      });
    }
    if (path === '/v1/projects/project-1/restore' && request.method() === 'POST') {
      calls.restore += 1;
      const restored = trash[0]!;
      trash = [];
      projects = [restored];
      return json(route, {
        ok: true,
        project: { id: restored.id, title: restored.title },
        recovery: {
          expected: { scripts: 0, boards: 0, studio: 0, media: 1 },
          restored: { scripts: 0, boards: 0, studio: 0, media: 0 },
          unavailable: { scripts: 0, boards: 0, studio: 0, media: 1 },
          partial: true,
        },
        message: 'restored_partially',
      });
    }
    if (path === '/v1/projects/project-1/permanent' && request.method() === 'DELETE') {
      const { confirmation } = request.postDataJSON() as { confirmation: string };
      if (confirmation !== trash[0]?.title) {
        return json(route, { error: 'confirmation_mismatch' }, 400);
      }
      calls.permanent += 1;
      trash = [];
      return json(route, { ok: true, permanentlyDeleted: true });
    }
    if (path === '/v1/projects/project-1') {
      return json(route, {
        ...projects[0],
        primaryScriptId: null,
      });
    }
    if (path === '/v1/projects/project-1/folders') {
      return json(route, { folders: [], limit: 24 });
    }
    if (path === '/v1/projects/project-1/recents') {
      return json(route, { items: [], nextCursor: null });
    }
    if (path === '/v1/projects/project-1/desk-items') {
      return json(route, {
        items: [],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scripts: false, boards: false, studio: false },
        retention: { mode: 'permanent', reminder: null },
      });
    }
    if (path === '/v1/projects/project-1/desk-layout') {
      return request.method() === 'PUT'
        ? json(route, { ok: true, revision: request.postDataJSON().revision })
        : json(route, { revision: 0, positions: [] });
    }
    if (path === '/v1/assets/usage') return json(route, { usages: {} });
    if (path === '/v1/credits/balance') return json(route, { available: 0 });
    return json(route, { error: 'not_found' }, 404);
  });
  return calls;
}

test('empty user creates, renames, opens, returns, and deletes a project', async ({ page }) => {
  const calls = await mockWorkspace(page);
  await page.goto('/workspace');

  await expect(page.getByText('Проектов пока нет.')).toBeVisible();
  const firstProjectButton = page.getByRole('button', { name: 'Создать первый проект' });
  await firstProjectButton.click();
  const dialog = page.getByRole('dialog');
  const title = dialog.getByLabel('Название проекта');
  await expect(title).toBeFocused();
  await title.press('Escape');
  await expect(firstProjectButton).toBeFocused();
  await firstProjectButton.click();
  await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Введите название проекта.');
  expect(calls.create).toBe(0);

  await title.fill('Ночное кафе');
  await title.press('Enter');
  const project = page.getByTestId('workspace-project-project-1');
  await expect(project).toContainText('Ночное кафе');
  expect(calls.create).toBe(1);

  await project.press('F2');
  await expect(dialog).toContainText('Переименовать проект');
  await title.fill('Утреннее кафе');
  await title.press('Enter');
  await expect(project).toContainText('Утреннее кафе');
  expect(calls.rename).toBe(1);

  await project.focus();
  await project.press('Enter');
  await expect(page).toHaveURL(/\/workspace\/project-1$/, { timeout: 30_000 });
  // «ВЫЙТИ» is a shutdown, not a step back: it leaves Среда entirely for the
  // site (owner ruling 2026-07-27). The project list is part of Среда, so this
  // lifecycle returns to it the way a user would — through home's «Среда» tab.
  await page.getByTestId('desk-exit').click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/workspace');

  const returnedProject = page.getByTestId('workspace-project-project-1');
  await returnedProject.focus();
  await returnedProject.press('Delete');
  await expect(dialog).toContainText('храниться 30 дней');
  await expect(dialog).toContainText('можно восстановить из Корзины');
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
  await dialog.getByRole('button', { name: 'В Корзину' }).click();

  await expect(page.getByText('Проектов пока нет.')).toBeVisible();
  await expect(returnedProject).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('перемещён в Корзину на 30 дней');
  expect(calls.delete).toBe(1);

  await page.getByRole('button', { name: 'Корзина' }).click();
  await expect(page.getByRole('heading', { name: 'Корзина' })).toBeVisible();
  const trashed = page.getByTestId('trash-project-project-1');
  await trashed.click();
  await expect(page.getByTestId('trash-inspection')).toContainText('Медиа');
  await expect(page.getByTestId('trash-inspection')).toContainText(
    'Восстановление будет частичным',
  );
  await page.getByRole('button', { name: 'Восстановить' }).click();
  await expect(page.getByRole('status')).toContainText('восстановлен частично');
  await expect(page.getByText('Корзина пуста.')).toBeVisible();
  expect(calls.restore).toBe(1);

  await page.getByRole('button', { name: 'К проектам' }).click();
  await expect(page.getByTestId('workspace-project-project-1')).toContainText('Утреннее кафе');
});

test('permanent deletion stays disabled until the exact title is typed', async ({ page }) => {
  const calls = await mockWorkspace(page);
  await page.goto('/workspace');
  await page.getByRole('button', { name: 'Создать первый проект' }).click();
  await page.getByLabel('Название проекта').fill('Без возврата');
  await page.getByRole('button', { name: 'Создать', exact: true }).click();
  const project = page.getByTestId('workspace-project-project-1');
  await project.focus();
  await project.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'В Корзину' }).click();
  await page.getByRole('button', { name: 'Корзина' }).click();
  await page.getByTestId('trash-project-project-1').click();
  await page.getByRole('button', { name: 'Удалить навсегда' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Сценарии, борды и документы Студии не удалятся');
  await expect(dialog).toContainText('станут самостоятельными документами');
  const confirmation = dialog.getByLabel(/Введите «Без возврата»/);
  const permanent = dialog.getByRole('button', { name: 'Удалить навсегда' });
  await expect(permanent).toBeDisabled();
  await confirmation.fill('без возврата');
  await expect(permanent).toBeDisabled();
  await confirmation.fill('Без возврата');
  await expect(permanent).toBeEnabled();
  await permanent.click();

  await expect(page.getByText('Корзина пуста.')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('удалён навсегда');
  expect(calls.permanent).toBe(1);
});
