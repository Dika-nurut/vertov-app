import { test, expect } from './fixtures';

test('Generate keeps an in-context video effect catalog', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  await page.goto('/generate');

  // The parked /presets catalog is replaced by an in-context picker. Effects
  // load from the same catalog endpoint, but remain attached to video creation.
  await page.getByTestId('mode-video').click();
  await page.getByTestId('effect-trigger').click();
  await expect(page.getByTestId('effect-card').first()).toBeVisible({
    timeout: 15_000,
  });
  const count = await page.getByTestId('effect-card').count();
  expect(count).toBeGreaterThanOrEqual(6);

  const firstEffect = page.getByTestId('effect-card').first();
  const firstTitle = (await firstEffect.textContent())?.trim();
  expect(firstTitle).toBeTruthy();
  await firstEffect.click();
  await expect(firstEffect).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await expect(page.getByTestId('effect-trigger')).toContainText(firstTitle!);
});

test('/presets catalog is parked while Generate keeps in-context preset chips', async ({
  signedInPage,
}) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  const parked = await page.goto('/presets');
  expect(parked?.status()).toBe(404);

  await page.goto('/generate');
  await page.getByTestId('mode-video').click();
  await page.getByTestId('effect-trigger').click();
  await expect(page.getByTestId('effect-card').first()).toBeVisible({
    timeout: 15_000,
  });
});

test('parked /presets route is 404 for an anonymous visitor too', async ({ page }) => {
  const parked = await page.goto('/presets');
  expect(parked?.status()).toBe(404);
  expect(page.url()).not.toContain('/login');
});
