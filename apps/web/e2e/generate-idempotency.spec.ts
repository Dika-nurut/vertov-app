import { expect, test } from './fixtures';

test('Generate suppresses rapid pointer and keyboard re-entry while preserving retries and multi-take', async ({
  signedInPage,
  cookieHeader,
  apiUrl,
  context,
}) => {
  const page = signedInPage;
  const submissions: Array<Record<string, unknown>> = [];
  let responseNumber = 0;
  let releaseHeldResponse: (() => void) | undefined;
  let holdNextResponse = true;
  let abortNextResponse = false;
  let conflictNextResponse = false;

  const godmode = await context.request.post(`${apiUrl}/v1/dev/godmode`, {
    headers: { cookie: cookieHeader },
  });
  expect(godmode.ok(), `godmode should succeed (got ${godmode.status()})`).toBeTruthy();

  await page.route('**/v1/jobs', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    submissions.push(route.request().postDataJSON() as Record<string, unknown>);
    if (holdNextResponse) {
      holdNextResponse = false;
      await new Promise<void>((resolve) => {
        releaseHeldResponse = resolve;
      });
    }
    if (abortNextResponse) {
      abortNextResponse = false;
      await route.abort('connectionfailed');
      return;
    }
    if (conflictNextResponse) {
      conflictNextResponse = false;
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'idempotency_request_mismatch' }),
      });
      return;
    }
    responseNumber += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        jobId: `idempotency-e2e-${responseNumber}`,
        status: 'queued',
        creditsReserved: 1,
      }),
    });
  });

  await page.goto('/generate');
  await page.getByTestId('prompt').fill('Проверка одного логического запуска');
  const submit = page.getByTestId('submit');
  await expect(submit).toBeEnabled();

  // Two pointer-originated clicks in one JS turn both reach the form before a
  // React state commit can disable the button.
  await submit.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => submissions.length).toBe(1);
  releaseHeldResponse?.();
  await expect.poll(() => responseNumber).toBe(1);

  // Once the first POST is accepted, a later explicit generation is unrelated
  // and receives a fresh key.
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => submissions.length).toBe(2);
  await expect.poll(() => responseNumber).toBe(2);
  await expect(submit).toBeEnabled();
  expect(submissions[1]?.['idempotencyKey']).not.toBe(submissions[0]?.['idempotencyKey']);

  // The global shortcut has the same synchronous protection when repeated
  // before React can publish the submitting state.
  await page.evaluate(() => {
    const event = () =>
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
    window.dispatchEvent(event());
    window.dispatchEvent(event());
  });
  await expect.poll(() => submissions.length).toBe(3);
  await expect.poll(() => responseNumber).toBe(3);
  await expect(submit).toBeEnabled();

  // A transport failure releases the guard and deliberately reuses the key:
  // if the server committed before the connection disappeared, its API
  // idempotency contract replays that job instead of charging again.
  abortNextResponse = true;
  await submit.click();
  await expect.poll(() => submissions.length).toBe(4);
  await expect(page.getByText('Ошибка', { exact: true })).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => submissions.length).toBe(5);
  await expect.poll(() => responseNumber).toBe(4);
  await expect(submit).toBeEnabled();
  expect(submissions[4]?.['idempotencyKey']).toBe(submissions[3]?.['idempotencyKey']);

  // If the lost response actually committed and the user edits the request,
  // the server rejects the stale key. The client explains the retry and
  // rotates the key so the next submit is recoverable without wiping the draft.
  abortNextResponse = true;
  await submit.click();
  await expect.poll(() => submissions.length).toBe(6);
  await expect(page.getByText('Ошибка', { exact: true })).toBeVisible();
  await page.getByTestId('prompt').fill('Изменённый запрос после потерянного ответа');
  conflictNextResponse = true;
  await submit.click();
  await expect.poll(() => submissions.length).toBe(7);
  await expect(
    page.getByText('Запрос изменился после сбоя. Нажмите «Создать» ещё раз.'),
  ).toBeVisible();
  await submit.click();
  await expect.poll(() => submissions.length).toBe(8);
  await expect.poll(() => responseNumber).toBe(5);
  expect(submissions[6]?.['idempotencyKey']).toBe(submissions[5]?.['idempotencyKey']);
  expect(submissions[7]?.['idempotencyKey']).not.toBe(submissions[6]?.['idempotencyKey']);

  // One accepted video submission with three takes remains three intentional
  // jobs, each with its own key.
  await page.getByTestId('mode-video').click();
  await page.getByTestId('takes-inc').click();
  await page.getByTestId('takes-inc').click();
  await submit.click();
  await expect.poll(() => submissions.length).toBe(11);
  const takeKeys = submissions.slice(8).map((body) => body['idempotencyKey']);
  expect(new Set(takeKeys).size).toBe(3);
});
