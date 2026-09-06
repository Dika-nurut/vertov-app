// Programmatic «god-mode» test login (dev-only). Bypasses the slow consent-UI
// hydration the magic-link fixture pays per fresh context: POST the god magic
// link → read it from the dev capture endpoint → goto the verify URL so the
// browser context stores the real session cookie natively. Returns an
// authenticated Playwright `page` + `context`; optionally persists storageState.
//
//   node e2e/_godlogin.mjs                       # smoke: log in, dump cookie names
//   import { godLogin } from './_godlogin.mjs'    # reuse in a driver script
import { chromium } from '@playwright/test';

const WEB = process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3000';
const API = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? WEB;
const EMAIL = process.env.GOD_EMAIL ?? 'god@seed.local';
// On PROD the /v1/dev/* helpers are secret-gated (server.ts). Set DEV_ACCESS to
// the VM's DEV_ACCESS_SECRET to drive the deployed site; unset for the local floor.
const DEV_ACCESS = process.env.DEV_ACCESS;
const devHeaders = DEV_ACCESS ? { 'x-dev-access': DEV_ACCESS } : {};

/** Drive the god magic-link flow inside a fresh context; resolve once the
 *  session cookie is set, /dev/enter has provisioned the account, and /v1/me
 *  confirms the authenticated session. */
export async function godLogin({ headless = true, storageStatePath, deviceScaleFactor } = {}) {
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    baseURL: WEB,
    ignoreHTTPSErrors: true,
    ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
  });
  const page = await context.newPage();

  // 1) request the god link (no UI) — context.request shares the cookie jar
  const signIn = await context.request.post(`${API}/api/auth/sign-in/magic-link`, {
    headers: { 'content-type': 'application/json' },
    data: { email: EMAIL, callbackURL: `${WEB}/dev/enter` },
  });
  if (!signIn.ok()) throw new Error(`god sign-in HTTP ${signIn.status()}`);

  // 2) read the captured link (poll briefly — capture is async)
  let url = null;
  for (let i = 0; i < 20; i++) {
    const res = await context.request.get(
      `${API}/v1/dev/last-magic-link?email=${encodeURIComponent(EMAIL)}`,
      { headers: devHeaders },
    );
    const body = await res.json();
    if (body?.url && body.email === EMAIL) {
      url = body.url;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!url) throw new Error('god magic link not captured');

  // 3) verify in the browser → cookie is stored in the context natively, then
  //    wait until /dev/enter has topped up god credits and redirected.
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(/\/generate(?:[/?#]|$)/, { timeout: 30_000 });

  const me = await context.request.get(`${API}/v1/me`, { headers: devHeaders });
  if (!me.ok()) throw new Error(`/v1/me HTTP ${me.status()} — session did not stick`);

  // Provision credits + a creator subscription. Locally the /dev/enter
  // interstitial does this; on prod it can't send the secret header, so the
  // harness calls godmode directly (shares the session cookie).
  if (DEV_ACCESS) {
    // Materialize the application's user rows before godmode grants credits.
    // Better Auth owns the session row, while /v1/me owns this first-call
    // synchronization; skipping it can race the users_app foreign key.
    const godmode = await context.request.post(`${API}/v1/dev/godmode`, { headers: devHeaders });
    if (!godmode.ok()) throw new Error(`/v1/dev/godmode HTTP ${godmode.status()}`);
  }

  const balance = await context.request.get(`${API}/v1/credits/balance`, { headers: devHeaders });
  if (!balance.ok()) throw new Error(`/v1/credits/balance HTTP ${balance.status()}`);
  const balanceBody = await balance.json();
  if (!(typeof balanceBody.available === 'number' && balanceBody.available > 0)) {
    throw new Error(`/v1/credits/balance has no usable credits (${String(balanceBody.available)})`);
  }

  if (storageStatePath) await context.storageState({ path: storageStatePath });
  return { browser, context, page };
}

// Standalone smoke when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, context, page } = await godLogin({ headless: true });
  const cookies = await context.cookies();
  console.log('landed at:', page.url());
  console.log('cookies:', cookies.map((c) => c.name).join(', '));
  const res = await context.request.get(`${API}/v1/studio/project`);
  console.log('GET /v1/studio/project ->', res.status());
  await browser.close();
}
