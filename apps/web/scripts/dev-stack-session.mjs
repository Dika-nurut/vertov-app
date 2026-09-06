#!/usr/bin/env node
/**
 * Hand `scripts/dev-stack.sh` a READY-TO-USE tester identity.
 *
 * WHY: an AI (or human) walking the whole CJM on a throwaway stack should not
 * have to fight the magic-link mailbox first, and should not hit a paywall on
 * the third click. This does both, once, at stack boot:
 *
 *   1. the programmatic god-login used by e2e (`e2e/auth.setup.ts` /
 *      `e2e/fixtures.ts` signInAs): POST /api/auth/sign-in/magic-link → read
 *      the link back from /v1/dev/last-magic-link → visit the verify URL in a
 *      real browser context so the session cookie lands natively;
 *   2. GET /v1/me, which materialises the users_app / users_pii rows that
 *      god-mode's credit grant needs an FK target for;
 *   3. POST /v1/dev/godmode — 100k credits, tier=max, an active max
 *      subscription. It REQUIRES a session, which is why it can only run here,
 *      after step 1.
 *
 * The resulting `storageState` is written to disk so both Playwright specs
 * (`use: { storageState }`) and a human driving a headed browser can reuse the
 * session without repeating any of the above.
 *
 * Run from apps/web (that is where @playwright/test resolves from).
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} must be set`);
  return v;
}

const API = required('STACK_API_URL').replace(/\/$/, '');
const WEB = required('STACK_WEB_URL').replace(/\/$/, '');
const OUT = required('STACK_STORAGE_STATE');
const EMAIL = process.env.STACK_EMAIL ?? 'tester@seed.local';

const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: WEB });
const page = await context.newPage();

try {
  // Anchor the callback on the WEB origin: Better Auth resolves a relative
  // callbackURL against the API origin, and this stack splits the two.
  const signIn = await context.request.post(`${API}/api/auth/sign-in/magic-link`, {
    headers: { 'content-type': 'application/json' },
    data: { email: EMAIL, callbackURL: `${WEB}/generate` },
  });
  if (!signIn.ok()) throw new Error(`magic-link request HTTP ${signIn.status()}`);

  let link = null;
  for (let i = 0; i < 40 && !link; i++) {
    const res = await context.request.get(
      `${API}/v1/dev/last-magic-link?email=${encodeURIComponent(EMAIL)}`,
    );
    const body = await res.json().catch(() => null);
    if (body?.url && body.email === EMAIL) link = body.url;
    else await new Promise((r) => setTimeout(r, 250));
  }
  if (!link) throw new Error(`magic link for ${EMAIL} was never captured`);

  // Verify in the browser so the cookie is stored by the context itself
  // (context.request shares that jar, so the API calls below are authed too).
  await page.goto(link);
  await page.waitForURL(/\/(?!login)/, { timeout: 30_000 });

  const me = await context.request.get(`${API}/v1/me`);
  if (!me.ok()) throw new Error(`/v1/me HTTP ${me.status()} — session did not stick`);

  const god = await context.request.post(`${API}/v1/dev/godmode`);
  if (!god.ok()) throw new Error(`/v1/dev/godmode HTTP ${god.status()}`);
  // /v1/dev/godmode returns the ledger balance object ({ available, pending }).
  const { balance } = await god.json();
  const available = balance?.available ?? balance;

  const sub = await context.request.get(`${API}/v1/billing/subscription`);
  const subBody = sub.ok() ? await sub.json() : null;
  const tier = subBody?.subscription?.tier ?? subBody?.tier ?? 'unknown';
  const status = subBody?.subscription?.status ?? subBody?.status ?? 'unknown';

  await mkdir(dirname(OUT), { recursive: true });
  await context.storageState({ path: OUT });

  console.log(`session   ${EMAIL} (balance ${available}, sub ${tier}/${status})`);
  console.log(`state     ${OUT}`);
} finally {
  await context.close();
  await browser.close();
}
