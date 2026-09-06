import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from './fixtures';

const evidenceDir = resolve(__dirname, '../../../docs/evidence/sreda/2026-07-19');

test.use({ viewport: { width: 1440, height: 900 } });
test.skip(process.env.SREDA_EVIDENCE !== '1', 'run explicitly to refresh committed evidence');

test('capture the real persisted workspace desk states', async ({
  signedInPage: page,
  apiUrl,
  context,
}) => {
  const projectResponse = await context.request.post(`${apiUrl}/v1/projects`, {
    data: { title: 'Ночное кафе' },
  });
  expect(projectResponse.ok()).toBe(true);
  const project = (await projectResponse.json()) as { id: string };

  const formatResponse = await context.request.patch(`${apiUrl}/v1/projects/${project.id}`, {
    data: { productionFormat: { aspect: '16:9', note: 'Короткий метр · ≈52 сек' } },
  });
  expect(formatResponse.ok()).toBe(true);

  const folderNames = ['Референсы', 'Отбор', 'Звук'];
  const folderIds = new Map<string, string>();
  for (const name of folderNames) {
    const response = await context.request.post(`${apiUrl}/v1/projects/${project.id}/folders`, {
      data: { name },
    });
    expect(response.ok()).toBe(true);
    const folder = (await response.json()) as { id: string };
    folderIds.set(name, folder.id);
  }

  const uploads = [
    {
      path: resolve(__dirname, '../../../mockups/img/kadr-neon-city.webp'),
      name: 'неон_экстерьер.webp',
      folderId: folderIds.get('Референсы'),
    },
    {
      path: resolve(__dirname, '../../../mockups/img/editor-shot.webp'),
      name: 'героиня_у_окна.webp',
      folderId: folderIds.get('Референсы'),
    },
    {
      path: resolve(__dirname, '../../../mockups/charms-v1.png'),
      name: 'фактура_вывески.png',
      folderId: folderIds.get('Отбор'),
    },
    {
      path: resolve(__dirname, '../../../mockups/img/brand-logo.png'),
      name: 'логотип_кафе.png',
    },
  ];
  for (const upload of uploads) {
    const query = new URLSearchParams({ name: upload.name });
    if (upload.folderId) query.set('folderId', upload.folderId);
    const response = await context.request.post(
      `${apiUrl}/v1/projects/${project.id}/assets?${query.toString()}`,
      {
        headers: { 'content-type': 'application/octet-stream' },
        data: await readFile(upload.path),
      },
    );
    expect(response.ok()).toBe(true);
  }

  await page.goto(`/workspace/${project.id}`);
  await expect(page.getByTestId('workspace-desk')).toBeVisible();
  await expect(page.getByText('Ночное кафе').first()).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, '01-default.png') });

  await page.getByTestId('recent-folder').dblclick();
  const recentsWindow = page.getByTestId('folder-window-recents');
  await expect(recentsWindow).toBeVisible();
  const card = recentsWindow.locator('[data-testid^="asset-card-"]').first();
  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await card.dispatchEvent('dragstart', {
    dataTransfer: transfer,
    clientX: box!.x + box!.width / 2,
    clientY: box!.y + box!.height / 2,
  });
  await page.getByTestId('workspace-desk').dispatchEvent('dragover', {
    dataTransfer: transfer,
    clientX: 760,
    clientY: 550,
  });
  await expect(page.getByTestId('drag-verb')).toContainText('Добавить в папку');
  await page.screenshot({ path: resolve(evidenceDir, '02-drag-state.png') });
  await card.dispatchEvent('dragend', { dataTransfer: transfer });

  await recentsWindow.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByTestId(`folder-target-${folderIds.get('Референсы')}`).dblclick();
  const folderWindow = page.getByTestId(`folder-window-folder:${folderIds.get('Референсы')}`);
  await expect(folderWindow).toBeVisible();
  await expect(folderWindow.locator('[data-testid^="asset-card-"]')).toHaveCount(2);
  await page.screenshot({ path: resolve(evidenceDir, '03-folder-window.png') });

  await folderWindow.getByRole('button', { name: 'Закрыть' }).click();
  await page.getByTestId('recent-folder').dblclick();
  await expect(page.getByTestId('folder-window-recents')).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDir, '04-recents-window.png') });
});
