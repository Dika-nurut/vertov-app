// Read-only production Scenario audit. Authentication creates a session, but the
// journey never creates/edits/deletes a script and never calls AI.
import fs from 'node:fs';
import path from 'node:path';
import { godLogin } from './_godlogin.mjs';

const WEB = process.env.WEB_PUBLIC_URL ?? 'https://vertov.space';
const OUT = process.env.OUT ?? '/tmp/scenario-prod-audit';
fs.mkdirSync(OUT, { recursive: true });

const log = [];
const net = [];
const { browser, page } = await godLogin({ headless: true, deviceScaleFactor: 2 });
page.on('response', (response) => {
  if (response.status() >= 400)
    net.push(`${response.status()} ${response.request().method()} ${response.url()}`);
});
page.on('console', (message) => {
  if (message.type() === 'error') log.push(`CONSOLE ${message.text().slice(0, 240)}`);
});

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${WEB}/scenario`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('scenario-page').waitFor({ timeout: 20_000 });
  const cards = await page.getByTestId('scenario-card').count();
  log.push(`authenticated list rendered: true`);
  log.push(`existing scenario cards: ${cards}`);
  await page.screenshot({ path: path.join(OUT, '01-list-desktop.png') });

  if (cards > 0) {
    await page.getByTestId('scenario-card').first().click();
    await page.getByTestId('scenario-canvas').waitFor({ timeout: 20_000 });
    await page.keyboard.press('Escape').catch(() => {});
    log.push(`existing canvas rendered: true`);
    log.push(
      `desktop left visible: ${await page
        .getByTestId('scenario-left')
        .isVisible()
        .catch(() => false)}`,
    );
    log.push(
      `desktop rail visible: ${await page
        .getByTestId('scenario-rail')
        .first()
        .isVisible()
        .catch(() => false)}`,
    );
    log.push(
      `canon/scratch control deployed: ${(await page.getByTestId('scenario-note-memory').count()) > 0 || (await page.getByTestId('scenario-file-memory').count()) > 0}`,
    );
    await page.screenshot({ path: path.join(OUT, '02-canvas-desktop.png') });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('scenario-canvas').waitFor({ timeout: 20_000 });
    await page.keyboard.press('Escape').catch(() => {});
    log.push(
      `mobile dock visible: ${await page
        .getByTestId('scenario-mdock')
        .isVisible()
        .catch(() => false)}`,
    );
    await page.screenshot({ path: path.join(OUT, '03-canvas-mobile.png') });
  }

  log.push(`unexpected HTTP >=400: ${JSON.stringify([...new Set(net)])}`);
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(log, null, 2));
  console.log(log.join('\n'));
} catch (error) {
  log.push(`FAIL ${error?.message ?? String(error)}`);
  log.push(`final URL: ${page.url()}`);
  log.push(
    `body: ${(
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 800)}`,
  );
  await page.screenshot({ path: path.join(OUT, '00-failure.png') }).catch(() => {});
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(log, null, 2));
  console.log(log.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
