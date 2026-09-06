import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';

async function grantCredits(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  amount: number,
) {
  const res = await request.post(`${apiUrl}/v1/dev/grant-credits`, {
    data: { amount },
    headers: { cookie: cookieHeader },
  });
  expect(res.ok(), `grant should succeed (got ${res.status()})`).toBeTruthy();
}

async function createJob(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  idempotencyKey: string,
  prompt: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/jobs`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: {
      modelId: 'seedream-5-0-pro',
      prompt,
      params: { size: '1024x1024', n: 1 },
      idempotencyKey,
    },
  });
  expect(
    res.ok(),
    `job create ${idempotencyKey} should succeed (got ${res.status()})`,
  ).toBeTruthy();
  const body = await res.json();
  return body.jobId as string;
}

async function waitForSucceeded(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  jobId: string,
) {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${apiUrl}/v1/jobs/${jobId}`, {
      headers: { cookie: cookieHeader },
    });
    const body = await res.json();
    if (body.status === 'succeeded') return;
    if (body.status === 'failed') throw new Error(`job ${jobId} failed: ${body.errorMessage}`);
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`job ${jobId} did not succeed in time`);
}

test('user can browse gallery and remix back into /generate', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  test.setTimeout(180_000);
  const page = signedInPage;

  await grantCredits(context.request, apiUrl, cookieHeader, 100);

  const prompts = [
    'Закат над горами, акварель',
    'Городская улица в дождь, неон',
    'Космонавт с воздушным шаром',
  ];
  const jobIds: string[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const id = await createJob(
      context.request,
      apiUrl,
      cookieHeader,
      `gallery-${Date.now()}-${i}`,
      prompts[i]!,
    );
    jobIds.push(id);
  }
  for (const id of jobIds) await waitForSucceeded(context.request, apiUrl, cookieHeader, id);

  await page.goto('/gallery');
  await expect(page.getByTestId('gallery-grid')).toBeVisible();
  const items = page.getByTestId('gallery-item');
  await expect(items).toHaveCount(prompts.length, { timeout: 10_000 });

  await items.first().click();
  await expect(page.getByTestId('detail-image')).toBeVisible({ timeout: 10_000 });
  const detailPrompt = await page.getByTestId('detail-prompt').textContent();
  expect(detailPrompt).toBeTruthy();

  await page.getByTestId('remix-button').click();
  await page.waitForURL(/\/generate\?from=/);
  // The prompt editor is a contenteditable div (not an input) — read its text.
  await expect
    .poll(async () => (await page.getByTestId('prompt').textContent())?.trim(), {
      timeout: 10_000,
    })
    .toBe(detailPrompt?.trim());
});
