import { test, expect } from '@playwright/test';

test('Generate action stays reachable above the mobile navigation on narrow viewports', async ({
  page,
}) => {
  test.setTimeout(60_000);

  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/generate', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('prompt')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('prompt').fill('длинный мобильный промпт '.repeat(40));

    const actionDock = page.getByTestId('action-dock');
    const cta = page.locator('[data-testid="submit"], [data-testid="upsell-cta"]').first();
    await expect(actionDock).toHaveCSS('position', 'fixed');
    await expect
      .poll(async () => {
        const box = await cta.boundingBox();
        return Boolean(
          box && box.y >= 0 && box.y + box.height <= (await page.evaluate(() => innerHeight)),
        );
      })
      .toBe(true);

    const geometry = await page.evaluate(() => {
      const dock = document.querySelector('[data-testid="action-dock"]')?.getBoundingClientRect();
      const cta = document
        .querySelector('[data-testid="submit"], [data-testid="upsell-cta"]')
        ?.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="mobile-tab-bar"]')?.getBoundingClientRect();
      return {
        dockBottom: dock?.bottom ?? null,
        ctaBottom: cta?.bottom ?? null,
        navTop: nav?.top ?? null,
        viewport: innerHeight,
      };
    });

    expect(geometry.ctaBottom).not.toBeNull();
    expect(geometry.ctaBottom!).toBeLessThanOrEqual(geometry.viewport + 1);
    if (width < 768) {
      expect(geometry.navTop).not.toBeNull();
      expect(geometry.dockBottom!).toBeLessThanOrEqual(geometry.navTop! + 1);
    }
  }
});
