import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';

const pixel =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="32" height="32"%3E%3Crect width="32" height="32" fill="%238d76f6"/%3E%3C/svg%3E';

function searchPayload(query: string, items: Array<Record<string, unknown>>) {
  return {
    query,
    groups: items.length > 0 ? [{ type: 'media', items }] : [],
    page: 1,
    limit: 20,
    total: items.length,
    totalPages: items.length > 0 ? 1 : 0,
    hasPrevious: false,
    hasNext: false,
  };
}

const standaloneResult = {
  type: 'media',
  id: 'asset-standalone',
  title: 'Needle standalone',
  href: '/media/asset-standalone',
  mediaKind: 'image',
  thumbnailUrl: pixel,
  projects: [],
  projectCount: 0,
  association: 'standalone',
  updatedAt: '2026-07-24T12:00:00.000Z',
};

const multiResult = {
  type: 'media',
  id: 'asset-multi',
  title: 'Needle shared',
  href: '/media/asset-multi',
  mediaKind: 'image',
  thumbnailUrl: pixel,
  projects: [
    { id: 'project-1', title: 'Первый проект' },
    { id: 'project-2', title: 'Второй проект' },
  ],
  projectCount: 2,
  association: 'multiple',
  updatedAt: '2026-07-24T11:00:00.000Z',
};

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockSearch(page: Page) {
  let searchMode: 'results' | 'none' | 'error' = 'results';
  let delayMs = 0;
  let retries = 0;

  await page.route('**/v1/search/media/**', async (route) => {
    const url = new URL(route.request().url());
    const mediaId = url.pathname.split('/').pop() ?? '';
    const multiple = mediaId === 'asset-multi';
    return fulfillJson(route, {
      media: {
        id: mediaId,
        title: multiple ? 'Needle shared' : 'Needle standalone',
        originalName: `${mediaId}.png`,
        assetUrl: pixel,
        thumbnailUrl: pixel,
        kind: 'image',
        mimeType: 'image/png',
        createdAt: '2026-07-24T12:00:00.000Z',
        projects: multiple
          ? [
              { id: 'project-1', title: 'Первый проект' },
              { id: 'project-2', title: 'Второй проект' },
            ]
          : [],
        projectCount: multiple ? 2 : 0,
        association: multiple ? 'multiple' : 'standalone',
        projectsTruncated: false,
      },
    });
  });

  await page.route('**/v1/search**', async (route) => {
    const url = new URL(route.request().url());
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (searchMode === 'error') {
      retries += 1;
      return fulfillJson(route, { error: 'search_unavailable' }, 503);
    }
    const query = url.searchParams.get('q') ?? '';
    return fulfillJson(
      route,
      searchPayload(query, searchMode === 'none' ? [] : [standaloneResult, multiResult]),
    );
  });

  await page.route('**/v1/projects/project-2/media/asset-multi', async (route) => {
    return fulfillJson(route, {
      asset: {
        id: 'asset-multi',
        title: 'Needle shared',
        originalName: 'asset-multi.png',
        assetUrl: pixel,
        thumbnailUrl: pixel,
        kind: 'image',
        mimeType: 'image/png',
        sourceLine: 'материал проекта',
      },
    });
  });

  return {
    setMode(mode: 'results' | 'none' | 'error') {
      searchMode = mode;
    },
    setDelay(ms: number) {
      delayMs = ms;
    },
    retryCount() {
      return retries;
    },
  };
}

test('desktop search preserves query and exact neutral media context through browser back', async ({
  signedInPage,
}) => {
  const page = signedInPage;
  const mock = await mockSearch(page);
  mock.setDelay(1_500);

  await page.goto('/search');
  await expect(page.getByText('Ищите по всей Среде')).toBeVisible();

  const input = page.getByRole('combobox', { name: 'Поиск по рабочей среде' });
  await input.fill('needle');
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(2);
  await expect(page).toHaveURL(/\/search\?q=needle$/);

  await input.press('ArrowDown');
  await expect(page.getByRole('option', { name: /Needle shared/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await input.press('Enter');
  // Enter activates the selected option immediately; the App Router only swaps
  // the URL once the destination's RSC payload has arrived, so the budget here
  // covers the server round trip (and, on a cold dev server, the first compile
  // of /media/[assetId]) rather than any client-side delay.
  await expect(page).toHaveURL(/\/media\/asset-multi$/, { timeout: 60_000 });
  await expect(page.getByTestId('media-detail')).toContainText('Needle shared');
  await expect(page.getByText('Выберите контекст проекта')).toBeVisible();
  await expect(page.getByTestId('media-project-project-1')).toBeVisible();
  const secondProject = page.getByTestId('media-project-project-2');
  await secondProject.focus();
  await expect(secondProject).toBeFocused();
  await secondProject.press('Enter');
  await expect(page).toHaveURL(/\/workspace\/project-2\/media\/asset-multi$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/media\/asset-multi$/);
  await expect(page.getByText('Выберите контекст проекта')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=needle$/);
  await expect(input).toHaveValue('needle');
  await expect(page.getByRole('option')).toHaveCount(2);

  await page.getByRole('option', { name: /Needle standalone/ }).click();
  await expect(page).toHaveURL(/\/media\/asset-standalone$/);
  await expect(page).not.toHaveURL(/\/gallery/);
  await expect(page.getByTestId('media-detail')).toContainText(
    'Самостоятельный материал без проекта',
  );
});

test('the compact launcher hands off to the full result list without breaking exact-object routing', async ({
  signedInPage,
}) => {
  const page = signedInPage;
  await mockSearch(page);
  // /workspace, not /gallery: search is a Среда affordance and no longer lives
  // in the site-wide header (owner, 2026-07-28), and the ⌘K/Ctrl+K listener
  // belongs to the launcher component — so the shortcut exists exactly where
  // the launcher does.
  await page.goto('/workspace');

  // The layout-independent shortcut: a Russian layout reports a Cyrillic key
  // for the same physical KeyK.
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'к',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const dialog = page.getByTestId('search-dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('combobox', { name: 'Поиск по рабочей среде' }).fill('needle');
  await expect(page.getByRole('option')).toHaveCount(2);
  // The palette caps at 10 results and offers the full list instead of paging.
  await expect(page.getByRole('navigation', { name: 'Страницы поиска' })).toHaveCount(0);
  await page.getByTestId('search-all-results').click();
  await expect(page).toHaveURL(/\/search\?q=needle$/, { timeout: 30_000 });
  await expect(page.getByRole('option')).toHaveCount(2);

  // Exact-object routing and Back still behave on the full page.
  await page.getByRole('option', { name: /Needle standalone/ }).click();
  await expect(page).toHaveURL(/\/media\/asset-standalone$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=needle$/);
});

test('desktop search exposes no-result and recoverable error states', async ({ signedInPage }) => {
  const page = signedInPage;
  const mock = await mockSearch(page);
  await page.goto('/search');
  const input = page.getByRole('combobox', { name: 'Поиск по рабочей среде' });

  mock.setMode('none');
  await input.fill('absent');
  await expect(page.getByText('Ничего не найдено')).toBeVisible();

  mock.setMode('error');
  await input.fill('broken');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Поиск временно недоступен' }),
  ).toBeVisible();
  expect(mock.retryCount()).toBe(1);

  mock.setMode('results');
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByRole('option')).toHaveCount(2);
});
