import { test, expect } from './fixtures';
import AxeBuilder from '@axe-core/playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'desktop-1024x768', width: 1024, height: 768, mobile: false },
  { name: 'tablet-768x1024', width: 768, height: 1024, mobile: false },
  { name: 'phone-375x812', width: 375, height: 812, mobile: true },
] as const;

const EVIDENCE_DIR = resolve(
  process.env.BOARDS_EVIDENCE_DIR ??
    resolve(__dirname, '../test-results/board-release-candidate/screenshots'),
);

async function seedReleaseBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Релиз-кандидат · проверка интерфейса' },
  });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { id: string }).id;
  const seeded = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: {
      rev: 0,
      state: {
        schemaVersion: 1,
        nodes: [
          {
            id: 'release-prompt',
            type: 'prompt',
            position: { x: 40, y: 80 },
            data: { text: 'Ночной город после дождя' },
          },
          {
            id: 'release-image',
            type: 'generate',
            position: { x: 400, y: 60 },
            data: {
              mode: 'image',
              modelId: 'seedream-5-0-pro',
              prompt: 'Ночной город после дождя',
              imageAspect: '16:9',
              imageQuality: '2K',
              count: 1,
              status: 'idle',
            },
          },
          {
            id: 'release-video',
            type: 'generate',
            position: { x: 780, y: 60 },
            data: {
              mode: 'video',
              modelId: 'seedance-2-0-fast',
              prompt: 'Камера медленно приближается',
              status: 'failed',
              failureMessage: 'Кредиты возвращены. Повторите запуск.',
              failureAction: 'retry',
            },
          },
          {
            id: 'release-note',
            type: 'note',
            position: { x: 400, y: 440 },
            data: { text: 'Проверить ритм и непрерывность движения.' },
          },
        ],
        edges: [
          {
            id: 'release-prompt-edge',
            source: 'release-prompt',
            target: 'release-image',
            sourceHandle: 'text',
            targetHandle: 'prompt',
            type: 'typed',
            animated: true,
          },
        ],
        tray: [],
        viewport: { x: 70, y: 70, zoom: 0.8 },
      },
    },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return id;
}

async function expectInsideViewport(locator: Locator, width: number, height: number) {
  const box = await locator.boundingBox();
  expect(box, `${await locator.getAttribute('data-testid')} should have bounds`).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 1);
  return box!;
}

function boxesOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
) {
  return !(
    first.x + first.width <= second.x + 1 ||
    second.x + second.width <= first.x + 1 ||
    first.y + first.height <= second.y + 1 ||
    second.y + second.height <= first.y + 1
  );
}

async function expectNoDocumentOverflow(page: Page, width: number, height: number) {
  const extent = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  expect(extent.width).toBeLessThanOrEqual(width);
  expect(extent.height).toBeLessThanOrEqual(height);
}

async function expectVisibleKeyboardFocus(page: Page, locator: Locator) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab');
    if (await locator.evaluate((element) => document.activeElement === element)) break;
  }
  await expect(locator).toBeFocused();
  const outline = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);
}

async function expectMinimumTargets(page: Page, root: Locator, minimum = 24) {
  const undersized = await root
    .locator('button:visible, a[href]:visible, input:visible, [role="button"]:visible')
    .evaluateAll(
      (elements, min) =>
        elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label:
                element.getAttribute('aria-label') ||
                element.getAttribute('title') ||
                element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 60) ||
                element.tagName,
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          })
          .filter((target) => target.width < min || target.height < min),
      minimum,
    );
  expect(undersized).toEqual([]);
  expect(page.viewportSize()).not.toBeNull();
}

async function expectNoBlockingAxeViolations(page: Page, selector: string) {
  const axe = await new AxeBuilder({ page }).include(selector).analyze();
  const blocking = axe.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(blocking).toEqual([]);
}

