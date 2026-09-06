import { test, expect } from './fixtures';

test('Boards list explains failures and recovers through trash without losing a card', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const seeded = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Не потерять' },
  });
  expect(seeded.status()).toBe(201);
  const board = (await seeded.json()) as { id: string };

  await page.goto('/boards');
  await expect(page.getByTestId('board-card')).toHaveCount(1);

  await page.route(`${apiUrl}/v1/boards`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  await page.getByTestId('board-create').click();
  await expect(page.getByTestId('boards-error')).toContainText('Не удалось создать борд');
  await expect(page.getByTestId('board-card')).toHaveCount(1);
  await page.unroute(`${apiUrl}/v1/boards`);

  await page.route(`${apiUrl}/v1/boards/${board.id}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      return;
    }
    await route.continue();
  });
  await page.getByTestId(`board-delete-${board.id}`).click();
  await expect(page.getByTestId('board-action-dialog')).toBeVisible();
  await page.getByTestId('board-trash-confirm').click();
  await expect(page.getByTestId('boards-error')).toContainText('Не удалось переместить борд');
  await expect(page.getByTestId('board-card')).toHaveCount(1);
  await page.getByTestId('board-action-cancel').click();
  await page.unroute(`${apiUrl}/v1/boards/${board.id}`);

  await page.getByTestId(`board-delete-${board.id}`).click();
  await page.getByTestId('board-trash-confirm').click();
  await expect(page.getByTestId('board-card')).toHaveCount(0);
  await expect(page.getByTestId('board-create-empty')).toBeVisible();

  await page.getByTestId('boards-trash-toggle').click();
  await expect(page.getByTestId(`board-trash-card-${board.id}`)).toBeVisible();
  await page.getByTestId(`board-restore-${board.id}`).click();
  await page.getByTestId('boards-trash-toggle').click();
  await expect(page.getByTestId('board-card')).toHaveCount(1);

  await page.getByTestId(`board-duplicate-${board.id}`).click();
  await expect(page.getByTestId('board-card')).toHaveCount(2);
});

test('Boards list explains the server-enforced project limit', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const seeded = await context.request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Лимит' },
  });
  expect(seeded.status()).toBe(201);
  await page.goto('/boards');
  await page.route(`${apiUrl}/v1/boards`, async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too_many_boards', max: 50 }),
      });
      return;
    }
    await route.continue();
  });
  await page.getByTestId('board-create').click();
  await expect(page.getByTestId('boards-error')).toContainText('не больше 50 бордов');
});
