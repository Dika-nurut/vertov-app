/**
 * Beta invite Playwright tests — W4.Fri.
 *
 * Verifies the full invite flow:
 * 1. Visit /i/SEED-BETA-001 → cookie is set → redirect to /login
 * 2. Sign up as a fresh user
 * 3. AppShell mounts → BetaRedeemClient runs → code redeemed
 * 4. Footer shows "Бета · tg-2026-05"
 */
import { test, expect } from './fixtures';

test.describe('Beta invite flow', () => {
  test('visit /i/<code> → sign up → footer shows cohort', async ({ page, context, request }) => {
    const API_URL =
      process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

    // Reset SEED-BETA-001 so it's available for this test run (dev-only endpoint).
    await request.post(`${API_URL}/v1/dev/reset-beta-invite`, {
      data: { code: 'SEED-BETA-001' },
    });

    // Use a unique email to avoid cross-test user collisions.
    const email = `beta-e2e+${Date.now()}@seed.local`;

    // Step 1: Visit the invite URL. It sets the cookie and redirects to /login.
    await page.goto('/i/SEED-BETA-001');

    // We should land on /login (or wherever the redirect took us)
    await page.waitForURL(/login/, { timeout: 10_000 });

    // Verify cookie was set
    const cookies = await context.cookies();
    const betaCookie = cookies.find((c) => c.name === 'seed_beta_code');
    expect(betaCookie?.value).toBe('SEED-BETA-001');

    // Step 2: Sign in (magic link flow — email is behind the «или войти по email» toggle now)
    await page.getByRole('button', { name: 'или войти по email' }).click();
    await page.getByPlaceholder('pochta@example.com').fill(email);
    await page.getByRole('button', { name: /Получить ссылку/ }).click();
    await expect(page.getByText('Проверьте почту')).toBeVisible({ timeout: 10_000 });

    let magicUrl: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await request.get(`${API_URL}/v1/dev/last-magic-link`);
      const body = (await res.json()) as { url?: string; email?: string };
      if (body?.url && body.email === email) {
        magicUrl = body.url;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(magicUrl, 'magic link captured').not.toBeNull();
    await page.goto(magicUrl!);
    await page.waitForURL(/\/(?!login)/, { timeout: 15_000 });

    // Step 3: AppShell is now mounted. The BetaRedeemClient useEffect fires
    // and calls POST /v1/beta/redeem then GET /v1/beta/me.
    // Wait for the beta cohort badge to appear in the footer.
    const badge = page.getByTestId('beta-cohort-badge');
    await expect(badge).toBeVisible({ timeout: 15_000 });
    await expect(badge).toContainText('tg-2026-05');

    // Reset: un-redeem SEED-BETA-001 so other tests can use it.
    // We can't call the API here easily, but the beforeAll seed re-runs
    // idempotently (it does ON CONFLICT DO NOTHING, so it won't reset).
    // The test cleanup in API tests handles this.
  });
});
