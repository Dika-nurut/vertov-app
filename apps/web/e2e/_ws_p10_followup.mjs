// Phase 1.0 follow-ups: the one true intersection (scenario canvas without a
// retired onboarding overlay), real-mobile-UA desk behaviour, and the layout
// shift the project pill causes.
import { chromium, devices } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB = process.env.WEB;
const STATE = process.env.STATE;
const IDS = JSON.parse(readFileSync(process.env.IDS, 'utf8')).ids;
const OUT = resolve('../../docs/evidence/workspace-remediation/1.0');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const out = {};

// --- 1. scenario canvas without the retired onboarding overlay --------------
{
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/scenario/${IDS.script}?projectId=${IDS.pid}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(3000);
  await page.waitForTimeout(1500);
  out.scenarioCanvasNoOnboarding = await page.evaluate(() => {
    const pill = document.querySelector('[data-testid="project-context-valid"]');
    const header = document.querySelector('[data-testid="scenario-back"]')?.closest('header');
    const a = pill.getBoundingClientRect();
    const b = header.getBoundingClientRect();
    const x1 = Math.max(a.x, b.x),
      y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.right, b.right),
      y2 = Math.min(a.bottom, b.bottom);
    const has = x2 > x1 && y2 > y1;
    const cx = (x1 + x2) / 2,
      cy = (y1 + y2) / 2;
    const hit = has ? document.elementFromPoint(cx, cy) : null;
    return {
      pillRect: { x: a.x, y: a.y, w: a.width, h: a.height },
      headerRect: { x: b.x, y: b.y, w: b.width, h: b.height },
      intersect: has ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1, cx, cy } : false,
      topAtIntersection: hit
        ? pill.contains(hit)
          ? 'PILL'
          : header.contains(hit)
            ? 'CHROME'
            : 'OTHER:' + hit.tagName.toLowerCase()
        : null,
      overlayStillPresent: Boolean(document.querySelector('[data-testid="scenario-onboarding"]')),
    };
  });
  await page.screenshot({
    path: `${OUT}/scenario-canvas__valid__1280__no-onboarding.png`,
    clip: { x: 0, y: 0, width: 1000, height: 200 },
  });
  await ctx.close();
}

// --- 2. the desk under a REAL mobile user agent ----------------------------
{
  const ctx = await browser.newContext({
    ...devices['iPhone 13'],
    storageState: STATE,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/workspace/${IDS.pid}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  out.deskMobileUA = {
    finalUrl: page.url().replace(WEB, ''),
    ua: await page.evaluate(() => navigator.userAgent),
    docScrollWidth: await page.evaluate(() => document.documentElement.scrollWidth),
    innerWidth: await page.evaluate(() => window.innerWidth),
  };
  await page.screenshot({ path: `${OUT}/workspace-desk__valid__375-mobile-ua__full.png` });
  await ctx.close();
}

// --- 3. layout shift caused by the pill mounting/unmounting ---------------
for (const [label, url] of [
  ['standalone', `/generate`],
  ['valid', `/generate?projectId=${IDS.pid}`],
]) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__shifts.push({ value: e.value, t: e.startTime });
    }).observe({ type: 'layout-shift', buffered: true });
    window.__marks = [];
    const tick = () => {
      const p = document.querySelector(
        '[data-testid="project-context-valid"],[data-testid="project-context-loading"],[data-testid="project-context-invalid"]',
      );
      const brand = document.querySelector('header nav a[href="/"]');
      window.__marks.push({
        t: Math.round(performance.now()),
        pill: p
          ? p.getAttribute('data-testid') + '@' + Math.round(p.getBoundingClientRect().height)
          : null,
        brandY: brand ? Math.round(brand.getBoundingClientRect().y) : null,
      });
      if (performance.now() < 6000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto(`${WEB}${url}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6500);
  const marks = await page.evaluate(() => window.__marks);
  // Collapse to transitions only.
  const trail = [];
  for (const m of marks) {
    const last = trail[trail.length - 1];
    if (!last || last.pill !== m.pill || last.brandY !== m.brandY) trail.push(m);
  }
  out[`shift_${label}`] = {
    cls: (await page.evaluate(() => window.__shifts)).reduce((a, b) => a + b.value, 0),
    trail,
  };
  await ctx.close();
}

await browser.close();
writeFileSync(`${OUT}/_followup.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
