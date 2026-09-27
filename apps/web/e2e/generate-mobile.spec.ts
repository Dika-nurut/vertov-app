import { test, expect, type Page } from '@playwright/test';

async function inViewport(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  const height = await page.evaluate(() => innerHeight);
  return Boolean(box && box.y >= 0 && box.y + box.height <= height + 1);
}

test('phone: «Управление» / «Результат» switch keeps the composer and the result each on a full screen', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/generate', { waitUntil: 'domcontentloaded' });

  const dock = page.getByTestId('action-dock');
  const stage = page.getByTestId('result-area');
  await expect(page.getByTestId('pane-controls')).toHaveAttribute('aria-pressed', 'true', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('prompt')).toBeVisible();
  await expect(stage).toBeHidden();

  await page.getByTestId('prompt').fill('длинный мобильный промпт '.repeat(40));
  await page.getByTestId('submit').scrollIntoViewIfNeeded();
  await expect.poll(() => inViewport(page, 'submit')).toBe(true);
  const submitBottom = await page
    .getByTestId('submit')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  const navTop = await page
    .getByTestId('mobile-tab-bar')
    .locator('> div')
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(submitBottom).toBeLessThanOrEqual(navTop + 1);

  await page.getByTestId('pane-preview').click();
  await expect(stage).toBeVisible();
  await expect(dock).toBeHidden();

  // The model picker lives on the stage: it takes over «Результат» and hands
  // the user back to «Управление» after a pick.
  await page.getByTestId('pane-controls').click();
  await page.getByTestId('model-trigger').click();
  await expect(page.getByTestId('picker-panel')).toBeVisible();
  await expect(dock).toBeHidden();
  await page.getByTestId('model-card-rate').first().click();
  await expect(page.getByTestId('pane-controls')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('prompt')).toBeVisible();
});

test('tablet: the input bar is pinned with its Create button on screen', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto('/generate', { waitUntil: 'domcontentloaded' });

  await expect(page.getByTestId('prompt')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('prompt').fill('длинный планшетный промпт '.repeat(40));
  await expect(page.getByTestId('action-dock')).toHaveCSS('position', 'fixed');
  await expect.poll(() => inViewport(page, 'submit')).toBe(true);
});
