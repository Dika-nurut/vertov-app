// Verify the scenario mobile drawer: dock → Сцены/Мир/Редактор + desktop-unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { godLogin } from './_godlogin.mjs';

const WEB = process.env.WEB_PUBLIC_URL ?? 'http://127.0.0.1:3209';
const API = process.env.API_URL ?? 'http://127.0.0.1:4310';
const outdir = process.argv[2];
let sid = process.argv[3];
fs.mkdirSync(outdir, { recursive: true });
const log = [];
const { browser, context, page } = await godLogin({ headless: true, deviceScaleFactor: 2 });

if (sid === 'NEW') {
  const fountain = [
    'Название: Кинобудка',
    'Автор: Пример Вертова',
    '',
    'ИНТ. КИНОБУДКА - НОЧЬ',
    '',
    'Тесная будка киномеханика. Гудит старый проектор. МАРК (40) заправляет плёнку не глядя.',
    '',
    'МАРК',
    'Плёнка не врёт. Люди врут.',
    '',
    'Луч проектора дрожит. За стеклом — пустой зал.',
    '',
    'НАТ. КРЫША - НОЧЬ',
    '',
    'Ветер гонит старые афиши по крыше.',
    '',
    'ИНТ. ФОЙЕ КИНОТЕАТРА - УТРО',
    '',
    'Пусто. Только свет из окошка кассы.',
  ].join('\n');
  const r = await context.request.post(`${API}/v1/scripts`, {
    headers: { 'content-type': 'application/json' },
    data: { title: 'Кинобудка', fountain },
  });
  const b = await r.json();
  sid = b.id ?? b.script?.id;
  log.push('created script: ' + sid + ' (http ' + r.status() + ')');
}
const seeded = await context.request.put(`${API}/v1/scripts/${sid}`, {
  headers: { 'content-type': 'application/json' },
  data: {
    bible: {
      notes: [
        { id: 'audit-existing-note', content: 'Маяк виден только ночью.', includeInAi: true },
      ],
    },
  },
});
if (!seeded.ok()) throw new Error(`could not seed existing note (http ${seeded.status()})`);
const net = [];
page.on('response', (r) => {
  if (r.status() >= 400) net.push(`${r.status()} ${r.url().replace(WEB, '')}`.slice(0, 140));
});
page.on('console', (m) => {
  if (m.type() === 'error') log.push('CON-ERR ' + m.text().slice(0, 180));
});
const shot = (n) => page.screenshot({ path: path.join(outdir, n) }).catch(() => {});

