import { expect, test } from './fixtures';

type ProjectDocument = { id: string };

async function assertChrome(page: import('@playwright/test').Page, href: string) {
  await page.goto(href);
  await expect(page.getByTestId('project-context-valid')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('product-nav')).toHaveCount(0);
}

/**
 * Standalone splits in two, and the split is older than this phase.
 *
 * Most surfaces mount `AppShell`, so leaving a project must give the big header
 * back — that is what proves the bar replaced it rather than added to it.
 *
 * `/scenario/:id` and `/boards/:id` are full-screen editors that have NEVER
 * rendered `AppShell`; they carry their own document toolbar instead. Demanding
 * a product nav there would assert a header that never existed. So they only
 * have to prove the OS bar is gone. (`/studio/:id` does mount AppShell, in
 * fullBleed mode, so it belongs with the majority.)
 */
async function assertStandaloneChrome(
  page: import('@playwright/test').Page,
  href: string,
  { hasAppShell }: { hasAppShell: boolean },
) {
  await page.goto(href);
  await expect(page.getByTestId('product-nav')).toHaveCount(hasAppShell ? 1 : 0, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('project-context-valid')).toHaveCount(0);
}

test('every project product route renders exactly one OS bar and no AppShell nav', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(240_000);
  const headers = { cookie: cookieHeader, 'content-type': 'application/json' };
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    headers,
    data: { title: `Chrome guard ${Date.now()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const { id: projectId } = (await projectResponse.json()) as ProjectDocument;

  const [scriptResponse, boardResponse, studioResponse] = await Promise.all([
    context.request.post(`${apiUrl}/v1/scripts`, { headers, data: { projectId } }),
    context.request.post(`${apiUrl}/v1/boards`, {
      headers,
      data: { title: 'Chrome guard board', projectId },
    }),
    context.request.post(`${apiUrl}/v1/studio/projects`, {
      headers,
      data: { title: 'Chrome guard studio', projectId },
    }),
  ]);
  expect(scriptResponse.status()).toBe(201);
  expect(boardResponse.status()).toBe(201);
  expect(studioResponse.status()).toBe(201);
  const script = (await scriptResponse.json()) as ProjectDocument;
  const board = (await boardResponse.json()) as ProjectDocument;
  const studio = (await studioResponse.json()) as ProjectDocument;

  // /gallery/:id is a JOB detail route, so an uploaded asset cannot stand in for
  // it — an upload leaves gallery_items.job_id null. A real job against the
  // stack's mock provider is the pattern this repo already uses for gallery
  // fixtures (see gallery.spec.ts); AI_PROVIDER=mock means no paid provider is
  // ever called, and the credits are this throwaway stack's own.
  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    headers: { cookie: cookieHeader },
    data: { amount: 100 },
  });
  expect(grant.ok(), `grant-credits failed: ${grant.status()}`).toBeTruthy();
  const jobResponse = await context.request.post(`${apiUrl}/v1/jobs`, {
    headers,
    data: {
      modelId: 'seedream-5-0-pro',
      prompt: 'chrome guard fixture',
      params: { size: '1024x1024', n: 1 },
      projectId,
      idempotencyKey: `chrome-guard-${projectId}`,
    },
  });
  expect(jobResponse.ok(), `job create failed: ${jobResponse.status()}`).toBeTruthy();
  const { jobId } = (await jobResponse.json()) as { jobId: string };
  await expect
    .poll(
      async () => {
        const res = await context.request.get(`${apiUrl}/v1/jobs/${jobId}`, {
          headers: { cookie: cookieHeader },
        });
        return ((await res.json()) as { status: string }).status;
      },
      { timeout: 60_000, intervals: [750] },
    )
    .toBe('succeeded');
  const galleryJobId = jobId;

  // Every route PROJECT_PRODUCT_PATH matches. `hasAppShell` records whether the
  // route had a website header before this phase — see assertStandaloneChrome.
  const projectRoutes: Array<{ href: string; hasAppShell: boolean }> = [
    { href: '/generate', hasAppShell: true },
    { href: '/gallery', hasAppShell: true },
    { href: '/scenario', hasAppShell: true },
    { href: '/boards', hasAppShell: true },
    { href: '/studio', hasAppShell: true },
    { href: '/studio/projects', hasAppShell: true },
    { href: `/studio/${studio.id}`, hasAppShell: true },
    { href: `/gallery/${galleryJobId}`, hasAppShell: true },
    { href: `/scenario/${script.id}`, hasAppShell: false },
    { href: `/boards/${board.id}`, hasAppShell: false },
  ];
  for (const { href } of projectRoutes) {
    await assertChrome(page, `${href}?projectId=${encodeURIComponent(projectId)}`);
  }
  for (const { href, hasAppShell } of projectRoutes) {
    await assertStandaloneChrome(page, href, { hasAppShell });
  }
});
