import { expect, test } from '@playwright/test';

/**
 * `ProjectContextProvider` only settles once the client has hydrated and the
 * API has answered, which on a cold dev server also waits out the route's first
 * compile. Every wait below is therefore on the POSITIVE outcome — the valid
 * banner, the invalid alert, or the cleared session key.
 *
 * Waiting for «Проверяем проект…» to disappear is NOT a readiness signal: it is
 * equally absent before hydration mounts it, so such a wait returns instantly
 * and hands the next assertion a race it usually loses.
 */
const CONTEXT_SETTLE_TIMEOUT = 60_000;

test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: 'project-context-session',
      url: 'http://127.0.0.1:3000',
    },
  ]);
  await page.route('**/v1/projects/project-1', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'project-1', title: 'Ночное кафе' }),
    });
  });
  await page.route('**/v1/projects/missing', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'not_found' }),
    });
  });
});

test('validates project identity and clears remembered context on an intentional standalone route', async ({
  page,
}) => {
  await page.goto('/generate?projectId=project-1');
  // The validated banner is the explicit «this project is real» outcome.
  const context = page.getByTestId('project-context-valid');
  await expect(context).toContainText('Ночное кафе', { timeout: CONTEXT_SETTLE_TIMEOUT });
  await expect(context.getByTestId('desk-return')).toHaveAttribute('href', '/workspace/project-1');
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sreda:active-desk')))
    .toBe('project-1');

  await page.goto('/generate');
  // Standalone renders no banner at all, so the observable transition is the
  // remembered id being dropped — it can only go from «project-1» to null once
  // the synchronizer has run and chosen standalone.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sreda:active-desk')), {
      timeout: CONTEXT_SETTLE_TIMEOUT,
    })
    .toBeNull();
  await expect(page.getByTestId('project-context-valid')).toHaveCount(0);
});

test('fails an unknown explicit context honestly instead of falling back to standalone', async ({
  page,
}) => {
  await page.goto('/generate?projectId=missing');
  // The honest alert is the explicit «this project is not usable» outcome.
  // toContainText, not toHaveText: the alert also holds the escape arrow, whose
  // «←» is part of the element's text. Asserting the exact string here would
  // break every time the way out changes, which is the opposite of the point.
  await expect(page.getByTestId('project-context-invalid')).toContainText(
    'Проект недоступен — работаем без него',
    { timeout: CONTEXT_SETTLE_TIMEOUT },
  );
  await expect(page.getByTestId('desk-return')).toHaveAttribute('href', '/workspace');
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('sreda:active-desk')))
    .toBeNull();
});
