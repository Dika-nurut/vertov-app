import { test, expect, unlockPacksBySubscribing } from './fixtures';

test('user can buy a credit pack via the stub ЮKassa flow', async ({ signedInPage }) => {
  test.setTimeout(120_000);
  const page = signedInPage;

  // Packs are докупка для подписчиков — subscribe first to unlock the packs modal.
  await unlockPacksBySubscribing(page);
  const rows = page.getByTestId('pack-row');
  await expect(rows).toHaveCount(5);

  // The stub-mode checkout returns its own /billing/return URL — but the
  // brief asks us to stub ЮKassa at the route layer so the test doesn't
  // hit the real sandbox. In stub mode, the API itself stubs ЮKassa: the
  // confirmationUrl bounces back to /billing/return?forceSuccess=1, and
  // the return endpoint applies the grant inline. We use that mode here
  // (YOOKASSA_SHOP_ID intentionally unset in dev .env).
  const startBalance = Number(await page.getByTestId('balance-value').textContent());
  const packS = page.locator('[data-pack-id="pack-s"]');
  await packS.getByTestId('buy-button').click();

  await page.waitForURL(/\/billing\/return\?/, { timeout: 30_000 });
  await expect(page.getByTestId('return-message')).toContainText(/Токены зачислены: \+500/, {
    timeout: 30_000,
  });

  // Balance must reflect the grant.
  await page.goto('/generate');
  const newBalance = Number(await page.getByTestId('balance-value').textContent());
  expect(newBalance - startBalance).toBe(500);
});
