import { godLogin } from './_godlogin.mjs';

const WEB = process.env.WEB_PUBLIC_URL;
const API = process.env.API_URL;
const { browser, context, page } = await godLogin({ headless: true });
const out = [];
const LAST_SCENE_HEADING = 'ИНТ. ЛОКАЦИЯ 300 — ДЕНЬ';
const SERVER_MARKER = 'СЕРВЕРНАЯ ПРАВКА.';
const LOCAL_MARKER = 'ЛОКАЛЬНАЯ ПРАВКА.';
let scriptId = null;
const expect = (value, message) => {
  if (!value) throw new Error(message);
  out.push(`PASS ${message}`);
};

try {
  const scenes = Array.from(
    { length: 300 },
    (_, i) => `ИНТ. ЛОКАЦИЯ ${i + 1} — ДЕНЬ\n\n= Синопсис ${i + 1}\n\nДействие сцены ${i + 1}.`,
  ).join('\n\n');
  const created = await context.request.post(`${API}/v1/scripts`, {
    data: { title: 'Scenario readiness 300', fountain: scenes },
  });
  expect(created.ok(), '300-scene fixture created');
  const script = await created.json();
  scriptId = script.id;

  const seededId = 'scenario-readiness-retry-note';
  const seededContent = 'Канон для retry.';
  const seed = await context.request.put(`${API}/v1/scripts/${scriptId}`, {
    data: { bible: { notes: [{ id: seededId, content: seededContent, includeInAi: true }] } },
  });
  expect(seed.ok(), 'retry note seeded through the API');

  const started = Date.now();
  await page.goto(`${WEB}/scenario/${scriptId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('scenario-canvas').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  const openMs = Date.now() - started;
  expect(openMs < 5_000, `300-scene open ${openMs}ms < 5000ms`);
  expect(
    (await page.getByTestId('scenario-scene-row').count()) === 300,
    'all 300 scenes navigable',
  );
  await page.getByTestId('scenario-scene-row').last().getByTestId('scenario-scene-jump').click();
  // CodeMirror virtualises its document, so `.cm-scroller.scrollTop` stays 0
  // before and after a successful jump. Assert the rendered viewport instead;
  // this is independent of whether the onboarding dismissal restored focus away
  // from the editor and CodeMirror therefore omitted its cursor element.
  const lastSceneReached = await page.waitForFunction(
    (heading) => {
      const scroller = document.querySelector('[data-testid="scenario-editor"] .cm-scroller');
      if (!scroller) return false;
      const bounds = scroller.getBoundingClientRect();
      return [...scroller.querySelectorAll('.cm-line')].some((line) => {
        const lineBounds = line.getBoundingClientRect();
        const visible = lineBounds.bottom > bounds.top && lineBounds.top < bounds.bottom;
        return visible && line.textContent?.includes(heading);
      });
    },
    LAST_SCENE_HEADING,
    { timeout: 8_000 },
  );
  expect(await lastSceneReached.jsonValue(), 'last scene row moves the editor to the last scene');

  const seededToggle = (request) => {
    if (request.method() !== 'PUT') return false;
    try {
      const body = JSON.parse(request.postData() ?? '{}');
      return (
        body.bible?.notes?.some((note) => note.id === seededId && note.includeInAi === false) &&
        body.fountain === undefined &&
        body.title === undefined
      );
    } catch {
      return false;
    }
  };
  let failedOnce = false;
  let releaseFailedToggle;
  let markFailedToggleHeld;
  const failedToggleHeld = new Promise((resolve) => {
    markFailedToggleHeld = resolve;
  });
  await page.route(`**/v1/scripts/${scriptId}`, async (route) => {
    if (!failedOnce && seededToggle(route.request())) {
      failedOnce = true;
      await new Promise((resolve) => {
        releaseFailedToggle = resolve;
        markFailedToggleHeld();
      });
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"audit"}',
      });
    } else await route.continue();
  });
  const seededRow = page.getByTestId('scenario-note').filter({ hasText: seededContent });
  await seededRow.waitFor();
  await seededRow.getByTestId('scenario-note-memory-menu').click();
  const failedToggle = page.waitForResponse(
    (response) =>
      response.url().includes(`/v1/scripts/${scriptId}`) &&
      response.status() === 503 &&
      seededToggle(response.request()),
    { timeout: 15_000 },
  );
  await seededRow.getByTestId('scenario-note-memory').click();
  await failedToggleHeld;
  await seededRow.getByText('Не учитывается').waitFor();
  expect(
    (await seededRow.getByText('Не учитывается').count()) === 1,
    'note toggle optimistically excludes the note while its request is in flight',
  );
  releaseFailedToggle();
  await failedToggle;
  await page.getByTestId('scenario-mir-save-error').waitFor();
  expect(
    (await seededRow.getByText('Не учитывается').count()) === 0,
    'failed note toggle restores the included UI state',
  );
  await seededRow.getByTestId('scenario-note-memory-menu').click();
  expect(
    (await seededRow.getByTestId('scenario-note-memory').textContent())?.trim() ===
      'Не учитывать в ответах',
    'failed note toggle keeps the reversible exclusion action',
  );
  const failedToggleState = await (
    await context.request.get(`${API}/v1/scripts/${scriptId}`)
  ).json();
  expect(
    failedToggleState.bible.notes.some((note) => note.id === seededId && note.includeInAi === true),
    'failed note toggle leaves the API state included',
  );
  const retriedToggle = page.waitForResponse(
    (response) =>
      response.url().includes(`/v1/scripts/${scriptId}`) &&
      response.ok() &&
      seededToggle(response.request()),
    { timeout: 15_000 },
  );
  await page.getByTestId('scenario-mir-save-retry').click();
  await retriedToggle;
  await page.getByText('Не учитывается').waitFor();
  expect(
    (await seededRow.getByText('Не учитывается').count()) === 1,
    'retry excludes the seeded note in the UI',
  );
  const retriedToggleState = await (
    await context.request.get(`${API}/v1/scripts/${scriptId}`)
  ).json();
  expect(
    retriedToggleState.bible.notes.some(
      (note) => note.id === seededId && note.includeInAi === false,
    ),
    'retry excludes the seeded note in the API',
  );

  await page.getByTestId('scenario-tab-history').click();
  await page.getByTestId('scenario-open-versions').click();
  await page.getByTestId('scenario-versions-sheet').waitFor();
  await page.getByRole('button', { name: 'Создать точку' }).click();
  await page.getByRole('button', { name: 'Восстановить' }).first().waitFor();
  const before = await context.request.get(`${API}/v1/scripts/${scriptId}`);
  const beforeBody = await before.json();
  await context.request.put(`${API}/v1/scripts/${scriptId}`, {
    data: { fountain: `${beforeBody.fountain}\nИЗМЕНЕНО ПОСЛЕ ТОЧКИ.\n`, baseRev: beforeBody.rev },
  });
  await page.getByRole('button', { name: 'Восстановить' }).first().click();
  await page.getByTestId('scenario-versions-sheet').waitFor({ state: 'hidden' });
  const restored = await context.request.get(`${API}/v1/scripts/${scriptId}`);
  expect(
    !(await restored.text()).includes('ИЗМЕНЕНО ПОСЛЕ ТОЧКИ'),
    'browser restore reinstates snapshot',
  );

  const serverNow = await (await context.request.get(`${API}/v1/scripts/${scriptId}`)).json();
  await context.request.put(`${API}/v1/scripts/${scriptId}`, {
    data: { fountain: `${serverNow.fountain}\n${SERVER_MARKER}\n`, baseRev: serverNow.rev },
  });
  const editor = page.locator('[data-testid="scenario-editor"] .cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.insertText(`\n${LOCAL_MARKER}\n`);
  const conflict = page.getByTestId('scenario-conflict');
  await conflict.waitFor({ timeout: 12_000 });
  const localPane = conflict.getByText('Несохранённый текст').locator('xpath=..');
  const serverPane = conflict.getByText('Серверная версия').locator('xpath=..');
  expect(
    (await localPane.locator('pre').textContent())?.includes(LOCAL_MARKER),
    'conflict local pane contains the local marker',
  );
  expect(
    (await serverPane.locator('pre').textContent())?.includes(SERVER_MARKER),
    'conflict server pane contains the server marker',
  );
  expect(
    await page.getByTestId('scenario-conflict-copy-local').isVisible(),
    'conflict exposes explicit recovery',
  );
  await page.getByTestId('scenario-reload').click();
  await conflict.waitFor({ state: 'hidden' });
  const reloadedEditorText = await editor.textContent();
  expect(
    reloadedEditorText?.includes(SERVER_MARKER),
    'reload restores the server text in the editor',
  );
  expect(
    !reloadedEditorText?.includes(LOCAL_MARKER),
    'reload removes the unsaved local text from the editor',
  );

  for (const [width, height] of [
    [375, 812],
    [768, 1024],
    [1024, 768],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('scenario-canvas').waitFor();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    );
    expect(!overflow, `${width}x${height} has no document overflow`);
  }

  console.log(out.join('\n'));
} finally {
  try {
    if (scriptId) {
      const deleted = await context.request.delete(`${API}/v1/scripts/${scriptId}`);
      if (!deleted.ok()) throw new Error(`fixture cleanup HTTP ${deleted.status()}`);
      console.log(`PASS readiness fixture cleaned up ${scriptId}`);
    }
  } finally {
    await browser.close();
  }
}
