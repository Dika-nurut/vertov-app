import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

const NODE_COUNT = 200;
const EDGE_COUNT = 300;
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

// Deliberately wall-clock budgets: they include browser automation, React work,
// and (for save) the real 900 ms debounce plus the local API round trip.
const BUDGETS = {
  openMs: 5_000,
  selectMs: 1_500,
  searchMs: 2_500,
  // Covers the deliberately sampled 12-step pointer gesture as well as the
  // resulting graph update; responsiveness is still capped independently.
  connectMs: 4_000,
  // Includes Playwright polling plus the explicit 300 ms post-fit stability
  // window. The separate 200 ms long-task ceiling remains the responsiveness
  // gate; this wall-clock allowance absorbs normal CI scheduling jitter.
  fitMs: 2_000,
  saveMs: 3_000,
  maxLongTaskMs: 200,
} as const;

interface PhaseMeasurement {
  durationMs: number;
  maxLongTaskMs: number;
  longTaskCount: number;
  observerSupported: boolean;
}

interface BoardPerfStore {
  phase: string;
  startedAt: number;
  entries: { phase: string; duration: number }[];
  observerSupported: boolean;
}

type PerfWindow = Window & { __seedBoardPerf?: BoardPerfStore };

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const created = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { title: 'Board performance 200/300' },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

function position(index: number, kind: 'media' | 'generate') {
  return {
    x: 40 + (index % 10) * 500 + (kind === 'generate' ? 250 : 0),
    y: 80 + Math.floor(index / 10) * 280,
  };
}

function performanceFixture() {
  const nodes: Record<string, unknown>[] = [];

  // Keep the exact 200-node/300-edge budget while reserving two nodes for the
  // organizer layer. This avoids turning the benchmark into an artificial
  // full-canvas crossing-lines worst case while still mounting the production
  // widgets plus a real parent/child frame.
  nodes.push({
    id: 'organizer-frame',
    type: 'frame',
    position: { x: 40, y: 80 },
    width: 520,
    height: 320,
    zIndex: -1,
    data: { title: 'Перфоманс', tint: 'violet' },
  });
  nodes.push({
    id: 'organizer-text',
    type: 'text',
    position: { x: 24, y: 24 },
    parentId: 'organizer-frame',
    extent: 'parent',
    data: { text: 'Организатор', size: 'm' },
  });
  for (let mediaIndex = 0; mediaIndex < 99; mediaIndex += 1) {
    nodes.push({
      id: `m-${mediaIndex}`,
      type: 'media',
      position: position(mediaIndex, 'media'),
      width: 240,
      height: 260,
      data: { url: PIXEL, mediaKind: 'image' },
    });
  }
  for (let generateIndex = 0; generateIndex < 99; generateIndex += 1) {
    nodes.push({
      id: `g-${generateIndex}`,
      type: 'generate',
      position: position(generateIndex, 'generate'),
      width: 240,
      height: 260,
      data: {
        mode: 'image',
        modelId: 'seedream-5-0-pro',
        prompt: '',
        imageAspect: '1:1',
        imageQuality: '2K',
        count: 1,
        status: 'idle',
      },
    });
  }

  const edges: Record<string, unknown>[] = [];
  for (let generateIndex = 0; generateIndex < 99; generateIndex += 1) {
    for (let slot = 0; slot < 3; slot += 1) {
      edges.push({
        id: `e-${generateIndex}-${slot}`,
        source: `m-${(generateIndex + slot) % 99}`,
        target: `g-${generateIndex}`,
        sourceHandle: 'out',
        targetHandle: `images[${slot}]`,
        type: 'typed',
        animated: true,
      });
    }
  }
  for (let slot = 3; slot < 6; slot += 1) {
    edges.push({
      id: `e-extra-${slot}`,
      source: 'm-0',
      target: 'g-0',
      sourceHandle: 'out',
      targetHandle: `images[${slot}]`,
      type: 'typed',
      animated: true,
    });
  }

  expect(nodes).toHaveLength(NODE_COUNT);
  expect(edges).toHaveLength(EDGE_COUNT);
  return {
    schemaVersion: 1,
    nodes,
    edges,
    viewport: { x: 80, y: 60, zoom: 1 },
    tray: [],
  };
}

async function seedPerformanceBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookie: string,
): Promise<string> {
  const id = await newBoard(request, apiUrl, cookie);
  const seeded = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: { state: performanceFixture(), rev: 0 },
  });
  expect(seeded.ok(), await seeded.text()).toBe(true);
  return id;
}

async function installLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    const observerSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const store: BoardPerfStore = {
      phase: 'open',
      startedAt: performance.now(),
      entries: [],
      observerSupported,
    };
    (window as PerfWindow).__seedBoardPerf = store;
    if (!observerSupported) return;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.entries.push({ phase: store.phase, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  });
}

async function beginPhase(page: Page, phase: string) {
  await page.evaluate((nextPhase) => {
    const store = (window as PerfWindow).__seedBoardPerf;
    if (!store) throw new Error('board_perf_observer_missing');
    store.phase = nextPhase;
    store.startedAt = performance.now();
    store.entries = [];
  }, phase);
}

