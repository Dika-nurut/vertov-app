import { test, expect } from './fixtures';

/**
 * Phase 0 + A1 acceptance (Open-Generative-AI integration): applying a «Кино»
 * cinema preset must NOT overwrite the user's typed subject, and the submitted
 * job must carry the composited cinema prompt + the preset's negative_prompt.
 *
 * ZERO gateway spend: POST /v1/jobs is route-intercepted at the browser and
 * fulfilled with a fake jobId — the request never reaches the API or worker.
 */
test('«Кино» preset composites the subject into the submitted prompt + negative_prompt', async ({
  signedInPage,
}) => {
  test.setTimeout(90_000);
  const page = signedInPage;

  let captured: { prompt?: string; params?: Record<string, unknown> } | null = null;
  await page.route('**/v1/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    captured = route.request().postDataJSON();
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ jobId: 'intercepted-cinema', status: 'queued' }),
    });
  });

  await page.goto('/generate?preset=cinema-70mm-epic');

  // The preset resolved to an image model + slots mode → the applied-preset chip
  // shows «Кино: 70мм Эпик» and the textarea is left for the user's own subject.
  await expect(page.getByTestId('applied-preset-chip')).toBeVisible({ timeout: 20_000 });
  const editor = page.getByTestId('prompt');
  expect(((await editor.textContent()) ?? '').trim()).toBe(''); // preset did NOT overwrite it

  await editor.click();
  await editor.fill('a lone samurai standing in the rain');

  await page.getByTestId('submit').click();

  await expect.poll(() => captured, { timeout: 15_000 }).not.toBeNull();
  const job = captured!;
  // The user's subject survived AND the fixed cinema scaffold composited around it.
  expect(job.prompt).toContain('a lone samurai standing in the rain');
  expect(job.prompt).toContain('70mm film camera');
  expect(job.prompt).toContain('cinematic lighting');
  // Seedream's negative_prompt control was REMOVED (DoD 4): it was dead on the active
  // OpenRouter route (buildOpenRouterImageBody never serializes it), so GenerateClient no
  // longer threads a preset negative into params. The composed PROMPT still rode along above.
  expect(job.params?.['negative_prompt']).toBeUndefined();
});
