import { test, expect } from './fixtures';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';

test('authenticated user can generate an image end-to-end', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Grant credits via dev endpoint (uses the same session cookies as the page).
  const grantRes = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    data: { amount: 100 },
    headers: { cookie: cookieHeader },
  });
  expect(grantRes.ok(), `grant should succeed (got ${grantRes.status()})`).toBeTruthy();

  await page.goto('/generate');
  await expect(page.getByTestId('balance-widget')).toBeVisible();
  await expect(page.getByTestId('balance-value')).toHaveText(/\d+/);

  await page.getByTestId('prompt').fill('Кот в космосе, неоновые цвета');
  await page.getByTestId('submit').click();

  // Result image appears once the worker finishes the stub adapter run.
  const img = page.getByTestId('result-image');
  await expect(img).toBeVisible({ timeout: 60_000 });
  const src = await img.getAttribute('src');
  expect(src, 'result image must have a non-empty src').toBeTruthy();
  expect(src!.length).toBeGreaterThan(8);
  await expect(page.getByTestId('retention-reminder')).toHaveText(FREE_MEDIA_RETENTION_COPY);
});

test('paid media storage hides the free retention reminder', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(120_000);
  const godmode = await context.request.post(`${apiUrl}/v1/dev/godmode`, {
    headers: { cookie: cookieHeader },
  });
  expect(godmode.ok(), `godmode should succeed (got ${godmode.status()})`).toBeTruthy();

  const page = signedInPage;
  await page.goto('/generate');
  await page.getByTestId('prompt').fill('Платный кадр без free-retention напоминания');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('result-image')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('retention-reminder')).toHaveCount(0);
});
