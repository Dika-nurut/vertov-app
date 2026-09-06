import { test, expect, unlockPacksBySubscribing } from './fixtures';

test('billing: buy a pack → /settings/billing shows row → invoice downloads as PDF', async ({
  signedInPage,
  cookieHeader,
}) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Buy a pack via the stub flow (mirrors pricing.spec.ts). Packs are докупка для
  // подписчиков, so subscribe first to unlock the packs modal.
  await unlockPacksBySubscribing(page);
  await page.locator('[data-pack-id="pack-s"]').getByTestId('buy-button').click();
  await page.waitForURL(/\/billing\/return\?/, { timeout: 30_000 });
  await expect(page.getByTestId('return-message')).toContainText(/Токены зачислены/, {
    timeout: 30_000,
  });

  // Settings → Биллинг.
  await page.goto('/settings');
  await expect(page.getByTestId('settings-billing-link')).toBeVisible();
  await page.getByTestId('settings-billing-link').click();
  await page.waitForURL(/\/settings\/billing/);

  await expect(page.getByTestId('subscription-card')).toBeVisible();
  await expect(page.getByTestId('history-card')).toBeVisible();
  await expect(page.getByTestId('breakdown-card')).toBeVisible();

  // At least one paid history row with an invoice link.
  const rows = page.getByTestId('history-row');
  await expect(rows.first()).toBeVisible();
  const link = rows.first().getByTestId('invoice-link');
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\/v1\/billing\/invoice\/.+\.pdf$/);

  // Fetch the PDF directly to assert content-type + non-empty body.
  const pdfRes = await page.request.get(href!, { headers: { cookie: cookieHeader } });
  expect(pdfRes.status()).toBe(200);
  expect(pdfRes.headers()['content-type']).toBe('application/pdf');
  const body = await pdfRes.body();
  expect(body.byteLength).toBeGreaterThan(500);
  expect(body.subarray(0, 4).toString()).toBe('%PDF');
});
