#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '../apps/web/node_modules/@playwright/test/index.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg) => arg.replace(/^--/, '').split('='))
    .filter((parts) => parts.length === 2),
);

const variant = args.variant;
const baseUrl = args.web ?? process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3000';
const apiUrl = args.api ?? process.env.API_URL ?? 'http://127.0.0.1:4000';
const source = args.source ?? 'unknown';
const outputRoot = resolve(
  args.output ?? 'docs/evidence/boards-ux/2026-07-10',
  variant ?? 'unknown',
);

if (variant !== 'baseline' && variant !== 'current') {
  throw new Error('Pass --variant=baseline or --variant=current.');
}

await mkdir(outputRoot, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: baseUrl,
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

const email = `boards-ux-${variant}-${Date.now()}@seed.local`;
const signIn = await context.request.post(`${apiUrl}/api/auth/sign-in/magic-link`, {
  headers: { 'content-type': 'application/json' },
  data: { email, callbackURL: `${baseUrl}/boards` },
});
if (!signIn.ok()) {
  throw new Error(`Magic-link request failed with HTTP ${signIn.status()}.`);
}

let magicUrl;
for (let attempt = 0; attempt < 30; attempt += 1) {
  const response = await context.request.get(
    `${apiUrl}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
  );
  const body = await response.json();
  if (body?.email === email && body?.url) {
    magicUrl = body.url;
    break;
  }
  await new Promise((done) => setTimeout(done, 300));
}
if (!magicUrl) throw new Error('The development magic link was not captured.');

await page.goto(magicUrl, { waitUntil: 'domcontentloaded', timeout: 300_000 });
await page.waitForURL(/\/boards\/[^/?]+(?:\?.*)?$/, { timeout: 300_000 });
await page.locator('.react-flow__pane').waitFor({ state: 'visible', timeout: 300_000 });

const boardId = new URL(page.url()).pathname.split('/').pop();
if (!boardId) throw new Error(`Could not read board id from ${page.url()}.`);

const cookieHeader = (await context.cookies())
  .filter((cookie) => !/[\s;,]/.test(cookie.value))
  .map((cookie) => `${cookie.name}=${cookie.value}`)
  .join('; ');

async function putState(state) {
  // Leave the hydrated board before replacing its state. Otherwise a pending
  // client autosave can race the fixture PUT and restore the previous graph.
  if (page.url().startsWith(`${baseUrl}/boards/`)) {
    await page.goto('about:blank');
  }
  const current = await context.request.get(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader },
  });
  if (!current.ok()) throw new Error(`Board read failed with HTTP ${current.status()}.`);
  const currentBody = await current.json();
  const rev = Number.isSafeInteger(currentBody.state?.__rev) ? currentBody.state.__rev : 0;
  const response = await context.request.put(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { state, rev },
  });
  if (!response.ok()) throw new Error(`Board update failed with HTTP ${response.status()}.`);
}

async function settle() {
  await page.addStyleTag({
    content:
      '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;caret-color:transparent!important}',
  });
  await page.waitForTimeout(350);
}

async function reloadDesktop() {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/boards/${boardId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 300_000,
  });
  await page.locator('.react-flow__pane').waitFor({ state: 'visible', timeout: 300_000 });
  await settle();
}

async function screenshot(name) {
  await settle();
  await page.screenshot({ path: join(outputRoot, name), fullPage: true });
}

const observations = {
  variant,
  source,
  web: baseUrl,
  api: apiUrl,
  viewport: '1440x900',
  zeroSpend: true,
  pageErrors,
};

// Empty canvas and the first-node path.
await screenshot('01-empty-board-desktop.png');
observations.emptyNodeCount = await page.locator('.react-flow__node').count();
observations.emptyGuideVisible = (await page.getByTestId('board-empty-guide').count()) > 0;
await page.getByTestId('board-add').click();
observations.addSearchFocused = await page
  .getByTestId('add-search')
  .evaluate((element) => element === document.activeElement);
await page.getByTestId('add-generate').click();
await page.locator('.react-flow__node-generate').waitFor({ state: 'visible' });
observations.firstNodeModel = (await page.getByTestId('node-model-trigger').innerText()).trim();
observations.firstNodeCost = (await page.getByTestId('node-cost').innerText()).trim();
await screenshot('02-first-generation-node.png');

// Drop a prompt wire on empty canvas: the menu must suggest only legal source types.
const promptHandle = page.locator('.react-flow__node-generate [data-handleid="prompt"]');
const promptBox = await promptHandle.boundingBox();
if (!promptBox) throw new Error('Prompt input handle has no bounding box.');
await page.mouse.move(promptBox.x + promptBox.width / 2, promptBox.y + promptBox.height / 2);
await page.mouse.down();
await page.mouse.move(promptBox.x - 12, promptBox.y + 10);
await page.mouse.move(promptBox.x - 230, promptBox.y + 220, { steps: 12 });
await page.mouse.up();
await page.getByTestId('connect-menu').waitFor({ state: 'visible' });
observations.connectSuggestions = await page
  .getByTestId('connect-menu')
  .locator('button[data-testid^="connect-add-"]')
  .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('data-testid')));
await screenshot('03-legal-connect-suggestions.png');
await page.getByTestId('connect-add-prompt').click();
await page.getByTestId('node-prompt-text').fill('Ночной город после дождя, отражения в асфальте');
await page.waitForTimeout(900);
observations.legalEdgeCount = await page.locator('.react-flow__edge').count();
observations.legalRunDisabled = await page.getByTestId('node-run').isDisabled();
const promptNodeBounds = await page.locator('.react-flow__node-prompt').boundingBox();
observations.promptNodeBounds = promptNodeBounds;
observations.promptNodeAboveControls = Boolean(
  promptNodeBounds && promptNodeBounds.y + promptNodeBounds.height <= 900 - 130 + 1,
);
await screenshot('04-first-legal-workflow.png');

// Existing shortcut sheet verifies that keyboard commands remain discoverable.
await page.locator('.react-flow__pane').click({ position: { x: 40, y: 420 } });
await page.keyboard.press('Shift+/');
observations.shortcutSheetOpened = await page.getByTestId('shortcuts-sheet').isVisible();
await page.keyboard.press('Escape');
observations.shortcutSheetClosedWithEscape =
  (await page.getByTestId('shortcuts-sheet').count()) === 0;

const pixel =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const invalidState = {
  nodes: [
    {
      id: 'cast-1',
      type: 'cast',
      position: { x: 80, y: 220 },
      data: { castKind: 'character', name: 'Алиса', imageUrls: [pixel] },
    },
    {
      id: 'generate-1',
      type: 'generate',
      position: { x: 560, y: 180 },
      data: {
        mode: 'video',
        modelId: 'seedance-2-0-fast',
        prompt: 'Алиса входит в кадр',
        status: 'idle',
      },
    },
  ],
  edges: [
    {
      id: 'incompatible-cast-edge',
      source: 'cast-1',
      target: 'generate-1',
      sourceHandle: 'out',
      targetHandle: 'images[0]',
      type: 'typed',
      animated: true,
    },
  ],
  viewport: { x: 80, y: 60, zoom: 1 },
};
await putState(invalidState);
await reloadDesktop();
observations.incompatibleEdgeRendered = (await page.locator('.react-flow__edge').count()) === 1;
observations.incompatibleRunDisabled = await page.getByTestId('node-run').isDisabled();
observations.incompatibleReason =
  (await page.getByTestId('node-invalid-reason').count()) > 0
    ? (await page.getByTestId('node-invalid-reason').innerText()).trim()
    : null;
await screenshot('05-incompatible-saved-edge.png');

if (variant === 'current') {
  const modelImpactState = {
    ...invalidState,
    nodes: [
      invalidState.nodes[0],
      {
        ...invalidState.nodes[1],
        data: {
          ...invalidState.nodes[1].data,
          modelId: 'seedance-2-0-fast-reference-to-video',
        },
      },
    ],
  };
  await putState(modelImpactState);
  await reloadDesktop();
  await page.getByTestId('node-model-trigger').click();
  await page.getByTestId('node-model-seedance-2-0-fast').click();
  await page.getByTestId('model-change-dialog').waitFor({ state: 'visible' });
  observations.modelImpactText = (await page.getByTestId('model-change-dialog').innerText())
    .replace(/\s+/g, ' ')
    .trim();
  observations.edgePreservedBeforeConfirmation =
    (await page.locator('.react-flow__edge').count()) === 1;
  await screenshot('06-model-change-impact.png');
  await page.getByTestId('model-change-cancel').click();

  const states = {
    nodes: [
      {
        id: 'idle-node',
        type: 'generate',
        position: { x: 40, y: 180 },
        data: {
          mode: 'image',
          modelId: 'flux-2-pro',
          prompt: 'ожидание',
          status: 'idle',
        },
      },
      {
        id: 'loading-node',
        type: 'generate',
        position: { x: 430, y: 180 },
        data: {
          mode: 'image',
          modelId: 'flux-2-pro',
          prompt: 'в процессе',
          status: 'running',
        },
      },
      {
        id: 'failed-node',
        type: 'generate',
        position: { x: 820, y: 180 },
        data: {
          mode: 'image',
          modelId: 'flux-2-pro',
          prompt: 'ошибка',
          status: 'failed',
        },
      },
    ],
    edges: [],
    viewport: { x: 80, y: 60, zoom: 0.9 },
  };
  await putState(states);
  await reloadDesktop();
  observations.loadingSpinnerCount = await page.locator('.seed-spin').count();
  observations.failedRecoveryCopy = await page
    .getByText('Не получилось — попробуйте ещё раз.')
    .count();
  await screenshot('07-empty-loading-error-states.png');
}

// Phones are intentionally a review/handoff boundary in this sprint.
await page.setViewportSize({ width: 375, height: 812 });
await page.reload({ waitUntil: 'domcontentloaded', timeout: 300_000 });
if (variant === 'baseline') {
  await page.getByText('Доска — на компьютере').waitFor({ state: 'visible', timeout: 60_000 });
  observations.mobileDesktopBoundaryVisible = true;
} else {
  await page.getByTestId('mobile-board').waitFor({ state: 'visible', timeout: 60_000 });
  observations.mobileReviewNodeCount = await page.locator('.react-flow__node').count();
  await page.getByRole('button', { name: 'Кадры' }).click();
  await page.getByRole('heading', { name: 'Кадры' }).waitFor({ state: 'visible' });
  observations.mobileShotListVisible = true;
}
await screenshot('08-mobile-review-boundary.png');

await writeFile(
  join(outputRoot, 'observations.json'),
  `${JSON.stringify(observations, null, 2)}\n`,
  'utf8',
);

await browser.close();
console.log(JSON.stringify(observations, null, 2));
