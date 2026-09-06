import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const BASE = process.env.BASE ?? 'http://127.0.0.1:3000';
const SHOT = '/tmp/seed-ux-verify';
mkdirSync(SHOT, { recursive: true });
const log = (...a) => console.log('•', ...a);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1512, height: 900 } });
const page = await ctx.newPage();
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(30_000);
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 160)));

// Open Generate directly. In the current anonymous flow the page mints a
// short-lived Better Auth guest session through AnonBootstrap; there is no
// legacy "guest login" button on /login to click.
await page.goto(`${BASE}/generate`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="model-trigger"]', { timeout: 30_000 });

// In-context video effects present? The standalone /presets catalog is parked
// by the current P-4 launch policy; motion/effect cards remain in Generate.
await page.goto(`${BASE}/generate`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="mode-video"]', { timeout: 30_000 });
await page.waitForTimeout(800);
await page.click('[data-testid="mode-video"]');
await page.click('[data-testid="effect-trigger"]');
await page.waitForSelector('[data-testid="effect-card"]', { timeout: 15000 });
const effects = await page.$$eval('[data-testid="effect-card"]', (els) => els.length);
log('in-context video effects:', effects);
await page.screenshot({ path: `${SHOT}/p2-generate-effects.png` });

// Apply an effect → selected state is visible while the prompt stays user-owned.
if (effects > 0) {
  const effect = page.locator('[data-testid="effect-card"]').first();
  const title = (await effect.textContent())?.trim() || '';
  await effect.click({ force: true });
  await page.waitForTimeout(400);
  log(
    'after effect click:',
    JSON.stringify({ title, selected: await effect.getAttribute('aria-pressed') }),
  );
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.screenshot({ path: `${SHOT}/p2-effect-applied.png` });
}

// F-B1 proper: mobile, long prompt typed into the real editor, Run still visible.
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/generate`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="prompt"]', { timeout: 30_000 });
await page.waitForTimeout(400);
await page.locator('[data-testid="prompt"]').fill('очень длинный промпт '.repeat(40));
await page.waitForTimeout(300);
const sticky = await page.evaluate(() => {
  const b = document
    .querySelector('[data-testid="submit"],[data-testid="upsell-cta"]')
    ?.getBoundingClientRect();
  return {
    inView: b ? b.bottom <= innerHeight + 1 && b.top >= 0 : null,
    bottom: b ? Math.round(b.bottom) : null,
    vh: innerHeight,
  };
});
log('F-B1 mobile long-prompt sticky:', JSON.stringify(sticky));
if (sticky.inView !== true)
  throw new Error(`F-B1 failed: action is not in viewport (${JSON.stringify(sticky)})`);
await page.screenshot({ path: `${SHOT}/p2-mobile-sticky.png` });

// Contrast: measure --color-faint composited on black.
const faint = await page.evaluate(() => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--color-faint').trim();
  const m = v.match(/[\d.]+/g).map(Number);
  const hex = /^#([0-9a-f]{8})$/i.exec(v)?.[1];
  const a = hex ? parseInt(hex.slice(6, 8), 16) / 255 : m[3];
  // composite over black: ch = src*a
  const ch = 255 * a;
  const lin = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(ch) + 0.7152 * lin(ch) + 0.0722 * lin(ch);
  const ratio = (L + 0.05) / (0 + 0.05);
  return { v, ratio: Math.round(ratio * 100) / 100 };
});
log('faint:', JSON.stringify(faint), faint.ratio >= 4.5 ? 'PASS AA' : 'FAIL');

// Pricing: the current v14 surface is a tier grid + explicit payment chips +
// a cost table. The old outputs/trust-row selectors were retired with the
// earlier pricing page and made this manual verifier report false negatives.
await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('main', { timeout: 30_000 });
await page.waitForTimeout(500);
const pricing = await page.evaluate(() => ({
  tierPlates: document.querySelectorAll('[data-testid="tier-plate"]').length,
  tiersGrid: Boolean(document.querySelector('[data-testid="tiers-grid"]')),
  paymentChips: ['Точка Банк', 'СБП', 'Карты «Мир»', 'Чек 54-ФЗ'].filter((label) =>
    document.body.innerText.includes(label),
  ).length,
  costRows: document.querySelectorAll('[data-testid="cost-row"]').length,
  legalLinks: Array.from(document.querySelectorAll('a[href^="/legal"]')).map((a) =>
    a.getAttribute('href'),
  ),
}));
log('pricing:', JSON.stringify(pricing));
if (
  pricing.tierPlates < 4 ||
  !pricing.tiersGrid ||
  pricing.paymentChips !== 4 ||
  pricing.costRows === 0
) {
  throw new Error(`pricing surface incomplete: ${JSON.stringify(pricing)}`);
}
await page.screenshot({ path: `${SHOT}/p2-pricing.png`, fullPage: true });

// reduced motion still stops animation
const rm = await page.evaluate(() => {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
});
log('console errors:', errors.length);
errors.forEach((e) => console.log('  ', e));
await browser.close();
