// Full /scenario happy path against the floor stack with a MOCKED gateway
// (OPENROUTER_URL → mock-openrouter.mjs; zero live spend):
//   intent → structurize → type → autosave → select → ask (streamed) → apply → export.
// Exit 0 + "E2E_OK" on success. Driven by scenario-floor.sh.
import { godLogin } from './_godlogin.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const REWRITE = process.env.MOCK_REWRITE ?? 'ПЕРЕПИСАНО ассистентом.';
const API = process.env.API_URL ?? 'http://127.0.0.1:4310';
const SAMPLE = ['ИНТ. КИНОБУДКА - НОЧЬ', '', 'Тесная будка киномеханика.', ''].join('\n');
const UNTOUCHED_SAMPLE_LINE = 'Тесная будка киномеханика.';

const { browser, context, page } = await godLogin({ headless: true });
const log = (...a) => console.log('•', ...a);
const evidenceDir = resolve(process.cwd(), '../../docs/evidence/scenario-intent-first');
await mkdir(evidenceDir, { recursive: true });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
let createdScriptId = null;
const fail = async (msg) => {
  console.error('E2E_FAIL', msg);
  await page.screenshot({ path: '/tmp/scenario-e2e-fail.png' }).catch(() => {});
  throw new Error(msg);
};

try {
  const priorList = await context.request.get(`${API}/v1/scripts?limit=100`);
  if (!priorList.ok()) await fail(`script-list preflight HTTP ${priorList.status()}`);
  const priorScripts = await priorList.json();
  const priorIds = new Set((priorScripts.items ?? []).map((script) => script.id));

  const tiers = await context.request.get(`${API}/v1/assist/tiers`);
  if (!tiers.ok()) await fail(`assist-tier preflight HTTP ${tiers.status()}`);
  const economy = (await tiers.json()).items?.find((tier) => tier.id === 'economy');
  if (!economy?.isActive) await fail('economy assist tier is disabled');
  log('economy assist tier active');

  await page.goto('/scenario', { waitUntil: 'domcontentloaded' });
  const beforeUntouched = await context.request.get(`${API}/v1/scripts?limit=100`);
  const beforeUntouchedIds = new Set(
    (await beforeUntouched.json()).items.map((script) => script.id),
  );
  await page.getByTestId('scenario-create').click();
  await page.getByTestId('scenario-new-page').waitFor({ timeout: 20_000 });
  const afterUntouched = await context.request.get(`${API}/v1/scripts?limit=100`);
  const afterUntouchedIds = new Set((await afterUntouched.json()).items.map((script) => script.id));
  if (
    beforeUntouchedIds.size !== afterUntouchedIds.size ||
    [...beforeUntouchedIds].some((id) => !afterUntouchedIds.has(id))
  ) {
    await fail('untouched Scenario list click created a ghost script row');
  }
  await page.screenshot({ path: resolve(evidenceDir, '01-intent-first-start.png') });
  await page
    .getByTestId('scenario-intent')
    .fill('Короткая сцена о киномеханике, который видит будущее на плёнке.');
  await page.getByTestId('scenario-structurize').click();
  await page.getByTestId('scenario-structure-result').waitFor({ timeout: 60_000 });
  await page.getByTestId('scenario-beats-preview').waitFor();

  const createdList = await context.request.get(`${API}/v1/scripts?limit=100`);
  const createdRows = await createdList.json();
  createdScriptId = (createdRows.items ?? [])
    .map((script) => script.id)
    .find((id) => !priorIds.has(id));
  if (!createdScriptId) await fail('intent flow did not create a new script');
  log('created from intent', createdScriptId);
  const scriptId = createdScriptId;

  await page.getByTestId('scenario-open-editor').click();
  await page.waitForURL(new RegExp(`/scenario/${createdScriptId}$`), { timeout: 30_000 });
  await page.getByTestId('scenario-canvas').waitFor({ timeout: 20_000 });
  await page.getByTestId('scenario-structure-panel').waitFor();
  await page.screenshot({ path: resolve(evidenceDir, '02-structure-in-editor.png') });
  log('structurize result persisted as the editable project structure');

  // type + wait for the autosave PUT to actually land (rev 1 → 2)
  const content = page.locator('[data-testid="scenario-editor"] .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+A');
  const saved = page.waitForResponse(
    (r) => {
      if (
        !r.url().includes(`/v1/scripts/${scriptId}`) ||
        r.request().method() !== 'PUT' ||
        !r.ok()
      ) {
        return false;
      }
      try {
        return JSON.parse(r.request().postData() ?? '{}').fountain?.includes(SAMPLE) === true;
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );
  await page.keyboard.insertText(SAMPLE);
  await saved;
  log('typed + autosaved');

  // select the first line (scene heading) → quote docks into the composer
  await content.click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.press('Shift+End');
  await page.getByTestId('scenario-quote-chip').waitFor({ timeout: 8_000 });
  log('selection quote docked in composer');

  // ask (anchored, one feed) → streams via the mock gateway → note card
  await page.getByTestId('scenario-tier').selectOption('economy');
  await page.getByTestId('scenario-chat-input').fill('Сделай ударом, а не тезисом.');
  await page.getByTestId('scenario-chat-send').click();
  await page.getByTestId('scenario-apply').waitFor({ timeout: 30_000 });
  log('proposal streamed + card rendered');

  // apply → local undoable edit + server apply
  await page.getByTestId('scenario-apply').click();
  await page.waitForTimeout(1500);

  // export reflects the applied rewrite (real API + mock gateway end-to-end)
  const res = await context.request.get(`${API}/v1/scripts/${scriptId}/export?format=fountain`);
  if (!res.ok()) await fail(`export HTTP ${res.status()}`);
  const text = await res.text();
  if (!text.includes(REWRITE)) {
    await fail(`export missing the applied rewrite; got:\n${text.slice(0, 400)}`);
  }
  if (!text.includes(UNTOUCHED_SAMPLE_LINE)) {
    await fail(`export missing untouched sample line; got:\n${text.slice(0, 400)}`);
  }
  if (consoleErrors.length > 0) {
    await fail(`browser console errors: ${consoleErrors.join(' | ')}`);
  }
  log('export contains the applied rewrite');

  console.log('E2E_OK');
} catch (err) {
  console.error('E2E_FAIL', err?.message ?? String(err));
  await page.screenshot({ path: '/tmp/scenario-e2e-fail.png' }).catch(() => {});
  throw err;
} finally {
  try {
    if (createdScriptId) {
      const deleted = await context.request.delete(`${API}/v1/scripts/${createdScriptId}`);
      if (!deleted.ok()) throw new Error(`fixture cleanup HTTP ${deleted.status()}`);
      log('cleaned up', createdScriptId);
    }
  } finally {
    await browser.close();
  }
}
