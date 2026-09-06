import { test, expect } from './fixtures';

test('Studio boots cleanly on the configured browser/device', async ({ signedInPage: page }) => {
  // signInAs lands on /generate, whose bootstrap starts several background
  // fetches. Let those settle before observing /studio so WebKit does not
  // misattribute requests aborted by the navigation as Studio CORS failures.
  await page.waitForTimeout(1_500);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/studio');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.getByTestId('studio-mobile-gate')).toBeAttached();
  expect(errors).toEqual([]);
});

test('a newer local draft survives tab loss and is reconciled to the server', async ({
  signedInPage: page,
  apiUrl,
  cookieHeader,
}) => {
  const meResponse = await page.request.get(`${apiUrl}/v1/me`, {
    headers: { cookie: cookieHeader },
  });
  expect(meResponse.ok()).toBe(true);
  const me = (await meResponse.json()) as { user: { id: string } };
  const serverTimeline = {
    schemaVersion: 2,
    tracks: [{ id: 'base', kind: 'video', clips: [] }],
    texts: [{ id: 'server', text: 'server', fromSec: 0, toSec: 1, position: 'center' }],
    music: null,
    voiceover: null,
    formatId: '16:9',
    bgColor: null,
  };
  const seed = await page.request.put(`${apiUrl}/v1/studio/project`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { timeline: serverTimeline, rev: 40 },
  });
  expect(seed.ok()).toBe(true);

  const localTimeline = {
    ...serverTimeline,
    texts: [
      { id: 'local', text: 'RECOVERED_LOCAL_DRAFT', fromSec: 0, toSec: 1, position: 'center' },
    ],
  };
  await page.addInitScript(
    ({ ownerId, timeline }) => {
      localStorage.setItem(
        `seed.studio.recovery.${encodeURIComponent(ownerId)}.scratch`,
        JSON.stringify({
          formatVersion: 1,
          ownerId,
          projectId: 'scratch',
          rev: 41,
          savedAt: Date.now(),
          timeline,
        }),
      );
    },
    { ownerId: me.user.id, timeline: localTimeline },
  );

  await page.goto('/studio');
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`${apiUrl}/v1/studio/project`, {
          headers: { cookie: cookieHeader },
        });
        const body = await response.json();
        return body.timeline?.texts?.[0]?.text;
      },
      { timeout: 15_000 },
    )
    .toBe('RECOVERED_LOCAL_DRAFT');
});
