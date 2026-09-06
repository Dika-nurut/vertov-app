import { test, expect } from '@playwright/test';

/**
 * Public landing v13 smoke: anonymous render, the headline word-swap
 * (HeadlineCycle) advances, the hero prompt bar routes (empty → /login, typed
 * → anonymous /generate → signup wall at the metered submit), FeatureTabs switch, preset-shelf cards
 * deep-link to /generate?preset=…, mobile has no h-overflow across the FULL
 * word cycle (P0: «Смонтировано.» used to push 375 → 542px), and the
 * word-swap keeps advancing even under prefers-reduced-motion (deliberate
 * owner decision 2026-07-02 — only the stamp visual effect is disabled, not
 * the cycle itself). Run against a prod build (the :8300 landing preview or
 * prod-floor), NOT the dev server.
 */

async function headlineText(page: import('@playwright/test').Page) {
  return (await page.locator('[data-testid="headline-cycle"]').innerText()).trim();
}

test.describe('public landing v12', () => {
  test('anonymous / renders, headline advances, tabs switch, CTAs route', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/');
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Скажи');

    // HeadlineCycle stamps a verb and hard-cuts to the next
    const headline = page.locator('[data-testid="headline-cycle"]');
    await expect(headline).toBeVisible();
    const first = await headlineText(page);
    await expect
      .poll(async () => (await headlineText(page)) !== first, { timeout: 8000 })
      .toBe(true);

    // FeatureTabs (Холст default): clicking «Студия» hard-cuts to that card
    await expect(page.getByRole('heading', { name: 'Собери на холсте' })).toBeVisible();
    await page.getByRole('tab', { name: 'Студия' }).click();
    await expect(page.getByRole('tab', { name: 'Студия' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('heading', { name: 'Смонтируй и озвучь' })).toBeVisible();

    // CTA band + «Войти» route to the login flow
    await expect(page.getByRole('link', { name: /Снять бесплатно/ }).first()).toHaveAttribute(
      'href',
      '/login',
    );
    await expect(page.getByRole('link', { name: 'Войти' }).first()).toHaveAttribute(
      'href',
      '/login',
    );

    // preset shelves (content-gated — self-hidden when previews are missing):
    // every card is a whole-card deep link into /generate?preset=…
    const cards = page.locator('[data-testid="landing-preset-card"]');
    if ((await cards.count()) > 0) {
      await expect(cards.first()).toHaveAttribute('href', /\/generate\?preset=/);
    }

    // below the fold: CTA band + footer are unconditional (витрина can be empty)
    await expect(page.getByRole('heading', { name: /Твой первый кадр/ })).toBeAttached();
    await expect(page.getByRole('contentinfo')).toBeAttached();

    expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);
  });

  // Витрина regression guard (2026-07-26). All three failures came from the
  // same place: 16 of 25 posters were missing from the bucket, so posters
  // 404'd, dead cards dragged the wall under MIN_CELLS and the section
  // unmounted mid-visit (a click then landed on nothing and the landing looked
  // like it had reloaded without Витрина), and motion cells only played on
  // hover so the wall read as frozen.
  test('витрина: posters all load, loops autoplay on screen, section survives', async ({
    page,
  }) => {
    // loops the wall asks for on its own (no hover anywhere in this test)
    const loopRequests: string[] = [];
    page.on('request', (r) => {
      if (/\/seed-preset-previews\/.*\.mp4/.test(r.url())) loopRequests.push(r.url());
    });

    await page.goto('/');
    const section = page.locator('#vitrina');
    if ((await section.count()) === 0) test.skip(true, 'витрина self-hidden — catalog not seeded');

    const cells = page.locator('[data-testid="vitrina-cell"]');
    const before = await cells.count();
    expect(before).toBeGreaterThanOrEqual(11);

    // scroll the whole wall so every lazy poster is fetched, then let the
    // errors (if any) land
    await section.scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
    });
    await page.waitForTimeout(2500);

    // the section must still be there with the same cells — a poster that
    // fails may shorten a column, it may never delete the wall
    await expect(section).toBeVisible();
    expect(await cells.count()).toBe(before);

    // no broken images: every poster decoded to real pixels
    const broken = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLImageElement>('[data-testid="vitrina-cell"] img')]
        .filter((img) => img.complete && img.naturalWidth === 0)
        .map((img) => img.getAttribute('src')),
    );
    expect(broken, `broken витрина posters: ${broken.join(', ')}`).toEqual([]);

    // Motion cells mount their loop by themselves while on screen — GIF-style,
    // no hover involved. Asserted via the fetch the mount causes rather than via
    // playback: Playwright's bundled Chromium has NO H.264 decoder
    // (canPlayType('…avc1…') === ''), so every real .mp4 errors there with
    // DEMUXER_ERROR_NO_SUPPORTED_STREAMS and the cell correctly falls back to
    // its poster. Requesting the loop is our logic; decoding is the browser's.
    expect(
      loopRequests.length,
      'an on-screen витрина loop should fetch itself with no hover',
    ).toBeGreaterThan(0);
    const video = page.locator('[data-testid="vitrina-cell"] video').first();
    const attrs =
      (await video.count()) > 0
        ? await video.evaluate((v: HTMLVideoElement) => [
            v.autoplay,
            v.muted,
            v.loop,
            v.playsInline,
          ])
        : null; // already fell back to the poster (no codec)
    if (attrs) expect(attrs).toEqual([true, true, true, true]);
  });

  test('витрина: a cell opens its prompt dialog and Esc returns focus to the cell', async ({
    page,
  }) => {
    await page.goto('/');
    const section = page.locator('#vitrina');
    if ((await section.count()) === 0) test.skip(true, 'витрина self-hidden — catalog not seeded');

    const cell = page.locator('[data-testid="vitrina-cell"]').filter({
      has: page.locator(
        '[data-testid="vitrina-cell-cta"][href="/generate?preset=demo-gemini-3-1-flash-image-yearbook-90s"]',
      ),
    });
    const trigger = cell.getByRole('button');
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('A 1990s high-school yearbook portrait');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('витрина: the hover HUD CTA still deep-links into the matching preset', async ({ page }) => {
    await page.goto('/');
    const section = page.locator('#vitrina');
    if ((await section.count()) === 0) test.skip(true, 'витрина self-hidden — catalog not seeded');

    const cell = page.locator('[data-testid="vitrina-cell"]').first();
    const cta = cell.getByTestId('vitrina-cell-cta');
    await expect(cta).toHaveAttribute('href', /^\/generate\?preset=/);
    await cell.hover();
    await cta.click();
    await page.waitForURL(/\/generate\?preset=|\/login\?next=/);
  });

  test('витрина: desktop cells preserve their stored ratios at awkward widths', async ({
    browser,
  }) => {
    for (const width of [1440, 1287]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      await page.goto('/');
      const cells = page.locator('[data-testid="vitrina-cell"]');
      expect(await cells.count()).toBeGreaterThan(0);

      const measurements = await cells.evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            ratio: Number(getComputedStyle(element).getPropertyValue('--card-ratio')),
            renderedRatio: rect.width / rect.height,
          };
        }),
      );
      for (const measurement of measurements) {
        expect(Math.abs(measurement.renderedRatio / measurement.ratio - 1)).toBeLessThanOrEqual(
          0.015,
        );
      }
      await context.close();
    }
  });

  test('375px mobile: headline present, tabs present, no horizontal overflow across the full word cycle', async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 720 } });
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Скажи');
    await expect(page.locator('[data-testid="headline-cycle"]')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Холст' })).toBeVisible();

    // P0 regression guard: «Смонтировано.» used to push scrollWidth → 542px
    // mid-cycle. Sample overflow while walking the FULL 3-word cycle.
    const seen = new Set<string>();
    const deadline = Date.now() + 15000;
    while (seen.size < 3 && Date.now() < deadline) {
      seen.add(await headlineText(page));
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `overflow px at «${[...seen].at(-1)}»`).toBeLessThanOrEqual(0);
      await page.waitForTimeout(150);
    }
    expect(seen.size, 'distinct headline words observed').toBe(3);
    await ctx.close();
  });

  test('hero prompt bar: empty submit → /login; typed prompt reaches Generate then the metered auth wall', async ({
    page,
  }) => {
    await page.goto('/');
    const input = page.locator('[data-testid="hero-prompt-input"]');
    await expect(input).toBeVisible();

    // empty submit behaves like the old CTA button
    await page.locator('[data-testid="hero-prompt-submit"]').click();
    await page.waitForURL(/\/login$/);

    // Typed submit intentionally opens the anonymous-browsable Generate page.
    // The auth wall belongs at the actual credit-spending POST, not at the
    // creative surface (guest-CJM decision, 2026-07-09).
    await page.goto('/');
    await input.fill('неоновый детектив, крупный план');
    await page.locator('[data-testid="hero-prompt-submit"]').click();
    await page.waitForURL(/\/generate\?/);
    const generateUrl = new URL(page.url());
    expect(generateUrl.pathname).toBe('/generate');
    expect(generateUrl.searchParams.get('prompt')).toBe('неоновый детектив, крупный план');

    // This is the real paywall boundary. The API rejects the anonymous job
    // before provider dispatch, so this assertion does not spend credits or
    // invoke an external model.
    const submit = page.getByTestId('submit');
    await expect(submit).toBeEnabled({ timeout: 20_000 });
    let jobStatus: number | null = null;
    let jobError: string | null = null;
    await page.route(/\/v1\/jobs$/, async (route) => {
      const upstream = await route.fetch();
      jobStatus = upstream.status();
      const body = (await upstream.json().catch(() => ({}))) as { error?: unknown };
      jobError = typeof body.error === 'string' ? body.error : null;
      await route.fulfill({ response: upstream, json: body });
    });
    await submit.click();
    await expect.poll(() => jobStatus).toBe(403);
    expect(jobError).toBe('signup_required');
    await page.unroute(/\/v1\/jobs$/);
    await page.waitForURL(/\/login\?next=/, { timeout: 20_000 });
    const next = new URL(page.url()).searchParams.get('next')!;
    expect(next).toMatch(/^\/generate\?/);
    expect(new URL(next, 'http://x').searchParams.get('prompt')).toBe(
      'неоновый детектив, крупный план',
    );
  });

  test('headline keeps advancing under prefers-reduced-motion (owner decision 2026-07-02)', async ({
    browser,
  }) => {
    // Freeze variants read as "broken" — the headline is treated like an
    // autoplaying muted video. This test documents that deliberate choice:
    // only the stamp keyframe is disabled under reduced-motion, the JS word
    // cycle itself is not gated on it.
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    await page.goto('/');
    const first = await headlineText(page);
    await expect
      .poll(async () => (await headlineText(page)) !== first, { timeout: 8000 })
      .toBe(true);
    await ctx.close();
  });
});
