import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';

const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';
const WEB_ORIGIN = process.env.WEB_PUBLIC_URL ?? '';
const GENERATE_CALLBACK = `${WEB_ORIGIN}/generate`;
// Production enables /v1/dev/* only behind this header. Keep the value in the
// process environment; never print it or persist it in a trace/evidence file.
const DEV_ACCESS = process.env.DEV_ACCESS?.trim();
const DEV_HEADERS = DEV_ACCESS ? { 'x-dev-access': DEV_ACCESS } : {};

/**
 * Dev auth may build the captured magic link from the API's stale public-base
 * setting. The token and path are still valid, but a browser test pointed at a
 * loopback stack must verify through that same loopback API origin. In a real
 * environment this is a no-op because API_URL already is the intended origin.
 */
function authLinkAtConfiguredApi(raw: string): string {
  try {
    const link = new URL(raw);
    const api = new URL(API_URL);
    link.protocol = api.protocol;
    link.host = api.host;
    return link.toString();
  } catch {
    return raw;
  }
}

/**
 * Drive the magic-link sign-in PROGRAMMATICALLY (the "god-mode for testing"
 * path): POST the link request → read it from the dev capture endpoint → visit
 * the verify URL so the browser context stores the real session cookie natively.
 *
 * This deliberately skips the /login consent-UI clicking. In dev mode each fresh
 * Playwright context re-downloads the un-minified bundles over the tunnel, so
 * waiting for the heavy /login page to HYDRATE before a click routinely blew the
 * per-test timeout (120s) — flaking every suite at setup. The POST has no such
 * cost and exercises the same end-to-end auth (link issuance → verify → session).
 * The consent gate is a client concern; the API endpoint doesn't require it (the
 * same reason the /login god-mode button POSTs directly). The dedicated login-UI
 * flow lives in `signInViaUI` for the one spec that asserts the consent gate.
 *
 * Exposed standalone so specs needing a second, different user can call it.
 */
export async function signInAs(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  const signIn = await request.post(`${API_URL}/api/auth/sign-in/magic-link`, {
    headers: { 'content-type': 'application/json', ...DEV_HEADERS },
    // Keep the callback on the web origin when web and API use separate ports.
    // A relative path resolves against the API and skips the /generate page's
    // /v1/me bootstrap, leaving a new auth user without its users_app mirror.
    data: { email, callbackURL: GENERATE_CALLBACK },
  });
  expect(signIn.ok(), `magic-link request HTTP ${signIn.status()}`).toBe(true);

  let url: string | null = null;
  for (let i = 0; i < 20; i++) {
    // Email-scoped lookup → per-worker isolation (old API ignores the param and
    // the email check below still filters, so this stays back-compatible).
    const res = await request.get(
      `${API_URL}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
      { headers: DEV_HEADERS },
    );
    const body = await res.json();
    if (body?.url && body.email === email) {
      url = authLinkAtConfiguredApi(body.url as string);
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(url, 'magic link should be captured').not.toBeNull();
  // Verify in the browser so the session cookie lands in this context, then wait
  // until we've left /login (the verify redirects to the callback).
  await page.goto(url!);
  await page.waitForURL(/\/(?!login)/, { timeout: 30_000 });
}

/**
 * The full /login consent-UI sign-in (152-ФЗ gate + magic-link). Slower and only
 * used where the UI itself is under test; everything else uses the fast
 * programmatic {@link signInAs}.
 */
export async function signInViaUI(
  page: Page,
  request: APIRequestContext,
  email: string,
): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'или войти по email' }).click();
  await page.getByPlaceholder('pochta@example.com').fill(email);
  await page.getByTestId('consent-offer').click();
  await page.getByTestId('consent-pdn').click();
  await page.getByRole('button', { name: /Получить ссылку/ }).click();
  await expect(page.getByText('Проверьте почту')).toBeVisible({ timeout: 30_000 });

  let url: string | null = null;
  for (let i = 0; i < 20; i++) {
    const res = await request.get(
      `${API_URL}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
      {
        headers: DEV_HEADERS,
      },
    );
    const body = await res.json();
    if (body?.url && body.email === email) {
      url = authLinkAtConfiguredApi(body.url as string);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(url, 'magic link should be captured').not.toBeNull();
  await page.goto(url!);
  await page.waitForURL(/\/(?!login)/, { timeout: 15_000 });
}

/**
 * Resolve the cookie header for the currently-authenticated context.
 * Many specs need to call the API directly (grant credits, create
 * jobs) while the page is in /login → keeping this in one place.
 */
export async function authedCookieHeader(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  // Don't URL-encode here: the server stores the cookie value
  // verbatim (Better Auth verifies a signed token byte-for-byte),
  // and the browser sends it raw too. RFC 6265 token chars are
  // safe; we just skip anything that would corrupt the header.
  return cookies
    .filter((c) => !/[\s;,]/.test(c.value))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * Packs are «докупка для подписчиков» (2026-07-17 pricing CJM): a non-subscriber
 * can't reach the packs modal — the toggle chip is locked. Establish an active
 * Старт subscription via the stub ЮKassa flow so the chip unlocks, open the
 * packs modal, and leave the page on /pricing with it visible.
 */
export async function unlockPacksBySubscribing(page: Page): Promise<void> {
  await page.goto('/pricing');
  await page.locator('[data-tier="start"]').getByTestId('plate-cta').click();
  await page.waitForURL(/\/billing\/return\?/, { timeout: 30_000 });
  await expect(page.getByTestId('return-message')).toContainText(/зачислены/, { timeout: 30_000 });
  await page.goto('/pricing');
  await page.getByTestId('mode-packs').click();
  await expect(page.getByTestId('packs-modal')).toBeVisible();
}

export interface SeedFixtures {
  signedInEmail: string;
  signedInPage: Page;
  cookieHeader: string;
  apiUrl: string;
}

/**
 * Extended `test` that auto-provides an authenticated page + the
 * cookie header for direct API calls. Each test gets its own
 * unique email so they don't share users.
 */
export const test = base.extend<SeedFixtures>({
  signedInEmail: async ({}, use, testInfo) => {
    const slug = testInfo.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
    const email = `e2e+${slug}-${Date.now()}@seed.local`;
    await use(email);
  },
  signedInPage: async ({ page, context, signedInEmail }, use) => {
    await signInAs(page, context.request, signedInEmail);
    try {
      await use(page);
    } finally {
      // Production audit runs use disposable users. Clean them through the
      // supported account route after each fixture, but leave local fixtures
      // unchanged because their test database is reset by the harness.
      if (DEV_ACCESS) {
        const cookie = await authedCookieHeader(context).catch(() => '');
        if (cookie) {
          await context.request
            .delete(`${API_URL}/v1/me`, {
              headers: { cookie },
              data: { confirmEmail: signedInEmail },
            })
            .catch(() => undefined);
        }
      }
    }
  },
  cookieHeader: async ({ context, signedInPage: _signedInPage }, use) => {
    // Depend on signedInPage so cookies exist by the time this resolves.
    const header = await authedCookieHeader(context);
    await use(header);
  },
  apiUrl: async ({}, use) => {
    await use(API_URL);
  },
});

export { expect };
