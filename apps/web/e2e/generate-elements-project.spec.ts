import type { APIRequestContext } from '@playwright/test';
import { FREE_MEDIA_RETENTION_COPY } from '@seed/shared/media-retention';
import { expect, test } from './fixtures';

async function waitForSucceeded(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  jobId: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`${apiUrl}/v1/jobs/${jobId}`, {
          headers: { cookie: cookieHeader },
        });
        const body = (await response.json()) as { status?: string; errorMessage?: string };
        if (body.status === 'failed') throw new Error(body.errorMessage ?? `job ${jobId} failed`);
        return body.status;
      },
      { timeout: 60_000 },
    )
    .toBe('succeeded');
}

test('Generate keeps project context through completion/retry and Elements stays membership-scoped', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;
  const projectTitle = 'Ночное кафе';
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    headers: { cookie: cookieHeader },
    data: { title: projectTitle },
  });
  expect(projectResponse.status()).toBe(201);
  const project = { ...((await projectResponse.json()) as { id: string }), title: projectTitle };
  const grant = await context.request.post(`${apiUrl}/v1/dev/grant-credits`, {
    headers: { cookie: cookieHeader },
    data: { amount: 1_000 },
  });
  expect(grant.ok()).toBe(true);

  const submittedBodies: Array<Record<string, unknown>> = [];
  const submittedJobIds: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/v1/jobs') {
      submittedBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (response.request().method() === 'POST' && url.pathname === '/v1/jobs' && response.ok()) {
      const body = (await response.json()) as { jobId?: string };
      if (body.jobId) submittedJobIds.push(body.jobId);
    }
  });

  await page.goto(`/generate?projectId=${encodeURIComponent(project.id)}`);
  await expect(page.getByTestId('project-context-valid')).toContainText(project.title);
  await page.getByTestId('prompt').fill('Лампа над столиком в ночном кафе');
  await page.getByTestId('submit').click();
  await expect(page.getByTestId('result-image')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('generate-project-receipt')).toContainText(
    `Сохранено в проект «${project.title}»`,
  );
  await expect(page.getByTestId('generate-project-receipt').getByRole('link')).toHaveAttribute(
    'href',
    `/gallery?projectId=${project.id}`,
  );

  await page.getByTestId('action-repeat').click();
  await expect.poll(() => submittedJobIds.length, { timeout: 60_000 }).toBe(2);
  for (const jobId of submittedJobIds) {
    await waitForSucceeded(context.request, apiUrl, cookieHeader, jobId);
  }
  expect(submittedBodies).toHaveLength(2);
  expect(submittedBodies.map((body) => body['projectId'])).toEqual([project.id, project.id]);
  expect(new Set(submittedBodies.map((body) => body['idempotencyKey'])).size).toBe(2);

  const {
    projectId: _projectId,
    idempotencyKey: _idempotencyKey,
    ...standaloneBody
  } = submittedBodies[0]!;
  const standalone = await context.request.post(`${apiUrl}/v1/jobs`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      ...standaloneBody,
      idempotencyKey: `standalone-${Date.now()}`,
      prompt: 'Материал вне проекта',
    },
  });
  expect(standalone.status()).toBe(201);
  const standaloneJobId = ((await standalone.json()) as { jobId: string }).jobId;
  await waitForSucceeded(context.request, apiUrl, cookieHeader, standaloneJobId);

  const scoped = await context.request.get(
    `${apiUrl}/v1/gallery?projectId=${encodeURIComponent(project.id)}&limit=24`,
    { headers: { cookie: cookieHeader } },
  );
  expect(scoped.status()).toBe(200);
  const scopedBody = (await scoped.json()) as {
    rows: Array<{ id: string; jobId: string }>;
  };
  expect(scopedBody.rows.map((row) => row.jobId).sort()).toEqual([...submittedJobIds].sort());
  expect(scopedBody.rows.some((row) => row.jobId === standaloneJobId)).toBe(false);

  await page.goto(`/gallery?projectId=${encodeURIComponent(project.id)}`);
  await expect(page.getByRole('heading', { name: project.title })).toBeVisible();
  await expect(page.getByTestId('free-expiry-banner')).toHaveText(FREE_MEDIA_RETENTION_COPY);
  await expect(page.getByTestId('gallery-item')).toHaveCount(scopedBody.rows.length);
  const renderedIds = await page
    .getByTestId('gallery-item')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset['itemId']));
  expect(renderedIds.sort()).toEqual(scopedBody.rows.map((row) => row.id).sort());
  await expect(page.getByTestId('complete-library-link')).toHaveAttribute('href', '/gallery');
});

test('an invalid project context disables Generate before any job or reservation', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  const page = signedInPage;
  const balanceBefore = await context.request.get(`${apiUrl}/v1/credits/balance`, {
    headers: { cookie: cookieHeader },
  });
  let submitCount = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/v1/jobs') submitCount += 1;
  });

  await page.goto('/generate?projectId=missing-project-context');
  await expect(page.getByTestId('project-context-invalid')).toBeVisible();
  await expect(page.getByTestId('project-context-submit-blocked')).toContainText(
    'Генерация остановлена',
  );
  await page.getByTestId('prompt').fill('Этот запрос не должен уйти');
  await expect(page.getByTestId('submit')).toBeDisabled();
  expect(submitCount).toBe(0);

  const balanceAfter = await context.request.get(`${apiUrl}/v1/credits/balance`, {
    headers: { cookie: cookieHeader },
  });
  expect(await balanceAfter.json()).toEqual(await balanceBefore.json());
});
