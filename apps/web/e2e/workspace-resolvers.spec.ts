import { expect, test } from './fixtures';

test('a Scenario dock resolver opens intent-first and never mutates on GET', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  test.setTimeout(120_000);
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    headers: { cookie: cookieHeader },
    data: { title: `Resolver desk ${Date.now()}` },
  });
  expect(projectResponse.status()).toBe(201);
  const { id: projectId } = (await projectResponse.json()) as { id: string };
  const resolverUrl = `/workspace/resolve/scenario?projectId=${encodeURIComponent(projectId)}`;

  const directVisit = await page.goto(resolverUrl);
  expect(directVisit?.status()).toBe(405);
  const beforeClick = await context.request.get(
    `${apiUrl}/v1/scripts?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  expect(beforeClick.status()).toBe(200);
  expect((await beforeClick.json()).items).toEqual([]);

  await page.goto(`/workspace/${projectId}`);
  await expect(page.getByTestId('workspace-desk')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('dock-scenario').click();
  await expect(page).toHaveURL(new RegExp(`/scenario/new\\?projectId=${projectId}$`), {
    timeout: 30_000,
  });
  await expect(page.getByTestId('scenario-new-page')).toBeVisible();

  // Resolving twice must reopen the same intent surface and still make no row.
  await page.goto(`/workspace/${projectId}`);
  await expect(page.getByTestId('workspace-desk')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('dock-scenario').click();
  await expect(page).toHaveURL(new RegExp(`/scenario/new\\?projectId=${projectId}$`), {
    timeout: 30_000,
  });

  const afterSecondResolve = await context.request.get(
    `${apiUrl}/v1/scripts?projectId=${encodeURIComponent(projectId)}&limit=100`,
    { headers: { cookie: cookieHeader } },
  );
  expect(afterSecondResolve.status()).toBe(200);
  expect((await afterSecondResolve.json()).items).toEqual([]);

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/scenario/new\\?projectId=${projectId}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/workspace/${projectId}$`));
  await expect(page.getByTestId('workspace-desk')).toBeVisible();
});
