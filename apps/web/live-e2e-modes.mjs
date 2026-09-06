import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://109.199.97.163:3000';
const SHOT = '/tmp/seed-shots';
mkdirSync(SHOT, { recursive: true });
const log = (...a) => console.log('•', ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const page = await ctx.newPage();

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

async function runMode({ name, model, kind, edit, pickImage, timeout }) {
  log(`--- ${name} ---`);
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle', timeout: 30000 });
  await selectModel(model);
  if (edit) await page.click('[data-testid="edit-toggle"]');
  if (pickImage) await pickGalleryImage();
  await page.fill('[data-testid="prompt"]', `${name}: cinematic, beautiful, high detail`);
  const sel = kind === 'video' ? '[data-testid="result-video"]' : '[data-testid="result-image"]';
  try {
    // Ensure the form is actually submittable (media present, etc.) before clicking.
    await page.waitForSelector('[data-testid="submit"]:not([disabled])', { timeout: 15000 });
    await page.click('[data-testid="submit"]');
    await page.waitForSelector(sel, { timeout });
    const src = await page.getAttribute(sel, 'src');
    const ok = !!src && src.includes('/seed-assets/');
    log(`${name} RESULT:`, src);
    await page.screenshot({ path: `${SHOT}/mode-${name}.png` });
    results.push({ name, ok, src });
  } catch (e) {
    // capture whatever state (error state etc.)
    await page.screenshot({ path: `${SHOT}/mode-${name}-FAIL.png` });
    const err = await page.textContent('[data-testid="error-state"]').catch(() => null);
    log(`${name} did not render in ${timeout}ms`, err ? `(error-state: ${err.slice(0, 80)})` : '');
    results.push({ name, ok: false, src: null });
  }
}

try {
  log('guest login + god-mode credits');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.click('[data-testid="guest-login"]', { timeout: 15000 });
  await page.waitForURL(/\/(generate)?$|\/generate/, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle');
  const gm = await page.evaluate(async () => {
    const r = await fetch('http://109.199.97.163:4000/v1/dev/godmode', {
      method: 'POST',
      credentials: 'include',
    });
    return r.status;
  });
  log('godmode status', gm);

  // IMAGE MODES (fast)
  await runMode({ name: 'text2img-4.5', model: 'seedream-4-5', kind: 'image', timeout: 90000 });
  await runMode({
    name: 'text2img-5.0lite',
    model: 'seedream-5-0-lite',
    kind: 'image',
    timeout: 90000,
  });
  await runMode({
    name: 'img2img-edit',
    model: 'seedream-4-5',
    kind: 'image',
    edit: true,
    pickImage: true,
    timeout: 90000,
  });

  // VIDEO MODES (fast variants; slower)
  await runMode({
    name: 'text2video-fast',
    model: 'seedance-1-0-pro-fast',
    kind: 'video',
    timeout: 420000,
  });
  await runMode({
    name: 'image2video-fast',
    model: 'seedance-2-0-fast-i2v',
    kind: 'video',
    pickImage: true,
    timeout: 420000,
  });
  await runMode({
    name: 'reference2video-fast',
    model: 'seedance-2-0-fast-r2v',
    kind: 'video',
    pickImage: true,
    timeout: 420000,
  });

  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}`);
  const allOk = results.every((r) => r.ok);
  console.log(allOk ? '\n✅ ALL MODES PASSED' : '\n❌ SOME MODES FAILED');
  await browser.close();
  process.exit(allOk ? 0 : 1);
} catch (err) {
  console.log('FATAL:', err.message);
  await page.screenshot({ path: `${SHOT}/modes-fatal.png` }).catch(() => {});
  await browser.close();
  process.exit(1);
}
