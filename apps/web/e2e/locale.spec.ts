import { test as base, expect } from '@playwright/test';

// locale.spec doesn't need auth — legal pages are public.
const test = base;

test.describe('Locale toggle on legal pages', () => {
  test('FAQ page shows RU copy by default, switches to EN on toggle click', async ({ page }) => {
    // Visit /faq — should default to RU.
    await page.goto('/faq');
    await page.waitForLoadState('networkidle');

    // RU copy: check for Russian-only text present in ru/faq.md.
    await expect(page.getByRole('heading', { name: 'Часто задаваемые вопросы' })).toBeVisible({
      timeout: 10_000,
    });

    // Click the EN toggle.
    await page.getByTestId('lang-en').click();

    // URL should have ?lang=en.
    await expect(page).toHaveURL(/lang=en/, { timeout: 10_000 });

    // EN copy: the heading changes.
    await expect(page.getByRole('heading', { name: 'Frequently Asked Questions' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('clicking RU toggle on EN page reverts to RU copy', async ({ page }) => {
    await page.goto('/faq?lang=en');
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('heading', { name: 'Frequently Asked Questions' })).toBeVisible({
      timeout: 10_000,
    });

    await page.getByTestId('lang-ru').click();

    await expect(page).toHaveURL(/lang=ru/, { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Часто задаваемые вопросы' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('privacy page in RU references 152-ФЗ', async ({ page }) => {
    await page.goto('/legal/privacy');
    await page.waitForLoadState('networkidle');

    // Must mention 152-ФЗ somewhere on the page.
    await expect(page.locator('text=152-ФЗ').first()).toBeVisible({ timeout: 10_000 });
  });
});
