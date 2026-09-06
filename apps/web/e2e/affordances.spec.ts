import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Affordance / haptics assertions (T7). Non-screenshot checks for the FEEL:
 * hover reveals, cursor states, focus rings, the keyboard shortcuts sheet, and
 * accessible labels — computed-style + visibility assertions. State seeded via
 * the API; no jobs (zero credit spend).
 */

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Аффорданс e2e' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
  state: unknown,
) {
  const id = await newBoard(request, apiUrl, cookie);
  const put = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { state, rev: 0 },
  });
  expect(put.ok()).toBe(true);
  return id;
}

function cursorOf(loc: Locator): Promise<string> {
  return loc.evaluate((el) => getComputedStyle(el).cursor);
}

test.describe('board affordances', () => {
  test('? opens the shortcuts sheet; Escape closes it (keyboard map)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await newBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await page.locator('.react-flow__pane').click({ position: { x: 60, y: 420 } });
    await page.keyboard.press('?');
    await expect(page.getByTestId('shortcuts-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-sheet')).toBeHidden();
  });

  test('icon-only controls carry accessible names (batch stepper + shortcuts)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 200, y: 200 },
          data: { mode: 'image', prompt: '', status: 'idle' },
        },
      ],
      edges: [],
      viewport: { x: 80, y: 60, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);
    // the shortcuts trigger is an icon button with an accessible title
    await expect(page.getByTitle('Горячие клавиши (?)')).toBeVisible();
    // the generate node's batch stepper exposes aria-labelled +/− controls
    await page.locator('.react-flow__node-generate').click();
    await expect(page.getByLabel('Больше')).toBeVisible();
    await expect(page.getByLabel('Меньше')).toBeVisible();
  });

  test('node header shows a grab cursor (drag affordance)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'g1',
          type: 'generate',
          position: { x: 200, y: 200 },
          data: { mode: 'image', prompt: '', status: 'idle' },
        },
      ],
      edges: [],
      viewport: { x: 80, y: 60, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);
    const header = page.locator('.react-flow__node-generate .seed-drag').first();
    await expect(header).toBeVisible();
    expect(await cursorOf(header)).toBe('grab');
  });

  test('hovering a node reveals its typed-port label', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedBoard(context.request, apiUrl, cookieHeader, {
      nodes: [
        {
          id: 'm1',
          type: 'media',
          position: { x: 160, y: 200 },
          data: { url: 'http://example.test/m1.png', mediaKind: 'image' },
        },
      ],
      edges: [],
      viewport: { x: 80, y: 60, zoom: 1 },
    });
    await page.goto(`/boards/${id}`);
    const node = page.locator('.react-flow__node-media');
    await expect(node).toBeVisible();
    // the port label rides on group-hover opacity — hidden until hover
    const label = node.locator('span', { hasText: /.+/ }).last();
    await node.hover();
    await expect
      .poll(async () => Number(await label.evaluate((el) => getComputedStyle(el).opacity)))
      .toBeGreaterThan(0);
  });
});

test.describe('editor affordances', () => {
  const CLIP = (uid: string) => ({
    uid,
    url: 'http://example.test/clip.mp4',
    dur: 5,
    inSec: 0,
    outSec: 5,
    speed: 1,
    muted: false,
    volumeDb: 0,
    filter: 'none',
  });

  async function openEditor(
    page: Page,
    request: APIRequestContext,
    apiUrl: string,
    cookie: string,
  ) {
    const res = await request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    expect(res.ok()).toBe(true);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    await expect(page.getByTestId('clip-inspector').getByTestId('insp-pane-main')).toBeVisible();
  }

  test('transform overlay handles expose resize/grab/move cursors', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await openEditor(page, context.request, apiUrl, cookieHeader);
    const canvas = page.getByTestId('canvas-transform');
    await expect(canvas).toBeVisible();
    expect(await cursorOf(canvas)).toBe('move');
    expect(await cursorOf(canvas.locator('[data-handle="scale"]'))).toBe('nwse-resize');
    expect(await cursorOf(canvas.locator('[data-handle="rotate"]'))).toBe('grab');
  });

  test('a slider input is keyboard-focusable (focus affordance)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await openEditor(page, context.request, apiUrl, cookieHeader);
    const insp = page.getByTestId('clip-inspector');
    const scale = insp.getByTestId('insp-scale-value');
    await scale.focus();
    await expect(scale).toBeFocused();
  });
});
