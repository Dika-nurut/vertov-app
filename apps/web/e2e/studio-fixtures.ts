import { test as base, expect, type Page } from '@playwright/test';
import { authedCookieHeader } from './fixtures';

/**
 * Studio-floor fixtures. The `studio` Playwright project `use`s the shared god
 * `storageState` (see `auth.setup.ts`), so the browser context is ALREADY
 * authenticated when a test starts — no per-test magic-link round-trip. These
 * fixtures therefore just surface the authed page + its cookie header for the
 * direct `PUT /v1/studio/project` seeding the floor relies on.
 *
 * One shared god account across the suite is safe because the floor runs serially
 * (`workers: 1`) and every test PUTs its own full project before asserting.
 */
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000';

export interface StudioFixtures {
  signedInPage: Page;
  cookieHeader: string;
  apiUrl: string;
}

export const test = base.extend<StudioFixtures>({
  // Context is pre-authenticated via the project's storageState; nothing to do.
  signedInPage: async ({ page }, use) => {
    await use(page);
  },
  cookieHeader: async ({ context }, use) => {
    await use(await authedCookieHeader(context));
  },
  apiUrl: async ({}, use) => {
    await use(API_URL);
  },
});

export { expect };