async function endPhase(page: Page): Promise<PhaseMeasurement> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  return page.evaluate(() => {
    const store = (window as PerfWindow).__seedBoardPerf;
    if (!store) throw new Error('board_perf_observer_missing');
    const durations = store.entries.map((entry) => entry.duration);
    return {
      durationMs: performance.now() - store.startedAt,
      maxLongTaskMs: Math.max(0, ...durations),
      longTaskCount: durations.length,
      observerSupported: store.observerSupported,
    };
  });
}

async function measure(
  page: Page,
  phase: string,
  action: () => Promise<unknown>,
): Promise<PhaseMeasurement> {
  await beginPhase(page, phase);
  await action();
  return endPhase(page);
}

async function dragConnection(page: Page) {
  const source = page.locator('.react-flow__node[data-id="m-0"] [data-handleid="out"]');
  const target = page.locator('.react-flow__node[data-id="g-1"] [data-handleid="images[3]"]');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.waitForTimeout(40);
  await page.mouse.up();
}

function assertPhase(
  name: keyof typeof BUDGETS,
  measurement: PhaseMeasurement,
  enforceInteractionLongTask = true,
) {
  expect(measurement.observerSupported, 'Long Tasks API must be available on the CI browser').toBe(
    true,
  );
  expect(measurement.durationMs, `${name} wall-clock budget`).toBeLessThanOrEqual(BUDGETS[name]);
  if (enforceInteractionLongTask) {
    expect(measurement.maxLongTaskMs, `${name} long-task ceiling`).toBeLessThanOrEqual(
      BUDGETS.maxLongTaskMs,
    );
  }
}

async function attachReport(testInfo: TestInfo, report: Record<string, unknown>) {
  await testInfo.attach('board-performance.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });
}

test('200-node/300-edge board stays inside interaction, save, and long-task budgets', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}, testInfo) => {
  const id = await seedPerformanceBoard(context.request, apiUrl, cookieHeader);
  await installLongTaskObserver(page);

  const openWallStarted = Date.now();
  await page.goto(`/boards/${id}`);
  await expect(page.getByTestId('board-canvas')).toHaveAttribute(
    'data-node-count',
    `${NODE_COUNT}`,
    {
      timeout: 30_000,
    },
  );
  await expect(page.getByTestId('board-canvas')).toHaveAttribute(
    'data-edge-count',
    `${EDGE_COUNT}`,
  );
  await expect(page.locator('.react-flow__node[data-id="m-0"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="g-0"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="g-1"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="organizer-frame"]')).toBeVisible();
  await expect(page.locator('.react-flow__node[data-id="organizer-text"]')).toBeVisible();
  const open = await endPhase(page);
  open.durationMs = Date.now() - openWallStarted;

  const select = await measure(page, 'select', async () => {
    await page.locator('.react-flow__node[data-id="g-0"]').click({ position: { x: 120, y: 120 } });
    await expect(page.locator('.react-flow__node[data-id="g-0"]')).toHaveClass(/selected/);
  });

  const search = await measure(page, 'search', async () => {
    await page.getByTestId('board-add').click();
    await page.getByTestId('add-search').fill('upload');
    await expect(page.getByTestId('add-media')).toBeVisible();
    await expect(page.getByTestId('add-note')).toHaveCount(0);
  });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('add-menu')).toHaveCount(0);

  const connectionSave = page.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' && response.url() === `${apiUrl}/v1/boards/${id}`,
  );
  const connect = await measure(page, 'connect', async () => {
    await dragConnection(page);
    await expect(page.getByTestId('board-canvas')).toHaveAttribute(
      'data-edge-count',
      `${EDGE_COUNT + 1}`,
    );
  });
  expect((await connectionSave).ok()).toBe(true);

  const save = await measure(page, 'save', async () => {
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'PUT' && candidate.url() === `${apiUrl}/v1/boards/${id}`,
    );
    await page
      .locator('.react-flow__node[data-id="g-0"]')
      .getByRole('button', { name: 'Больше' })
      .click();
    expect((await response).ok()).toBe(true);
  });

  const beforeFit = await page
    .locator('.react-flow__viewport')
    .evaluate((element) => (element as HTMLElement).style.transform);
  const fit = await measure(page, 'fit', async () => {
    await page.getByTestId('rail-fit').click();
    await expect
      .poll(() =>
        page
          .locator('.react-flow__viewport')
          .evaluate((element) => (element as HTMLElement).style.transform),
      )
      .not.toBe(beforeFit);
    await page.waitForTimeout(300);
  });

  const report = {
    project: testInfo.project.name,
    fixture: { nodes: NODE_COUNT, edges: EDGE_COUNT },
    budgets: BUDGETS,
    measurements: { open, select, search, connect, fit, save },
  };
  await attachReport(testInfo, report);
  console.log(`[board-performance] ${JSON.stringify(report)}`);

  // Opening has its own end-to-end wall-clock budget. The ≤200 ms ceiling is
  // enforced on user interactions after the route has hydrated, matching the
  // BRD-6 acceptance wording while still recording bootstrap long tasks.
  assertPhase('openMs', open, false);
  assertPhase('selectMs', select);
  assertPhase('searchMs', search);
  assertPhase('connectMs', connect);
  assertPhase('fitMs', fit);
  assertPhase('saveMs', save);
});
