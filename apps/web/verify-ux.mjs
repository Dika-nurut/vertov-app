import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const API = process.env.API ?? 'http://127.0.0.1:4000';
const SHOT = '/tmp/seed-ux-verify';
mkdirSync(SHOT, { recursive: true });
const log = (...a) => console.log('•', ...a);

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'laptop-1440', width: 1440, height: 768 },
  { name: 'desktop-1512', width: 1512, height: 900 },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});

page.on('response', (r) => {
  if (/sign-in|godmode|\/v1\/me/.test(r.url())) log('resp', r.status(), r.url().slice(0, 70));
});
page.on('requestfailed', (r) => {
  if (/sign-in|godmode/.test(r.url())) log('REQFAIL', r.failure()?.errorText, r.url().slice(0, 70));
});
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30000 });
await page.click('[data-testid="guest-login"]', { timeout: 15000 });
await page.waitForURL(/\/generate/, { timeout: 20000 }).catch(() => log('did not reach /generate'));
await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
const errBanner = await page.evaluate(() => document.body.innerText.match(/не удалось|ошибка|error/i)?.[0] ?? null);
log('logged in as guest at', page.url(), 'errBanner:', errBanner);
// Grant credits (godmode) so the dock is exercised; guest still has plan=null.
const gm = await page.evaluate(async (api) => {
  const r = await fetch(`${api}/v1/dev/godmode`, { method: 'POST', credentials: 'include' });
  return r.status;
}, API);
log('godmode', gm);

const results = {};
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(600);
  // Image mode shot
  await page.screenshot({ path: `${SHOT}/${vp.name}-image.png`, fullPage: false });
  const m = await page.evaluate(() => {
    const submit = document.querySelector('[data-testid="submit"],[data-testid="upsell-cta"]');
    const r = submit?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      submitInView: r ? r.bottom <= window.innerHeight + 1 && r.top >= 0 : null,
      submitBottom: r ? Math.round(r.bottom) : null,
      vh: window.innerHeight,
      defaultModel: document.querySelector('[data-testid="model-trigger"]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60),
    };
  });
  // Type a long prompt to test sticky Run on mobile
  await page.fill('textarea', 'тест '.repeat(60)).catch(() => {});
  await page.waitForTimeout(300);
  const afterPrompt = await page.evaluate(() => {
    const submit = document.querySelector('[data-testid="submit"],[data-testid="upsell-cta"]');
    const r = submit?.getBoundingClientRect();
    return { submitInView: r ? r.bottom <= window.innerHeight + 1 && r.top >= -1 : null, submitBottom: r ? Math.round(r.bottom) : null };
  });
  await page.screenshot({ path: `${SHOT}/${vp.name}-image-longprompt.png` });
  // Switch to video to check default model + locked/upsell + helper text
  await page.click('[data-testid="mode-video"]').catch(() => {});
  await page.waitForTimeout(500);
  const videoState = await page.evaluate(() => ({
    defaultModel: document.querySelector('[data-testid="model-trigger"]')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60),
    hasUpsell: !!document.querySelector('[data-testid="upsell-cta"]'),
    minHelper: !!Array.from(document.querySelectorAll('p')).find((p) => /Минимум 4 секунды/.test(p.textContent || '')),
  }));
  await page.screenshot({ path: `${SHOT}/${vp.name}-video.png` });
  results[vp.name] = { ...m, afterPrompt, videoState };
}

// Focus ring check (desktop): tab to first control, read outline.
await page.setViewportSize({ width: 1512, height: 900 });
await page.goto(`${BASE}/generate`, { waitUntil: 'networkidle' });
await page.keyboard.press('Tab');
await page.keyboard.press('Tab');
const focus = await page.evaluate(() => {
  const el = document.activeElement;
  const s = el ? getComputedStyle(el) : null;
  return { tag: el?.tagName, outlineWidth: s?.outlineWidth, outlineColor: s?.outlineColor, outlineStyle: s?.outlineStyle };
});
await page.screenshot({ path: `${SHOT}/focus.png` });

console.log('\n=== RESULTS ===');
console.log(JSON.stringify(results, null, 2));
console.log('=== FOCUS (after 2x Tab) ===');
console.log(JSON.stringify(focus));
console.log('=== CONSOLE ERRORS ===', consoleErrors.length);
consoleErrors.forEach((e) => console.log('  ', e));
await browser.close();
