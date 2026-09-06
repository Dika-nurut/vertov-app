import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = 'http://109.199.97.163:3000';
const SHOT = '/tmp/seed-shots';
mkdirSync(SHOT, { recursive: true });
const log = (...a) => console.log('•', ...a);
const browser = await chromium.launch();
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 1000 } })
).newPage();
async function selectModel(id) {
  await page.click('[data-testid="model-trigger"]');
  await page.click(`[data-model-id="${id}"]`, { timeout: 8000 });
  await page.waitForTimeout(400);
}
async function pickGalleryImage() {
  await page.click('[data-testid="pick-image"]');
  await page.waitForSelector('[data-testid="gallery-pick"]', { timeout: 10000 });
  await page.click('[data-testid="gallery-pick"]');
  await page.waitForTimeout(300);
}
async function setCheap() {
  await page.click('[data-testid="res-480p"]').catch(() => {});
  await page
    .$eval('[data-testid="duration-range"]', (el) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, '4');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })
    .catch(() => {});
  await page.waitForTimeout(200);
}
try {
  log('login');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="guest-login"]');
  await page.waitForSelector('[data-testid="prompt"]', { timeout: 30000 });
  await page.evaluate(() =>
    fetch('http://109.199.97.163:4000/v1/dev/godmode', { method: 'POST', credentials: 'include' }),
  );
  // seed one image for the reference picker (cheap)
  log('seed image');
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle' });
  await page.fill('[data-testid="prompt"]', 'a vintage camera on a wooden desk');
  await page.click('[data-testid="submit"]');
  await page.waitForSelector('[data-testid="result-image"]', { timeout: 90000 });
  log('seed image done');
  // reference-to-video STANDARD
  log('reference2video-STD');
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle' });
  await selectModel('seedance-2-0-r2v');
  await setCheap();
  await pickGalleryImage();
  await page.fill(
    '[data-testid="prompt"]',
    'use image 1 as style reference, slow cinematic push-in',
  );
  await page.waitForSelector('[data-testid="submit"]:not([disabled])', { timeout: 15000 });
  await page.click('[data-testid="submit"]');
  const out = await Promise.race([
    page.waitForSelector('[data-testid="result-video"]', { timeout: 480000 }).then(() => 'ok'),
    page.waitForSelector('[data-testid="error-state"]', { timeout: 480000 }).then(() => 'err'),
  ]);
  if (out === 'ok') {
    const src = await page.getAttribute('[data-testid="result-video"]', 'src');
    log('reference2video-STD RESULT:', src);
    await page.screenshot({ path: `${SHOT}/vmode-reference2video-STD.png` });
    console.log('\n✅ reference-to-video STANDARD verified in browser');
  } else {
    const e = await page.textContent('[data-testid="error-state"]').catch(() => '');
    log('reference2video-STD ERROR:', (e || '').replace(/\s+/g, ' ').slice(0, 90));
    await page.screenshot({ path: `${SHOT}/vmode-reference2video-STD-ERR.png` });
    console.log('\n❌ blocked');
  }
  await browser.close();
} catch (e) {
  console.log('FATAL', e.message);
  await browser.close();
  process.exit(1);
}
