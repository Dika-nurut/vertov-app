import { test, expect } from './fixtures';

/**
 * B-7 in-context transformation: from a generated result, "restyle" reuses it
 * as a reference + a steering instruction (no rebuilding from scratch), and the
 * resulting take is lineage-linked back to its source in the filmstrip.
 */
test('generate: restyle a result → lineage-linked transform', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;

  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    data: { amount: 500 },
    headers: { cookie: cookieHeader },
  });
  expect(grant.ok()).toBeTruthy();

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('Кот в космосе');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('result-image')).toBeVisible({ timeout: 90_000 });

  // Restyle the result — preps the source as a ref + a steering instruction
  // (no manual rebuild), then launch it as a second, lineage-linked result.
  await page.getByTestId('action-restyle').click();
  await page.getByTestId('submit').click();
  await expect
    .poll(() => page.getByTestId('session-item').count(), { timeout: 90_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('lineage').first()).toBeVisible({ timeout: 30_000 });
});

test('generate: model capabilities are surfaced as labels (B-11)', async ({ signedInPage }) => {
  test.setTimeout(60_000);
  const page = signedInPage;
  await page.goto('/generate');
  // The selected model's normalized capabilities show as user-facing chips.
  await expect(page.getByTestId('capability-labels')).toBeVisible({ timeout: 30_000 });
});
