import { test, expect } from './fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * Visual regression (T6). Element-scoped `toHaveScreenshot` baselines for the
 * warm-paper skin + key surfaces. Determinism is mandatory: animations are
 * disabled, the caret is hidden, the live video preview is masked, and state is
 * seeded via the API (no jobs → zero credit spend). Baselines are committed;
 * regenerate intentionally with `--update-snapshots`.
 *
 * Element screenshots (not full-page) keep the baseline tight and stable —
 * scrollbars / viewport chrome don't leak in. Baselines are generated per
 * project (chromium + yandex); both are the same Blink engine so the pixels
 * match, and `{projectName}` namespacing keeps the files separate.
 */
const SHOT = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 } as const;

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Визуал e2e' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  state: unknown,
): Promise<string> {
  const id = await newBoard(request, apiUrl, cookie);
  const put = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBe(true);
  return id;
}

test.describe('visual regression — warm-paper skin', () => {
  test('board canvas tool rail (warm-paper) matches baseline', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [{ id: 'n1', type: 'note', position: { x: 200, y: 200 }, data: { text: 'Сид' } }],
      edges: [],
      viewport: { x: 80, y: 60, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);
    const rail = page.getByTestId('rail-tools');
    await expect(rail).toBeVisible();
    await expect(rail).toHaveScreenshot('rail-tools.png', SHOT);
  });

  test('board note node (warm-paper) matches baseline', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        { id: 'n1', type: 'note', position: { x: 200, y: 200 }, data: { text: 'Сид · заметка' } },
      ],
      edges: [],
      viewport: { x: 80, y: 60, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);
    const node = page.locator('.react-flow__node-note');
    await expect(node).toBeVisible();
    await expect(node).toHaveScreenshot('note-node.png', SHOT);
  });

  test('editor inspector — Основное pane matches baseline', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const clip = {
      uid: 'c1',
      url: 'http://example.test/clip.mp4',
      dur: 5,
      inSec: 0,
      outSec: 5,
      speed: 1,
      muted: false,
      volumeDb: 0,
      filter: 'none',
    };
    const res = await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: { timeline: [clip], texts: [], music: null, voiceover: null, formatId: '9:16' },
      },
    });
    expect(res.ok()).toBe(true);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    const insp = page.getByTestId('clip-inspector');
    await expect(insp.getByTestId('insp-pane-main')).toBeVisible();
    await expect(insp).toHaveScreenshot('inspector-main.png', SHOT);
  });
});
