import { chromium } from '@playwright/test';

const BASE = 'http://109.199.97.163:3000';
const SHOT = '/tmp/seed-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(SHOT, { recursive: true });

const log = (...a) => console.log('•', ...a);
let failed = false;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [browser error]', m.text().slice(0, 160));
});

try {
  // 1) Login page
  log('goto /login');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.screenshot({ path: `${SHOT}/01-login.png` });

  // 2) Guest login
  log('click guest login «Начать бесплатно»');
  await page.click('[data-testid="guest-login"]', { timeout: 15000 });
  await page.waitForURL(/\/(generate)?$|\/generate/, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 });
  log('landed on', page.url());
  await page.screenshot({ path: `${SHOT}/02-after-login.png` });

  // 3) Go to generate, grant credits via API in-page (god-mode) so video is testable too
  log('grant credits via god-mode');
  const gm = await page.evaluate(async () => {
    const r = await fetch('http://109.199.97.163:4000/v1/dev/godmode', {
      method: 'POST',
      credentials: 'include',
    });
    return { ok: r.ok, status: r.status };
  });
  log('godmode:', JSON.stringify(gm));

  // 4) Generate a real image
  log('goto /generate');
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill(
    '[data-testid="prompt"]',
    'A cosy Moscow courtyard in golden autumn light, cinematic',
  );
  await page.screenshot({ path: `${SHOT}/03-generate-filled.png` });
  log('submit generation');
  await page.click('[data-testid="submit"]');
  // wait for the real result image (Evolink ~10-25s)
  await page.waitForSelector('[data-testid="result-image"]', { timeout: 90000 });
  const imgSrc = await page.getAttribute('[data-testid="result-image"]', 'src');
  log('RESULT IMAGE:', imgSrc);
  await page.screenshot({ path: `${SHOT}/04-image-result.png` });
  if (!imgSrc || !imgSrc.includes('/seed-assets/'))
    throw new Error('no real asset url on result image');

  // 5) Open the studio editor
  log('goto /studio');
  await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-testid="timeline"]', { timeout: 15000 });
  const hasExport = await page.isVisible('[data-testid="export-btn"]');
  log('studio timeline + export button visible:', hasExport);
  await page.screenshot({ path: `${SHOT}/05-studio.png` });

  console.log('\n✅ LIVE BROWSER E2E PASSED');
} catch (err) {
  failed = true;
  console.log('\n❌ LIVE E2E FAILED:', err.message);
  await page.screenshot({ path: `${SHOT}/zz-failure.png` }).catch(() => {});
} finally {
  await browser.close();
  process.exit(failed ? 1 : 0);
}
