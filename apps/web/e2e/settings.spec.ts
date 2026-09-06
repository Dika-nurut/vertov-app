import { test, expect } from './fixtures';

test('user can update display name + locale and persist across reload', async ({
  signedInPage,
}) => {
  test.setTimeout(60_000);
  const page = signedInPage;

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible();

  const newName = `Имя ${Date.now()}`;
  await page.getByTestId('display-name').fill(newName);
  // Locale is a RU/EN toggle (two buttons) — pick English; it persists on tap.
  const en = page.getByTestId('locale').getByRole('button', { name: 'EN', exact: true });
  await en.click();
  await expect(en).toHaveAttribute('aria-pressed', 'true');
  // The «Сохранить» button only appears once the name is dirty.
  await page.getByTestId('save-profile').click();
  await expect(page.getByTestId('profile-message')).toHaveText('Сохранено.');

  // Reload and confirm the values stuck.
  await page.reload();
  await expect(page.getByTestId('display-name')).toHaveValue(newName);
  await expect(
    page.getByTestId('locale').getByRole('button', { name: 'EN', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

// Destructive delete-account flow is covered by the vitest unit test
// (apps/api/__tests__/me-profile.test.ts); doing it here would tear
// down the shared session/cookies the fixture depends on.
