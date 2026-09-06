import { test, expect } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext } from '@playwright/test';

/**
 * Accessibility (T8). axe-core pass per primary screen, RU lang/labels, and
 * keyboard reachability of the core loop. We FAIL on serious/critical
 * violations and baseline the known ones by rule id (see KNOWN below), so a new
 * regression surfaces while the existing backlog doesn't block the floor.
 * State seeded via the API; no jobs (zero credit spend).
 */

// Rule ids we knowingly tolerate today (documented debt — captured 2026-06-12).
// A NEW serious/critical violation outside this set fails the suite.
//   label                 — board: an unlabelled control (icon input)
//   aria-input-field-name — generate: an aria input without an accessible name
//   color-contrast        — warm-paper low-contrast hints (skin-wide)
const KNOWN: string[] = ['color-contrast', 'label', 'aria-input-field-name'];

async function scan(page: import('@playwright/test').Page, selector = 'body') {
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const blocking = serious.filter((v) => !KNOWN.includes(v.id));
  return { blocking, all: results.violations };
}

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'A11y e2e' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test.describe('accessibility — primary screens', () => {
  test('document is RU (lang=ru)', async ({ signedInPage: page }) => {
    await page.goto('/boards');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');
  });

  test('boards list has no new serious/critical axe violations', async ({ signedInPage: page }) => {
    await page.goto('/boards');
    await page.waitForLoadState('networkidle');
    const { blocking } = await scan(page);
    expect(blocking.map((v) => v.id)).toEqual([]);
  });

  test('board canvas has no new serious/critical axe violations', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await page.waitForLoadState('networkidle');
    const { blocking } = await scan(page);
    expect(blocking.map((v) => v.id)).toEqual([]);
  });

  test('generate screen has no new serious/critical axe violations', async ({
    signedInPage: page,
  }) => {
    await page.goto('/generate');
    await page.waitForLoadState('networkidle');
    const { blocking } = await scan(page);
    expect(blocking.map((v) => v.id)).toEqual([]);
  });

  test('studio editor has no new serious/critical axe violations', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [
            {
              uid: 'c1',
              url: 'http://example.test/clip.mp4',
              dur: 5,
              inSec: 0,
              outSec: 5,
              speed: 1,
              muted: false,
              volumeDb: 0,
              filter: 'none',
            },
          ],
          texts: [],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    await page.waitForLoadState('networkidle');
    const { blocking } = await scan(page);
    expect(blocking.map((v) => v.id)).toEqual([]);
  });
});