await page.setViewportSize({ width: 375, height: 812 });
await page.goto(`${WEB}/scenario/${sid}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
// dismiss onboarding if present
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(600);

const dock = await page
  .locator('[data-testid="scenario-mdock"]')
  .isVisible()
  .catch(() => false);
log.push('mobile dock visible: ' + dock);
await shot('m1.base.png');

// Сцены
await page
  .locator('[data-testid="scenario-mtab-scenes"]')
  .click()
  .catch((e) => log.push('scenes tap ' + e));
await page.waitForTimeout(600);
log.push(
  'scenes sheet has Soderjanie: ' +
    (await page
      .locator('[data-testid="scenario-soderjanie"]')
      .last()
      .isVisible()
      .catch(() => false)),
);
await shot('m2.scenes.png');
await page
  .locator('[data-testid="scenario-msheet"] >> text=✕')
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(400);

// Мир
await page
  .locator('[data-testid="scenario-mtab-mir"]')
  .click()
  .catch((e) => log.push('mir tap ' + e));
await page.waitForTimeout(600);
log.push(
  'mir sheet has MirProekta: ' +
    (await page
      .locator('[data-testid="scenario-mir"]')
      .last()
      .isVisible()
      .catch(() => false)),
);
for (const testid of [
  'scenario-mir-write',
  'scenario-note-input',
  'scenario-note-save',
  'scenario-suggestion',
  'scenario-rule-nudge',
]) {
  const count = await page.locator(`[data-testid="${testid}"]`).count();
  if (count !== 0) throw new Error(`${testid} must be absent, found ${count}`);
  log.push(`${testid} absent: true`);
}

const existingNote = page
  .locator('[data-testid="scenario-msheet"]')
  .locator('[data-testid="scenario-note"]')
  .filter({ hasText: 'Маяк виден только ночью.' });
await existingNote.waitFor({ timeout: 5000 });
log.push('seeded existing note renders: true');

const dockCount = await page.locator('[data-testid="scenario-mtab-mir"] span').textContent();
const panelCount = await page.locator('[data-testid="scenario-mir-count"]').last().textContent();
if (dockCount !== panelCount) {
  throw new Error(`dock and panel canon counts differ: ${dockCount} !== ${panelCount}`);
}
log.push(`dock and panel canon counts match: ${dockCount}`);

await existingNote.locator('[data-testid="scenario-note-memory-menu"]').click();
await existingNote.locator('[data-testid="scenario-note-memory"]').click();
await existingNote.getByText('Не учитывается', { exact: true }).waitFor({ timeout: 5000 });
log.push('existing note toggle works: true');
await existingNote.locator('[data-testid="scenario-note-remove"]').click();
await existingNote.waitFor({ state: 'detached', timeout: 5000 });
log.push('existing note delete works: true');
await shot('m3.mir.png');
await page
  .locator('[data-testid="scenario-msheet"] >> text=✕')
  .first()
  .click()
  .catch(() => {});
await page.waitForTimeout(400);

// Редактор (full-screen AI)
await page
  .locator('[data-testid="scenario-mtab-editor"]')
  .click()
  .catch((e) => log.push('editor tap ' + e));
await page.waitForTimeout(700);
log.push(
  'editor overlay has RightRail: ' +
    (await page
      .locator('[data-testid="scenario-meditor"] [data-testid="scenario-rail"]')
      .isVisible()
      .catch(() => false)),
);
log.push(
  'editor overlay has chat input: ' +
    (await page
      .locator('[data-testid="scenario-meditor"] [data-testid="scenario-chat-input"]')
      .isVisible()
      .catch(() => false)),
);
await shot('m4.editor.png');
await page
  .locator('[data-testid="scenario-meditor-close"]')
  .click()
  .catch(() => {});
await page.waitForTimeout(400);
log.push(
  'editor closed, back to base: ' +
    (await page
      .locator('[data-testid="scenario-mdock"]')
      .isVisible()
      .catch(() => false)),
);

// TABLET portrait — the compact dock/sheets remain the navigation model at 768.
await page.setViewportSize({ width: 768, height: 1024 });
await page.goto(`${WEB}/scenario/${sid}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page.keyboard.press('Escape').catch(() => {});
log.push(
  'TABLET dock visible: ' +
    (await page
      .locator('[data-testid="scenario-mdock"]')
      .isVisible()
      .catch(() => false)),
);
await page.locator('[data-testid="scenario-mtab-scenes"]').click();
await page.waitForTimeout(400);
log.push(
  'TABLET scenes sheet visible: ' +
    (await page
      .locator('[data-testid="scenario-msheet"] [data-testid="scenario-soderjanie"]')
      .isVisible()
      .catch(() => false)),
);
await shot('m5.tablet.png');

// DESKTOP unchanged — dock must be gone, side panels visible
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${WEB}/scenario/${sid}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.keyboard.press('Escape').catch(() => {});
await page.waitForTimeout(400);
log.push(
  'DESKTOP dock hidden: ' +
    !(await page
      .locator('[data-testid="scenario-mdock"]')
      .isVisible()
      .catch(() => false)),
);
log.push(
  'DESKTOP left panel visible: ' +
    (await page
      .locator('[data-testid="scenario-left"]')
      .isVisible()
      .catch(() => false)),
);
log.push(
  'DESKTOP right rail visible: ' +
    (await page
      .locator('[data-testid="scenario-rail"]')
      .first()
      .isVisible()
      .catch(() => false)),
);
await shot('m6.desktop.png');

// Two-tab conflict: mutate the server after this page loaded, then type locally.
const current = await context.request.get(`${API}/v1/scripts/${sid}`);
const serverScript = await current.json();
await context.request.put(`${API}/v1/scripts/${sid}`, {
  headers: { 'content-type': 'application/json' },
  data: { fountain: `${serverScript.fountain}\nСЕРВЕРНАЯ ПРАВКА.\n`, baseRev: serverScript.rev },
});
const editor = page.locator('[data-testid="scenario-editor"] .cm-content');
await editor.click();
await page.keyboard.press('ControlOrMeta+End');
await page.keyboard.insertText('\nЛОКАЛЬНАЯ ПРАВКА.\n');
await page.locator('[data-testid="scenario-conflict"]').waitFor({ timeout: 12_000 });
log.push(
  'conflict shows local version: ' +
    (await page
      .getByText('Несохранённый текст')
      .isVisible()
      .catch(() => false)),
);
log.push(
  'conflict shows server version: ' +
    (await page
      .getByText('Серверная версия')
      .isVisible()
      .catch(() => false)),
);
log.push(
  'conflict offers explicit recovery: ' +
    (await page
      .locator('[data-testid="scenario-conflict-copy-local"]')
      .isVisible()
      .catch(() => false)),
);
await shot('m7.conflict.png');

log.push('NET>=400: ' + JSON.stringify([...new Set(net)]));
fs.writeFileSync(path.join(outdir, 'result.json'), JSON.stringify(log, null, 2));
console.log(log.join('\n'));
await browser.close();
