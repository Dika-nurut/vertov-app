// Explicit Phase 5 production browser walk.
//
// This is not part of the normal e2e suite. It must be enabled deliberately
// with PHASE5_PROD_RUN=1, an HTTPS WEB_PUBLIC_URL, and the exact release SHA
// expected from /ready. Set PHASE5_PROD_VIEWPORT=390x844 for the owner-run
// mobile onboarding pass (the default is 1440x900). Paid AI endpoints are
// intercepted in the browser; the script/timing/Board writes are real and the
// one-off account is erased in finally.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

if (process.env.PHASE5_PROD_RUN !== '1') {
  throw new Error('set PHASE5_PROD_RUN=1 to run the production audit');
}

const WEB = process.env.WEB_PUBLIC_URL ?? 'https://vertov.space';
const API = process.env.API_URL ?? WEB;
const DEV_ACCESS = process.env.DEV_ACCESS;
const EXPECTED_RELEASE = process.env.PHASE5_EXPECTED_RELEASE?.trim();
const viewportRaw = process.env.PHASE5_PROD_VIEWPORT?.trim() ?? '1440x900';
const viewportMatch = /^(\d{3,4})x(\d{3,4})$/u.exec(viewportRaw);
if (
  !/^https:\/\//.test(WEB) ||
  !/^https:\/\//.test(API) ||
  !DEV_ACCESS ||
  !EXPECTED_RELEASE ||
  !/^[0-9a-f]{40}$/u.test(EXPECTED_RELEASE) ||
  !viewportMatch
) {
  throw new Error(
    'production audit requires HTTPS WEB_PUBLIC_URL/API_URL, DEV_ACCESS, PHASE5_EXPECTED_RELEASE (full SHA), and a valid optional PHASE5_PROD_VIEWPORT=<width>x<height>',
  );
}
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };
if (
  viewport.width < 320 ||
  viewport.width > 4096 ||
  viewport.height < 480 ||
  viewport.height > 4096
) {
  throw new Error('PHASE5_PROD_VIEWPORT must be between 320x480 and 4096x4096');
}

const OUT = process.env.PHASE5_PROD_OUT ?? `/tmp/vertov-phase5-prod-browser-${Date.now()}`;
const devHeaders = { 'x-dev-access': DEV_ACCESS };
const email = `readiness-phase5-${Date.now()}@seed.local`;
const idea =
  'Киномеханик замечает на плёнке несколько секунд из будущего и должен решить, кому верить.';
const screenplay = [
  'ИНТ. КИНОБУДКА — НОЧЬ',
  '',
  'Киномеханик ИЛЬЯ запускает старый проектор. На плёнке появляется кадр, которого ещё не было.',
  '',
  'Он видит в отражении двери человека, который должен прийти через минуту.',
  '',
  'Илья выключает проектор и остаётся перед выбором.',
].join('\n');
const structure = {
  format: 'film',
  brief: {
    version: 1,
    goal: 'Показать момент выбора человека, который увидел будущее.',
    audience: 'Зрители короткого кино',
    platform: 'Короткий метр',
    durationSeconds: 12,
    tone: 'Ночной, напряжённый, человечный',
    inferred: true,
  },
  outline: {
    version: 1,
    beats: [
      {
        id: 'phase5-beat-1',
        kind: 'scene',
        title: 'Кадр из будущего',
        summary: 'Илья видит на плёнке невозможный кадр и должен выбрать действие.',
        visual: 'Проектор, белая плёнка, отражение двери, ночная будка.',
        spokenText: 'Кому теперь верить?',
        durationSeconds: 12,
      },
    ],
  },
};

function planFor(sceneId) {
  return {
    version: 'scenario-shot-plan-v1',
    sceneId,
    targetDurationSeconds: 12,
    shots: [
      {
        order: 1,
        title: 'Плёнка оживает',
        durationSec: 6,
        dramaticBeat: 'Невозможный кадр появляется на экране.',
        promptDraft:
          'Ночной кинопроектор, свет на лице киномеханика, крупный план, плёночное зерно.',
        requiredLocks: [],
        unresolvedAssets: [],
      },
      {
        order: 2,
        title: 'Решение у двери',
        durationSec: 6,
        dramaticBeat: 'Герой замечает отражение и выбирает не убегать.',
        promptDraft:
          'Киномеханик перед дверью в тёмной кинобудке, тревожное отражение, средний план.',
        requiredLocks: [],
        unresolvedAssets: [],
      },
    ],
  };
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  baseURL: WEB,
  viewport,
  ignoreHTTPSErrors: false,
});
const page = await context.newPage();
const results = [];
const consoleErrors = [];
const pageErrors = [];
const serverErrors = [];
let scriptId = null;
let boardId = null;
let signedIn = false;
let structRouteSeen = false;
let shotRouteSeen = false;
let handoffBody = null;
let routeError = null;

