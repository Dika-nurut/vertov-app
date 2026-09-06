import { test as setup, expect } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * Playwright SETUP project — log the shared «god» account in ONCE and persist
 * its session to `e2e/.auth/studio.json`. The studio floor (`studio-editor.spec`)
 * depends on this project and `use: { storageState }` it, so every studio test
 * starts already authenticated WITHOUT paying a per-test magic-link round-trip
 * (which previously loaded the heavy /login bundle + hydrated, flaking under load).
 *
 * This is the same programmatic god-mode flow as `_godlogin.mjs` / `signInAs`,
 * run from the setup test's own context so the cookie lands in the saved state.
 */
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';
const GOD_EMAIL = process.env.GOD_EMAIL ?? 'god@seed.local';
const authFile = resolve(__dirname, '.auth/studio.json');
// Absolute web-origin callback. On the tunnel stack web+api share one origin so
// a relative path would work, but the isolated prod floor splits them (web :3209,
// api :4310) — Better Auth resolves a relative callbackURL against the API origin
// (→ 404), so anchor it to the web origin (WEB_PUBLIC_URL) explicitly.
const WEB_ORIGIN = process.env.WEB_PUBLIC_URL ?? '';
const CALLBACK = `${WEB_ORIGIN}/dev/enter`;

setup('authenticate god account', async ({ page, context }) => {
  const signIn = await context.request.post(`${API_URL}/api/auth/sign-in/magic-link`, {
    headers: { 'content-type': 'application/json' },
    // /dev/enter tops up god credits on landing (dev-only), matching _godlogin.mjs.
    data: { email: GOD_EMAIL, callbackURL: CALLBACK },
  });
  expect(signIn.ok(), `god sign-in HTTP ${signIn.status()}`).toBe(true);

  let url: string | null = null;
  for (let i = 0; i < 30; i++) {
    const res = await context.request.get(
      `${API_URL}/v1/dev/last-magic-link?email=${encodeURIComponent(GOD_EMAIL)}`,
    );
    const body = await res.json();
    if (body?.url && body.email === GOD_EMAIL) {
      url = body.url as string;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(url, 'god magic link should be captured').not.toBeNull();

  // Verify in the browser so the session cookie lands in this context natively.
  await page.goto(url!);
  // /dev/enter performs the dev-only godmode grant + onboarding write before
  // redirecting. Do not snapshot the cookie while that async handoff is still
  // in flight: the Phase 2 durable-dismiss assertion needs an actually
  // onboarded fixture account.
  await page.waitForURL(/\/generate(?:[/?]|$)/, { timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const profile = await context.request.get(`${API_URL}/v1/me/profile`);
        if (!profile.ok()) return null;
        const body = (await profile.json()) as { onboardedAt?: string | null };
        return body.onboardedAt ?? null;
      },
      { timeout: 30_000 },
    )
    .not.toBeNull();

  await context.storageState({ path: authFile });
});
