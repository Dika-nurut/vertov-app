import { test, expect } from './fixtures';

/**
 * Unhappy paths — the user-visible failure surfaces of the live demo
 * (#15). Kept serial so the trio shares a Postgres connection and the
 * stub-mode worker isn't fighting itself.
 */
test.describe.configure({ mode: 'serial' });

test('zero-credit /generate submit surfaces "Недостаточно токенов"', async ({
  signedInPage,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  // New users get a starter bonus — drain it so this exercises the empty-wallet path.
  await context.request.post(`${apiUrl}/v1/dev/burn-credits`, {
    headers: { cookie: cookieHeader },
  });

  await page.goto('/generate');
  await expect(page.getByTestId('balance-widget')).toBeVisible();

  await page.getByTestId('prompt').fill('Без кредитов — ничего не выйдет');
  await page.getByTestId('submit').click();

  await expect(page.getByTestId('error-message')).toContainText('Недостаточно токенов', {
    timeout: 15_000,
  });
});

test('fresh user with no jobs sees the empty-gallery copy', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  await page.goto('/gallery');
  // GalleryClient renders this empty-state copy when initialRows is empty.
  await expect(page.getByText(/Пока ничего\. Начните с/)).toBeVisible({ timeout: 10_000 });
});

test('non-existent model id surfaces "Модель недоступна"', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  await page.goto('/generate');
  await expect(page.getByTestId('balance-widget')).toBeVisible();

  // The model picker only renders is_active models from /v1/models. To
  // exercise the 400 path we intercept the /v1/jobs POST via Playwright's
  // network routing API and return a 400 with model_unavailable error.
  // This replaces the fragile window.fetch monkeypatch (#16 audit fix):
  // page.route handles the interception lifecycle cleanly and does not
  // require restoring the original fetch.
  await page.route('**/v1/jobs', async (route) => {
    if (route.request().method() === 'POST') {
      // Return the same error shape the real API would return for an unknown
      // model id. GenerateClient maps error='model_not_available' → "Модель недоступна".
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'model_not_available' }),
      });
    } else {
      await route.continue();
    }
  });

  await page.getByTestId('prompt').fill('Невидимая модель');
  await page.getByTestId('submit').click();
  // The failed phase renders <ErrorState> which has data-testid="error-state".
  // The "Модель недоступна" message is rendered inside that component.
  await expect(page.getByTestId('error-state')).toContainText('Модель недоступна', {
    timeout: 15_000,
  });
});
