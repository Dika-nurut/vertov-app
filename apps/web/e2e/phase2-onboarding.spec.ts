import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

async function expectTourAdjacent(page: Page, targetName: string) {
  const tour = page.getByTestId('onboarding-tour');
  const target = page.locator('[data-tour-target="' + targetName + '"]');
  const tourBox = await tour.boundingBox();
  const targetBox = await target.boundingBox();
  expect(tourBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  const tourRect = {
    top: tourBox!.y,
    right: tourBox!.x + tourBox!.width,
    bottom: tourBox!.y + tourBox!.height,
    left: tourBox!.x,
  };
  const targetRect = {
    top: targetBox!.y,
    right: targetBox!.x + targetBox!.width,
    bottom: targetBox!.y + targetBox!.height,
    left: targetBox!.x,
  };

  const verticalGap = Math.min(
    Math.abs(tourRect.bottom - targetRect.top),
    Math.abs(targetRect.bottom - tourRect.top),
  );
  const horizontalGap = Math.min(
    Math.abs(tourRect.right - targetRect.left),
    Math.abs(targetRect.right - tourRect.left),
  );
  const verticalOverlap = tourRect.left < targetRect.right && tourRect.right > targetRect.left;
  const horizontalOverlap = tourRect.top < targetRect.bottom && tourRect.bottom > targetRect.top;
  expect((verticalOverlap && verticalGap <= 16) || (horizontalOverlap && horizontalGap <= 16)).toBe(
    true,
  );
}

test.describe('Phase 2 first-use experience', () => {
  test('desktop tour anchors, spotlights, and dismisses through the backdrop', async ({
    signedInPage: page,
    apiUrl,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/generate?onboarding=1');

    const tour = page.getByTestId('onboarding-tour');
    await expect(tour).toBeVisible({ timeout: 30_000 });
    await expect(tour).toHaveAttribute('data-tour-step', 'model');
    await expect(tour).toContainText('Выберите модель');
    await expectTourAdjacent(page, 'model');

    const spotlightCheck = await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-tour-target="model"]');
      const spotlight = document.querySelector<HTMLElement>('[data-testid="onboarding-spotlight"]');
      if (!target || !spotlight) return false;
      const targetBox = target.getBoundingClientRect();
      const spotlightBox = spotlight.getBoundingClientRect();
      const hit = document.elementFromPoint(
        targetBox.left + targetBox.width / 2,
        targetBox.top + targetBox.height / 2,
      );
      return (
        spotlightBox.left <= targetBox.left &&
        spotlightBox.right >= targetBox.right &&
        spotlightBox.top <= targetBox.top &&
        spotlightBox.bottom >= targetBox.bottom &&
        hit?.closest('[data-tour-target="model"]') === target
      );
    });
    expect(spotlightCheck).toBe(true);

    await tour.getByTestId('onboarding-tour-next').click();
    await expect(tour).toHaveAttribute('data-tour-step', 'prompt');
    await expectTourAdjacent(page, 'prompt');

    await page.getByTestId('prompt-block').getByRole('textbox').fill('неоновый детектив');
    await expect(tour).toHaveAttribute('data-tour-step', 'submit');
    await expect(tour).toContainText('Нажмите «Создать»');
    await expectTourAdjacent(page, 'submit');

    await page.mouse.click(4, 4);
    await expect(tour).toBeHidden({ timeout: 10_000 });
    await expect
      .poll(
        async () => {
          const profile = await page.evaluate(async (url) => {
            const response = await fetch(url + '/v1/me/profile', { credentials: 'include' });
            return response.json();
          }, apiUrl);
          return profile.onboardedAt;
        },
        { timeout: 10_000 },
      )
      .not.toBeNull();

    await page.goto('/generate?onboarding=1');
    await expect(page.getByTestId('onboarding-tour')).toBeHidden();
  });

  test('Escape dismisses the tour for a fresh account', async ({ signedInPage: page }) => {
    await page.goto('/generate?onboarding=1');
    const tour = page.getByTestId('onboarding-tour');
    await expect(tour).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press('Escape');
    await expect(tour).toBeHidden({ timeout: 10_000 });
  });

  test('mobile tour keeps the first-success path above the safe area', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/generate?onboarding=1');

    const tour = page.getByTestId('onboarding-tour');
    await expect(tour).toBeVisible({ timeout: 30_000 });
    await expect(tour).toHaveAttribute('data-mobile', 'true');
    await expect(tour).toHaveText(/1\/3/);
    await expectTourAdjacent(page, 'model');

    await tour.getByTestId('onboarding-tour-next').click();
    await expect(tour).toHaveAttribute('data-tour-step', 'prompt');
    await page.getByTestId('prompt-block').getByRole('textbox').fill('мокрый асфальт ночью');
    await expect(tour).toHaveAttribute('data-tour-step', 'submit');
    await expect(tour).toHaveText(/3\/3/);
    await expectTourAdjacent(page, 'submit');

    const safeAreaCheck = await tour.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const styles = getComputedStyle(node);
      return (
        rect.top >= 0 && rect.bottom <= window.innerHeight && parseFloat(styles.paddingBottom) >= 16
      );
    });
    expect(safeAreaCheck).toBe(true);
  });

  test('mobile routes outside Generate show the compact desktop notice', async ({
    signedInPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/boards');
    await expect(page.getByTestId('mobile-desktop-notice')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('mobile-desktop-notice')).toContainText(
      'Полная версия — на десктопе',
    );
    await expect(page.getByTestId('mobile-desktop-link')).toHaveAttribute('href', '/generate');

    await page.goto('/generate');
    await expect(page.getByTestId('mobile-desktop-notice')).toHaveCount(0);

    await page.goto('/faq');
    await expect(page.getByTestId('mobile-desktop-notice')).toBeVisible({ timeout: 30_000 });
  });

  test('feature hints render once per surface and dismiss once', async ({
    signedInPage: page,
    apiUrl,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const board = await page.evaluate(async (url) => {
      const response = await fetch(url + '/v1/boards', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Onboarding hint fixture' }),
      });
      return { ok: response.ok, body: await response.json().catch(() => null) };
    }, apiUrl);
    expect(board.ok).toBe(true);
    await page.goto('/boards');
    await expect(page.getByTestId('board-create')).toBeVisible({ timeout: 30_000 });
    const hint = page.getByTestId('feature-hint-boards');
    await expect(hint).toBeVisible({ timeout: 30_000 });
    await expect(hint).toHaveAttribute('data-placement', 'bottom');
    await hint.getByRole('button').click();
    await expect(hint).toBeHidden();

    await page.reload();
    await expect(page.getByTestId('feature-hint-boards')).toBeHidden();
  });
});
