import { test, expect } from './fixtures';

/**
 * SC3 — capability-driven controls render each OpenRouter engine's TRUE option
 * space in /generate (not the static Seedance constants).
 *
 * The catalog rows ship isActive:false (owner review), so this spec activates
 * the engines under test via the dev endpoint first, then deactivates them
 * after. Zero provider spend: it only inspects the controls, never submits.
 *
 *   Veo 3.1 Fast — 4–8s, 2 aspect ratios (+«авто»), 720p/1080p
 *   Sora 2 Pro   — 4–20s, t2v-only (no first/last-frame upload)
 */
const ENGINES = ['veo-3-1-fast', 'sora-2-pro'];

test.beforeAll(async ({ request, apiUrl }) => {
  await request.post(`${apiUrl}/v1/dev/activate-models`, {
    data: { ids: ENGINES, active: true },
  });
});
test.afterAll(async ({ request, apiUrl }) => {
  await request.post(`${apiUrl}/v1/dev/activate-models`, {
    data: { ids: ENGINES, active: false },
  });
});

async function selectVideoModel(page: import('@playwright/test').Page, modelId: string) {
  await page.goto('/generate');
  await page.getByTestId('mode-video').click();
  // The hidden <select> mirrors modelId — drive it directly (the visual picker
  // hides inactive-by-default engines behind curation; the select is the source).
  await page.getByTestId('model-select').selectOption(modelId);
}

test('Veo 3.1 Fast renders 4–8s and exactly its 2 aspect ratios', async ({ signedInPage }) => {
  const page = signedInPage;
  await selectVideoModel(page, 'veo-3-1-fast');

  // Duration control: ticks read the model's own bounds (4с..8с), not 4..15.
  await page.getByRole('button', { name: 'Длина' }).click();
  await expect(page.getByText('8с', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  // Aspect control: Veo declares 2 ratios → 16:9, 9:16, плюс «авто» = 3 buttons.
  await page.getByRole('button', { name: 'Формат' }).click();
  await expect(page.getByRole('button', { name: '16:9' })).toBeVisible();
  await expect(page.getByRole('button', { name: '9:16' })).toBeVisible();
  await expect(page.getByRole('button', { name: '4:3' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '21:9' })).toHaveCount(0);
});

test('Sora 2 Pro renders up to 20s', async ({ signedInPage }) => {
  const page = signedInPage;
  await selectVideoModel(page, 'sora-2-pro');

  await page.getByRole('button', { name: 'Длина' }).click();
  // Sora allows 20s — past the Seedance 15s ceiling.
  await expect(page.getByText('20с', { exact: true })).toBeVisible();
});
