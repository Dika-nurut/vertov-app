import { type Page, type Route } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * First-run help is deliberately local and zero-spend: the fixture supplies
 * only workspace data and keeps localStorage intact across reloads, exercising
 * fresh and returning desktop visits without real providers.
 */

const NOW = '2026-07-26T09:00:00.000Z';

async function json(route: Route, body: unknown) {
  await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
}

async function installWorkspaceFixture(page: Page) {
  let hasProject = false;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/projects') {
      return json(route, {
        items: hasProject
          ? [
              {
                id: 'first-project',
                title: 'Первый фильм',
                productionFormat: { aspect: '16:9' },
                rooms: { scenario: 0, boards: 0, studio: 0, assets: 0 },
              },
            ]
          : [],
      });
    }
    if (path === '/v1/projects/first-project') {
      return json(route, {
        id: 'first-project',
        title: 'Первый фильм',
        productionFormat: { aspect: '16:9' },
        primaryScriptId: null,
        rooms: { scenario: 0, boards: 0, studio: 0, assets: 0 },
      });
    }
    if (path === '/v1/projects/first-project/folders') return json(route, { folders: [] });
    if (path === '/v1/projects/first-project/recents') return json(route, { items: [] });
    if (path === '/v1/projects/first-project/desk-items') {
      return json(route, {
        items: [],
        apps: { scenario: [], boards: [], studio: [] },
        truncated: { media: false, scenario: false, boards: false, studio: false },
        retention: { mode: 'permanent', reminder: null },
      });
    }
    if (path === '/v1/projects/first-project/desk-layout') {
      return json(route, { revision: 0, positions: [] });
    }
    if (path === '/v1/credits/balance') return json(route, { available: 0 });
    if (path === '/v1/assets/usage') return json(route, { usages: {} });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'fixture_not_found', path, now: NOW }),
    });
  });

  return {
    addFirstProject: () => {
      hasProject = true;
    },
  };
}

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test(`first-run guidance is concise, keyboard-safe, and dismissible at ${viewport.width}x${viewport.height}`, async ({
    signedInPage,
  }) => {
    const page = signedInPage;
    await page.setViewportSize(viewport);
    const fixture = await installWorkspaceFixture(page);

    await page.goto('/workspace');
    const emptyGuide = page.getByTestId('workspace-first-run');
    await expect(emptyGuide).toContainText('Среда — место для работы над фильмом');
    expect(
      await emptyGuide.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(12);

    fixture.addFirstProject();
    await page.reload();
    const projectGuide = page.getByTestId('workspace-project-guide');
    await expect(projectGuide).toContainText('Двойной клик или Enter открывает его стол');
    expect(
      await projectGuide.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(11);
    await page.getByTestId('workspace-project-first-project').focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/workspace\/first-project/);

    const deskGuide = page.getByTestId('desk-first-run-guide');
    await expect(deskGuide).toContainText('Недавние');
    await expect(deskGuide).toContainText('Кадры');
    await expect(deskGuide).toContainText('док');
    expect(
      await deskGuide.evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(11);
    await expect(page.getByTestId('dock-generate')).toHaveAttribute('aria-label', 'Генерация');

    const dismissDeskGuide = deskGuide.getByRole('button', { name: 'Понятно' });
    await dismissDeskGuide.focus();
    await expect(dismissDeskGuide).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(deskGuide).toHaveCount(0);
    await page.reload();
    await expect(deskGuide).toHaveCount(0);

    await page.goto('/workspace');
    await projectGuide.getByRole('button', { name: 'Понятно' }).click();
    await expect(projectGuide).toHaveCount(0);
    await page.reload();
    await expect(projectGuide).toHaveCount(0);
  });
}
