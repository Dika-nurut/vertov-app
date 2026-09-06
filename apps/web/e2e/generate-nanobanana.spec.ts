import { test, expect } from './fixtures';

/**
 * Nano Banana family (laozhang.ai primary / kie.ai fallback, see
 * docs/business/pnl.md § Генерация — Nano Banana Pro) — verifies the catalog-driven
 * /generate image picker surfaces all 4 variants alongside Seedream, with
 * correct family filter, capability signs, and tier-lock states.
 *
 * Stops short of pressing «Создать»: this dev stack's PROVIDER_GATEWAY calls
 * REAL providers (no AI_PROVIDER=mock here), so submitting would spend real
 * money — out of scope for a UI-wiring check.
 */

async function openImageModelPicker(page: import('@playwright/test').Page) {
  await page.goto('/generate');
  await page.getByTestId('mode-image').click();
  await page.getByTestId('model-trigger').click();
}

test('image picker shows Seedream + the full Nano Banana family under one "Nano Banana" chip', async ({
  signedInPage,
}) => {
  const page = signedInPage;
  await openImageModelPicker(page);

  await expect(page.getByRole('button', { name: 'Nano Banana', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'seedream', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Nano Banana', exact: true }).click();
  await expect(page.locator('[data-model-id="gemini-2-5-flash-image"]')).toBeVisible();
  await expect(page.locator('[data-model-id="gemini-3-pro-image"]')).toBeVisible();
  await expect(page.locator('[data-model-id="gemini-3-1-flash-image"]')).toBeVisible();
  await expect(page.locator('[data-model-id="gemini-3-1-flash-lite-image"]')).toBeVisible();
  // Filtered to the family — Seedream shouldn't show while this chip is active.
  await expect(page.locator('[data-model-id="seedream-5-0-pro"]')).toHaveCount(0);
});

test('every Nano Banana card shows the REF capability sign', async ({ signedInPage }) => {
  const page = signedInPage;
  await openImageModelPicker(page);
  await page.getByRole('button', { name: 'Nano Banana', exact: true }).click();

  for (const id of [
    'gemini-2-5-flash-image',
    'gemini-3-pro-image',
    'gemini-3-1-flash-image',
    'gemini-3-1-flash-lite-image',
  ]) {
    await expect(page.locator(`[data-model-id="${id}"]`).getByText('REF')).toBeVisible();
  }
});

test('tier gating: a fresh signed-in user sees Pro locked, Lite unlocked with a real cost', async ({
  signedInPage,
}) => {
  const page = signedInPage;
  await openImageModelPicker(page);
  await page.getByRole('button', { name: 'Nano Banana', exact: true }).click();

  // gemini-3-pro-image is tierMin:'creator' — a fresh free-tier user can't
  // afford it, the card shows the lock glyph instead of a cost.
  const proCard = page.locator('[data-model-id="gemini-3-pro-image"]');
  await expect(proCard.getByText(/cr\/s|cr$/)).toHaveCount(0);

  // gemini-3-1-flash-lite-image is tierMin:'free' — visible AND priced.
  const liteCard = page.locator('[data-model-id="gemini-3-1-flash-lite-image"]');
  await expect(liteCard.getByText(/12\s*cr/)).toBeVisible();
});

test('selecting the free-tier Lite model updates the sidebar «Модель» card', async ({
  signedInPage,
}) => {
  const page = signedInPage;
  await openImageModelPicker(page);
  await page.getByRole('button', { name: 'Nano Banana', exact: true }).click();

  await page.locator('[data-model-id="gemini-3-1-flash-lite-image"]').click();
  await page.getByRole('button', { name: 'Готово' }).click();

  // Back on the dock — the «Модель» sidebar card now reflects the selection,
  // and the sr-only <select> (the source of truth other specs drive directly)
  // agrees.
  await expect(page.getByTestId('model-trigger')).toContainText('Nano Banana');
  await expect(page.getByTestId('model-select')).toHaveValue('gemini-3-1-flash-lite-image');

  // The submit button is present and enabled once a prompt is filled — we
  // stop here, deliberately not clicking it (real-money gateway in this env).
  await page.getByTestId('prompt').fill('a red cube');
  await expect(page.getByTestId('submit')).toBeEnabled();
});