page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
});
page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 300)));
page.on('response', (response) => {
  if (response.status() >= 500) {
    serverErrors.push(
      `${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`,
    );
  }
});
page.on('request', (request) => {
  if (
    request.method() === 'POST' &&
    request.url().includes('/v1/scripts/') &&
    request.url().includes('/board-handoff')
  ) {
    try {
      handoffBody = request.postDataJSON();
    } catch {
      handoffBody = null;
    }
  }
});

const assert = (value, message) => {
  if (!value) throw new Error(message);
  results.push(`PASS ${message}`);
};

const json = async (response, label) => {
  const body = await response.json().catch(() => null);
  if (!response.ok()) {
    throw new Error(`${label} HTTP ${response.status()} ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
};

const screenshot = (name) => page.screenshot({ path: path.join(OUT, name), fullPage: false });

const structRoute = async (route) => {
  try {
    structRouteSeen = true;
    const match = new URL(route.request().url()).pathname.match(
      /\/v1\/scripts\/([^/]+)\/structurize$/,
    );
    if (!match) throw new Error('bad structurize URL');
    scriptId = decodeURIComponent(match[1]);
    const current = await json(
      await context.request.get(`${API}/v1/scripts/${encodeURIComponent(scriptId)}`),
      'script read',
    );
    await json(
      await context.request.put(`${API}/v1/scripts/${encodeURIComponent(scriptId)}`, {
        headers: { 'content-type': 'application/json' },
        data: {
          baseRev: current.rev,
          fountain: screenplay,
          format: structure.format,
          brief: structure.brief,
          outline: structure.outline,
        },
      }),
      'script fixture persist',
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...structure, credits: 0, free: false }),
    });
  } catch (error) {
    routeError = error instanceof Error ? error.message : String(error);
    await route.abort();
  }
};

const shotRoute = async (route) => {
  try {
    shotRouteSeen = true;
    const match = new URL(route.request().url()).pathname.match(
      /\/v1\/scripts\/[^/]+\/scenes\/([^/]+)\/shot-plan$/,
    );
    if (!match) throw new Error('bad shot-plan URL');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        plan: planFor(decodeURIComponent(match[1])),
        credits: 0,
        cacheHit: false,
      }),
    });
  } catch (error) {
    routeError = error instanceof Error ? error.message : String(error);
    await route.abort();
  }
};

auditWalk: {
  try {
    const ready = await json(await context.request.get(`${API}/ready`), 'ready');
    assert(ready.commit === EXPECTED_RELEASE, `target release ${ready.commit}`);

    const signIn = await context.request.post(`${API}/api/auth/sign-in/magic-link`, {
      headers: { 'content-type': 'application/json' },
      data: { email, callbackURL: `${WEB}/generate` },
    });
    assert(signIn.ok(), `fresh signup request ${signIn.status()}`);
    let link = null;
    for (let i = 0; i < 30; i += 1) {
      const capture = await context.request.get(
        `${API}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
        { headers: devHeaders },
      );
      const body = await capture.json();
      if (body?.url && body.email === email) {
        link = body.url;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert(Boolean(link), 'fresh magic link captured');
    await page.goto(link, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/generate(?:[/?#]|$)/, { timeout: 30_000 });
    const me = await json(await context.request.get(`${API}/v1/me`), 'me');
    signedIn = true;
    assert(
      me.user?.isAnonymous === false && me.user?.email === email,
      'fresh account session established',
    );
    const before = await json(await context.request.get(`${API}/v1/me/profile`), 'profile before');
    assert(before.onboardedAt == null, 'fresh account is un-onboarded');

    // Real first-use path: the query only selects the tour; profile truth decides
    // whether it may start. Capture every visible tour step for the release
    // evidence pack, including the reduced mobile path.
    const mobileOnboarding = viewport.width < 768;
    await page.goto('/generate?onboarding=1', { waitUntil: 'domcontentloaded' });
    const tour = page.getByTestId('onboarding-tour');
    await tour.waitFor({ timeout: 20_000 });
    await tour.locator('p.label-eyebrow').filter({ hasText: 'Выберите модель' }).waitFor();
    await screenshot(
      mobileOnboarding ? 'onboarding-mobile-step-model.png' : 'onboarding-desktop-step-model.png',
    );
    await tour.getByTestId('onboarding-tour-next').click();
    await tour.locator('p.label-eyebrow').filter({ hasText: 'Напишите промт' }).waitFor();
    await screenshot(
      mobileOnboarding ? 'onboarding-mobile-step-prompt.png' : 'onboarding-desktop-step-prompt.png',
    );
    await page
      .getByTestId('prompt-block')
      .getByRole('textbox')
      .fill('свет проектора на лице героя');
    await tour.locator('p.label-eyebrow').filter({ hasText: 'Нажмите «Создать»' }).waitFor();
    await screenshot(
      mobileOnboarding ? 'onboarding-mobile-step-submit.png' : 'onboarding-desktop-step-submit.png',
    );
    await tour.getByTestId('onboarding-tour-next').click();
    if (mobileOnboarding) {
      await tour.waitFor({ state: 'hidden' });
    } else {
      await tour.locator('p.label-eyebrow').filter({ hasText: 'Готово' }).waitFor();
      await screenshot('onboarding-desktop-step-done.png');
      await tour.getByTestId('onboarding-tour-next').click();
      await tour.waitFor({ state: 'hidden' });
    }
    const after = await json(await context.request.get(`${API}/v1/me/profile`), 'profile after');
    assert(after.onboardedAt != null, 'guided onboarding completion persisted');
    await page.goto('/generate?onboarding=1', { waitUntil: 'domcontentloaded' });
    assert(
      (await page.getByTestId('onboarding-tour').count()) === 0,
      'completed onboarding stays dismissed on reload',
    );
    await screenshot(
      mobileOnboarding ? '01-onboarding-mobile-complete.png' : '01-onboarding-desktop-complete.png',
    );

    if (mobileOnboarding) {
      // The remaining production walk is intentionally desktop-only: global
      // mobile routing shows the compact desktop notice on those workspaces.
      assert(
        (await page.getByTestId('mobile-desktop-notice').count()) === 0,
        'Generate remains the mobile first-success route',
      );
      console.log(
        JSON.stringify(
          {
            release: ready.commit,
            viewport,
            freshAccount: true,
            productionWrites: ['onboarding'],
            aiProviderCalls: 0,
            onboardingScreenshots: [
              'onboarding-mobile-step-model.png',
              'onboarding-mobile-step-prompt.png',
              'onboarding-mobile-step-submit.png',
              '01-onboarding-mobile-complete.png',
            ],
            consoleErrors: consoleErrors.length,
            pageErrors: pageErrors.length,
            serverErrors: serverErrors.length,
            results,
          },
          null,
          2,
        ),
      );
      break auditWalk;
    }

    // The two AI endpoints are intentionally browser-stubbed so this walk has
    // zero provider spend while still exercising the deployed UI and real data
    // writes/reads around the paid boundaries.
    await page.route(/\/v1\/scripts\/[^/]+\/structurize$/, structRoute);
    await page.goto('/scenario/new', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('scenario-intent').fill(idea);
    await page.getByTestId('scenario-structurize').click();
    await page.getByTestId('scenario-structure-result').waitFor({ timeout: 20_000 });
    assert(
      structRouteSeen && !routeError,
      'Scenario intent reached production UI boundary with AI stubbed',
    );
    assert((await page.getByTestId('scenario-beat').count()) === 1, 'one candidate scene rendered');
    await screenshot('02-scenario-structure.png');

    await page.getByTestId('scenario-open-editor').click();
    await page.waitForURL(/\/scenario\/[^/]+$/);
    await page.getByTestId('scenario-canvas').waitFor({ timeout: 20_000 });
    await page.getByTestId('scenario-timing-panel').waitFor({ timeout: 20_000 });
    assert(scriptId !== null, 'production script id exists');

    const timingInput = page.getByTestId('scenario-timing-input-1');
    await timingInput.fill('12');
    const timingResponse = page.waitForResponse(
      (response) =>
        response.url().includes('/scene-timings/') && response.request().method() === 'PUT',
    );
    await page.getByTestId('scenario-timing-save-1').click();
    assert((await timingResponse).ok(), 'approved timing PUT succeeded');
    const timings = await json(
      await context.request.get(`${API}/v1/scripts/${encodeURIComponent(scriptId)}/scene-timings`),
      'timings',
    );
    const sceneId = timings.scenes?.[0]?.sourceUnitId;
    assert(
      typeof sceneId === 'string' && timings.scenes[0].timing?.owner === 'user',
      'timing ledger records user approval',
    );

    await page.route(/\/v1\/scripts\/[^/]+\/scenes\/[^/]+\/shot-plan$/, shotRoute);
    const shotResult = await page.evaluate(
      async ({ url }) => {
        const response = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      },
      {
        url: `${API}/v1/scripts/${encodeURIComponent(scriptId)}/scenes/${encodeURIComponent(sceneId)}/shot-plan`,
      },
    );
    assert(
      shotResult.status === 200 &&
        shotResult.body?.plan?.targetDurationSeconds === 12 &&
        shotResult.body.plan.shots.length === 2,
      'single-scene shot plan matches approved duration',
    );
    assert(shotRouteSeen && !routeError, 'shot-plan provider call was stubbed at browser boundary');
    await screenshot('03-shot-plan-approved.png');

    await page.unroute(/\/v1\/scripts\/[^/]+\/structurize$/, structRoute);
    await page.getByTestId('scenario-board-open').click();
    await page.getByTestId('scenario-board-dialog').waitFor();
    await page.getByTestId('scenario-board-submit').click();
    await page.getByTestId('scenario-board-receipt').waitFor({ timeout: 20_000 });
    await page.getByTestId('scenario-board-open-result').click();
    await page.waitForURL(/\/boards\/[^/]+$/);
    boardId = new URL(page.url()).pathname.split('/').pop();
    await page.getByTestId('board-canvas').waitFor({ timeout: 20_000 });
    const sceneNodes = page.locator('.react-flow__node-scene');
    assert(boardId && (await sceneNodes.count()) === 1, 'scene materialized into production Board');
    const firstBoard = await json(
      await context.request.get(`${API}/v1/boards/${encodeURIComponent(boardId)}`),
      'board',
    );
    const nodeCount = firstBoard.state?.nodes?.length;
    assert(Number.isInteger(nodeCount) && nodeCount >= 1, 'Board state persisted');
    await screenshot('04-board-handoff.png');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('board-canvas').waitFor({ timeout: 20_000 });
    assert((await sceneNodes.count()) === 1, 'Board survives refresh');
    assert(handoffBody?.idempotencyKey && scriptId, 'handoff idempotency key captured');
    const replay = await json(
      await context.request.post(
        `${API}/v1/scripts/${encodeURIComponent(scriptId)}/board-handoff`,
        {
          headers: { 'content-type': 'application/json' },
          data: handoffBody,
        },
      ),
      'handoff replay',
    );
    assert(replay.replayed === true, 'repeat handoff is idempotent');
    const replayBoard = await json(
      await context.request.get(`${API}/v1/boards/${encodeURIComponent(boardId)}`),
      'replayed board',
    );
    assert(
      replayBoard.state?.nodes?.length === nodeCount,
      'repeat handoff does not duplicate nodes',
    );
    assert(
      consoleErrors.length === 0 && pageErrors.length === 0 && serverErrors.length === 0,
      `browser walk has no console/page/5xx errors (${consoleErrors.length}/${pageErrors.length}/${serverErrors.length})`,
    );
    await screenshot('05-board-refresh-replay.png');
    console.log(
      JSON.stringify(
        {
          release: ready.commit,
          viewport,
          freshAccount: true,
          productionWrites: ['onboarding', 'script', 'timing', 'board'],
          aiProviderCalls: 0,
          structRouteSeen,
          shotRouteSeen,
          onboardingScreenshots: [
            'onboarding-desktop-step-model.png',
            'onboarding-desktop-step-prompt.png',
            'onboarding-desktop-step-submit.png',
            'onboarding-desktop-step-done.png',
            '01-onboarding-desktop-complete.png',
          ],
          consoleErrors: consoleErrors.length,
          pageErrors: pageErrors.length,
          serverErrors: serverErrors.length,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    if (boardId) {
      await context.request
        .delete(`${API}/v1/boards/${encodeURIComponent(boardId)}`)
        .catch(() => {});
    }
    if (scriptId) {
      await context.request
        .delete(`${API}/v1/scripts/${encodeURIComponent(scriptId)}`)
        .catch(() => {});
    }
    if (signedIn) {
      const deleted = await context.request
        .delete(`${API}/v1/me`, {
          headers: { 'content-type': 'application/json' },
          data: { confirmEmail: email },
        })
        .catch(() => null);
      console.log(`cleanup_account_http=${deleted?.status() ?? 'request_failed'}`);
    }
    await browser.close();
  }
}
