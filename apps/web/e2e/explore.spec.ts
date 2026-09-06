import { test, expect } from './fixtures';

/**
 * B-1 multi-variant creative loop: one action launches several variants (not
 * four manual submits), they land in a single compare layout where the user can
 * keep/favourite one, and the selection hands off to Studio as a timeline clip.
 */
test('explore: launch variants, compare, then send a selected one to Studio', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;

  // Fund the whole batch up front (Explore pre-checks total affordability).
  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    data: { amount: 500 },
    headers: { cookie: cookieHeader },
  });
  expect(grant.ok(), `grant should succeed (got ${grant.status()})`).toBeTruthy();

  await page.goto('/generate');
  await expect(page.getByTestId('balance-widget')).toBeVisible();
  await page.getByTestId('prompt').fill('Кот в космосе, неоновые цвета');

  // One click → multiple variants, no four manual submits.
  await page.getByTestId('explore').click();

  // Compare layout: the session filmstrip fills as variants finish.
  const items = page.getByTestId('session-item');
  await expect.poll(() => items.count(), { timeout: 150_000 }).toBeGreaterThanOrEqual(2);

  // Keep (favourite) the first variant, then send the selection to Studio.
  const first = items.first();
  await first.hover();
  await first.getByTestId('fav-toggle').click();
  await page.getByTestId('send-to-studio').click();

  // Lands in Studio with the selected variant ingested onto the timeline.
  await page.waitForURL(/\/studio/, { timeout: 30_000 });
  await expect(page.getByTestId('timeline-clip').first()).toBeVisible({ timeout: 30_000 });
});
