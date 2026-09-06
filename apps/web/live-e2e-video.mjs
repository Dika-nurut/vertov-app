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
const results = [];

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
async function pickGalleryVideo() {
  await page.click('[data-testid="media-picker-video"] [data-testid="pick-video"]');
  const ok = await page
    .waitForSelector('[data-testid="media-picker-video"] [data-testid="gallery-pick"]', {
      timeout: 8000,
    })
    .then(() => true)
    .catch(() => false);
  if (ok) {
    await page.click('[data-testid="media-picker-video"] [data-testid="gallery-pick"]');
    await page.waitForTimeout(300);
  }
}
async function setCheapVideo() {
  await page.click('[data-testid="res-480p"]').catch(() => {});
  await page
    .$eval('[data-testid="duration-range"]', (el) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, '4');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })
    .catch(() => {});
  await page.waitForTimeout(200);
}

async function runMode({ name, model, kind, pickImage, pickVideo, timeout }) {
  log(`--- ${name} ---`);
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle', timeout: 30000 });
  await selectModel(model);
  if (kind === 'video') await setCheapVideo();
  if (pickImage) await pickGalleryImage();
  if (pickVideo) await pickGalleryVideo();
  await page.fill('[data-testid="prompt"]', `${name}: slow cinematic motion`);
  const sel = kind === 'video' ? '[data-testid="result-video"]' : '[data-testid="result-image"]';
  try {
    await page.waitForSelector('[data-testid="submit"]:not([disabled])', { timeout: 15000 });
    await page.click('[data-testid="submit"]');
    const outcome = await Promise.race([
      page.waitForSelector(sel, { timeout }).then(() => 'ok'),
      page.waitForSelector('[data-testid="error-state"]', { timeout }).then(() => 'err'),
    ]);
    if (outcome === 'ok') {
      const src = await page.getAttribute(sel, 'src');
      log(`${name} RESULT:`, src);
      await page.screenshot({ path: `${SHOT}/vmode-${name}.png` });
      results.push({ name, ok: true, src });
    } else {
      const err = await page.textContent('[data-testid="error-state"]').catch(() => '');
      log(`${name} ERROR-STATE: ${(err || '').replace(/\s+/g, ' ').slice(0, 90)}`);
      await page.screenshot({ path: `${SHOT}/vmode-${name}-ERR.png` });
      results.push({ name, ok: false, blocked: /перегруж|провайдер/i.test(err || '') });
    }
  } catch (e) {
    log(`${name} TIMEOUT/${e.message.slice(0, 40)}`);
    await page.screenshot({ path: `${SHOT}/vmode-${name}-FAIL.png` });
    results.push({ name, ok: false });
  }
}

try {
  log('login + god-mode credits');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.click('[data-testid="guest-login"]');
  await page.waitForSelector('[data-testid="prompt"]', { timeout: 30000 });
  await page.evaluate(() =>
    fetch('http://109.199.97.163:4000/v1/dev/godmode', { method: 'POST', credentials: 'include' }),
  );
  await runMode({ name: 'seed-image', model: 'seedream-4-5', kind: 'image', timeout: 90000 });
  await runMode({
    name: 'text2video-FAST',
    model: 'seedance-1-0-pro-fast',
    kind: 'video',
    timeout: 480000,
  });
  await runMode({ name: 'text2video-STD', model: 'seedance-2-0', kind: 'video', timeout: 480000 });
  await runMode({
    name: 'image2video-FAST',
    model: 'seedance-2-0-fast-i2v',
    kind: 'video',
    pickImage: true,
    timeout: 480000,
  });
  await runMode({
    name: 'image2video-STD',
    model: 'seedance-2-0-i2v',
    kind: 'video',
    pickImage: true,
    timeout: 480000,
  });
  await runMode({
    name: 'reference2video-FAST',
    model: 'seedance-2-0-fast-r2v',
    kind: 'video',
    pickImage: true,
    pickVideo: true,
    timeout: 480000,
  });
  await runMode({
    name: 'reference2video-STD',
    model: 'seedance-2-0-r2v',
    kind: 'video',
    pickImage: true,
    pickVideo: true,
    timeout: 480000,
  });

  console.log('\n=== SUMMARY ===');
  for (const r of results)
    console.log(`${r.ok ? '✅' : r.blocked ? '⚠️ BLOCKED(provider)' : '❌'} ${r.name}`);
  await browser.close();
  process.exit(0);
} catch (e) {
  console.log('FATAL', e.message);
  await browser.close();
  process.exit(1);
}
