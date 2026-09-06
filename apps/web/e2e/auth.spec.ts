import { test, expect } from './fixtures';

test('magic-link sign-in completes and authenticated root shows email', async ({
  signedInPage,
  signedInEmail,
}) => {
  // Sign-in lands on /generate; the home page shows the signed-in email in
  // the header (≥lg) and the editorial hero for authenticated users. The shared
  // fixture now signs in programmatically (the consent-UI path lives in
  // `signInViaUI`, exercised where /login hydration latency isn't on the hot path).
  await signedInPage.goto('/');
  await expect(signedInPage.locator('h1')).toBeVisible({ timeout: 15_000 });
  await expect(signedInPage.getByText(signedInEmail)).toBeVisible({ timeout: 15_000 });
});
