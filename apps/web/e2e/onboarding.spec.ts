import { test, expect } from './fixtures';

test.describe('Onboarding first-use flow', () => {
  test('fresh user can confirm the centered welcome card and persist completion', async ({
    signedInPage: page,
    apiUrl,
  }) => {
    await page.goto('/');
    const card = page.getByTestId('onboarding-card');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId('onboarding-submit').click();
    await expect(card).toBeHidden({ timeout: 10_000 });

    const profile = await page.evaluate(async (url) => {
      const response = await fetch(url + '/v1/me/profile', { credentials: 'include' });
      return response.json();
    }, apiUrl);
    expect(profile.onboardedAt).not.toBeNull();

    await page.reload();
    await expect(page.getByTestId('onboarding-card')).toBeHidden();
  });

  test('Skip hides the welcome card for this session without writing onboardedAt', async ({
    signedInPage: page,
    apiUrl,
  }) => {
    await page.goto('/');
    const card = page.getByTestId('onboarding-card');
    await expect(card).toBeVisible({ timeout: 10_000 });

    await card.getByTestId('onboarding-skip').click();
    await expect(card).toBeHidden({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByTestId('onboarding-card')).toBeHidden();

    const profile = await page.evaluate(async (url) => {
      const response = await fetch(url + '/v1/me/profile', { credentials: 'include' });
      return response.json();
    }, apiUrl);
    expect(profile.onboardedAt).toBeNull();
  });
});