test.describe('Board release-candidate viewport and accessibility gate', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} keeps core chrome fitted, operable, and accessible`, async ({
      signedInPage: page,
      context,
      cookieHeader,
      apiUrl,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const id = await seedReleaseBoard(context.request, apiUrl, cookieHeader);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`/boards/${id}`);

      if (viewport.mobile) {
        const surface = page.getByTestId('mobile-board');
        await expect(surface).toBeVisible({ timeout: 30_000 });
        await expectNoDocumentOverflow(page, viewport.width, viewport.height);

        const header = surface.locator('header');
        const dock = surface.locator('nav');
        await expectInsideViewport(header, viewport.width, viewport.height);
        await expectInsideViewport(dock, viewport.width, viewport.height);
        await expectMinimumTargets(page, surface);
        await expectVisibleKeyboardFocus(page, page.getByLabel('К бордам'));

        await page.getByRole('button', { name: 'Кадры' }).click();
        const sheet = page.getByRole('heading', { name: 'Кадры' }).locator('..').locator('..');
        await expect(sheet).toBeVisible();
        await expectInsideViewport(sheet, viewport.width, viewport.height);
      } else {
        const surface = page.getByTestId('board-canvas');
        await expect(surface).toBeVisible({ timeout: 30_000 });
        await expectNoDocumentOverflow(page, viewport.width, viewport.height);

        const rail = page.getByTestId('rail-tools');
        const toolbar = page.getByTestId('board-add').locator('..');
        const tray = page.getByTestId('montage-tray');
        const railBox = await expectInsideViewport(rail, viewport.width, viewport.height);
        const toolbarBox = await expectInsideViewport(toolbar, viewport.width, viewport.height);
        const trayBox = await expectInsideViewport(tray, viewport.width, viewport.height);
        expect(
          boxesOverlap(railBox, toolbarBox),
          `tool rail and action toolbar overlap: ${JSON.stringify({ railBox, toolbarBox })}`,
        ).toBe(false);
        expect(boxesOverlap(railBox, trayBox), 'tool rail and montage tray overlap').toBe(false);
        expect(boxesOverlap(toolbarBox, trayBox), 'action toolbar and montage tray overlap').toBe(
          false,
        );

        const titleInput = page.getByTestId('board-title');
        await expect(titleInput).toHaveValue('Релиз-кандидат · проверка интерфейса');
        await expectInsideViewport(titleInput.locator('..'), viewport.width, viewport.height);
        if (viewport.width >= 1024) {
          const titleFit = await titleInput.evaluate((element: HTMLInputElement) => {
            const style = getComputedStyle(element);
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            if (!context) return { required: Number.POSITIVE_INFINITY, available: 0 };
            context.font = style.font;
            const padding =
              Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
            return {
              required: context.measureText(element.value).width + padding,
              available: element.clientWidth,
            };
          });
          expect(titleFit.available, JSON.stringify(titleFit)).toBeGreaterThanOrEqual(
            titleFit.required - 1,
          );
        }

        await page.getByTestId('rail-fit').click();
        await page.waitForTimeout(450);
        const nodeBoxes = await page.locator('.react-flow__node').evaluateAll((nodes) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          }),
        );
        expect(nodeBoxes).toHaveLength(4);
        for (const box of nodeBoxes) {
          expect(box.x + box.width).toBeGreaterThan(0);
          expect(box.y + box.height).toBeGreaterThan(0);
          expect(box.x).toBeLessThan(viewport.width);
          expect(box.y).toBeLessThan(viewport.height - trayBox.height);
        }

        const addButton = page.getByTestId('board-add');
        await addButton.hover();
        const tooltip = addButton.locator('span');
        await page.waitForTimeout(250);
        const hoverState = await addButton.evaluate((element) => {
          const tip = element.querySelector('span');
          const rect = element.getBoundingClientRect();
          return {
            hovered: element.matches(':hover'),
            opacity: tip ? Number(getComputedStyle(tip).opacity) : null,
            topElement: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
              ?.tagName,
          };
        });
        expect(hoverState.opacity, JSON.stringify(hoverState)).toBeGreaterThan(0.9);
        await expectVisibleKeyboardFocus(page, addButton);
        await expect
          .poll(() => tooltip.evaluate((element) => Number(getComputedStyle(element).opacity)))
          .toBeGreaterThan(0.9);
        for (const fixedChrome of [
          page.getByTestId('board-title').locator('..'),
          rail,
          toolbar,
          tray,
        ]) {
          await expectMinimumTargets(page, fixedChrome);
        }
      }

      await expectNoBlockingAxeViolations(
        page,
        viewport.mobile ? '[data-testid="mobile-board"]' : '[data-testid="board-canvas"]',
      );
      expect(pageErrors).toEqual([]);

      await mkdir(EVIDENCE_DIR, { recursive: true });
      await page.screenshot({
        path: resolve(EVIDENCE_DIR, `${viewport.name}-${testInfo.project.name}.png`),
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
      });
    });
  }

  test('complex desktop Board has no serious or critical axe debt', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const id = await seedReleaseBoard(context.request, apiUrl, cookieHeader);
    await page.goto(`/boards/${id}`);
    await expect(page.getByTestId('board-canvas')).toBeVisible({ timeout: 30_000 });
    await expectNoBlockingAxeViolations(page, '[data-testid="board-canvas"]');
  });

  test('Board API failures remain traceable by request id and low-cardinality metrics', async ({
    context,
    cookieHeader,
    apiUrl,
  }) => {
    const id = await seedReleaseBoard(context.request, apiUrl, cookieHeader);
    const successRequestId = `boards-observe-ok-${Date.now()}`;
    const success = await context.request.get(`${apiUrl}/v1/boards/${id}`, {
      headers: { cookie: cookieHeader, 'x-request-id': successRequestId },
    });
    expect(success.status()).toBe(200);
    expect(success.headers()['x-request-id']).toBe(successRequestId);

    const failureRequestId = `boards-observe-missing-${Date.now()}`;
    const missing = await context.request.get(`${apiUrl}/v1/boards/missing-board`, {
      headers: { cookie: cookieHeader, 'x-request-id': failureRequestId },
    });
    expect(missing.status()).toBe(404);
    expect(missing.headers()['x-request-id']).toBe(failureRequestId);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const metricsUrl = new URL('/metrics', apiUrl);
    metricsUrl.port = String(Number(metricsUrl.port) + 1);
    const metrics = await context.request.get(metricsUrl.toString());
    expect(metrics.status()).toBe(200);
    const body = await metrics.text();
    expect(body).toContain(
      'seed_http_requests_total{method="GET",route="/v1/boards/:id",status="200"}',
    );
    expect(body).toContain(
      'seed_http_requests_total{method="GET",route="/v1/boards/:id",status="404"}',
    );
  });
});
