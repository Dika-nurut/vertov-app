// Phase 1.0 runtime repro — /workspace project-chrome evidence capture.
// Read-only: creates fixture rows through the real API, never spends credits.
// Run from apps/web with a dev-stack storageState:
//   WEB=… API=… STATE=… node e2e/_ws_p10_capture.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WEB = process.env.WEB;
const API = process.env.API;
const STATE = process.env.STATE;
const OUT = resolve(process.env.OUT ?? '../../docs/evidence/workspace-remediation/1.0');
mkdirSync(OUT, { recursive: true });

const state = JSON.parse(readFileSync(STATE, 'utf8'));
const cookieHeader = state.cookies
  .filter((c) => !/[\s;,]/.test(c.value))
  .map((c) => `${c.name}=${c.value}`)
  .join('; ');

async function api(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return json;
}

// ---------------------------------------------------------------- fixtures
const stamp = Date.now();
const project = await api('/v1/projects', 'POST', { title: `P10 Ночное кафе ${stamp}` });
const other = await api('/v1/projects', 'POST', { title: `P10 Чужой проект ${stamp}` });
const script = await api('/v1/scripts', 'POST', { projectId: project.id, title: 'P10 сценарий' });
const board = await api('/v1/boards', 'POST', { projectId: project.id, title: 'P10 борд' });
const otherBoard = await api('/v1/boards', 'POST', { projectId: other.id, title: 'P10 чужая' });
const studio = await api('/v1/studio/projects', 'POST', {
  projectId: project.id,
  title: 'P10 монтаж',
});
console.log(
  JSON.stringify(
    {
      project: project.id,
      other: other.id,
      script: script.id,
      board: board.id,
      otherBoard: otherBoard.id,
      studio: studio.id,
    },
    null,
    2,
  ),
);

const MISSING = 'p10-nonexistent-project';

// Chrome-element resolvers, evaluated in-page. Each returns the app's own
// top-left chrome element or null.
const CHROME = {
  appshell: `document.querySelector('header nav a[href="/"]')`,
  desk: `document.querySelector('[data-testid="desk-exit"]')`,
  boards: `(document.querySelector('[data-testid="board-title"]')?.closest('div.absolute') ?? null)`,
  scenario: `(document.querySelector('[data-testid="scenario-back"]')?.closest('header') ?? null)`,
  none: `null`,
};

const MEASURE = (chromeExpr) => `(() => {
  const pillSel = '[data-testid="project-context-valid"],[data-testid="project-context-loading"],[data-testid="project-context-invalid"]';
  const pill = document.querySelector(pillSel);
  const chrome = ${chromeExpr};
  const desc = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || null,
      text: (el.textContent || '').trim().slice(0, 42),
      position: cs.position, top: cs.top, left: cs.left, zIndex: cs.zIndex,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      rect: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      // resolved stacking: walk up to the nearest ancestor that creates one
      stackingParent: (() => {
        let n = el.parentElement, chain = [];
        while (n && n !== document.documentElement) {
          const c = getComputedStyle(n);
          const creates = (c.position !== 'static' && c.zIndex !== 'auto')
            || c.opacity !== '1' || c.transform !== 'none' || c.filter !== 'none'
            || c.isolation === 'isolate' || c.mixBlendMode !== 'normal'
            || c.willChange.includes('transform') || c.contain.includes('paint');
          if (creates) chain.push(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.split(/\\s+/).slice(0,2).join('.') : '') + ' z=' + c.zIndex + ' pos=' + c.position);
          n = n.parentElement;
        }
        return chain.slice(0, 3);
      })(),
      bodyChildIndex: (() => {
        let n = el;
        while (n && n.parentElement !== document.body) n = n.parentElement;
        return n ? Array.from(document.body.children).indexOf(n) : -1;
      })(),
      isDirectBodyChild: el.parentElement === document.body,
    };
  };
  const p = desc(pill), c = desc(chrome);
  let intersect = null, topAt = null, pillTopAtOwnCentre = null;
  if (p && c) {
    const a = p.rect, b = c.rect;
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 > x1 && y2 > y1) {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      const hit = document.elementFromPoint(cx, cy);
      intersect = { x: +x1.toFixed(1), y: +y1.toFixed(1), w: +(x2-x1).toFixed(1), h: +(y2-y1).toFixed(1), cx: +cx.toFixed(1), cy: +cy.toFixed(1) };
      topAt = hit
        ? (pill.contains(hit) ? 'PILL' : (chrome.contains(hit) ? 'CHROME' : 'OTHER:' + hit.tagName.toLowerCase() + '.' + (typeof hit.className === 'string' ? hit.className.split(/\\s+/).slice(0,3).join('.') : '')))
        : 'NONE';
    } else {
      intersect = false;
    }
  }
  if (p) {
    const cx = p.rect.x + p.rect.w / 2, cy = p.rect.y + p.rect.h / 2;
    const hit = document.elementFromPoint(cx, cy);
    pillTopAtOwnCentre = hit
      ? (pill.contains(hit) ? 'PILL' : hit.tagName.toLowerCase() + '.' + (typeof hit.className === 'string' ? hit.className.split(/\\s+/).slice(0,3).join('.') : ''))
      : 'NONE';
  }
  return {
    pill: p, chrome: c, intersect, topAtIntersection: topAt, pillTopAtOwnCentre,
    bodyChildren: Array.from(document.body.children).map((el, i) =>
      i + ':' + el.tagName.toLowerCase()
      + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '')
      + (el.hasAttribute('data-state') ? '[data-state]' : '')
      + ' pos=' + getComputedStyle(el).position + ' z=' + getComputedStyle(el).zIndex),
    scrollHeight: document.documentElement.scrollHeight,
    innerWidth: window.innerWidth,
  };
})()`;

// ------------------------------------------------------------------ matrix
const VARIANTS = [
  { key: 'workspace-desk', chrome: 'desk', path: (s) => `/workspace/${s.pid}`, deskRoute: true },
  { key: 'generate', chrome: 'appshell', path: () => `/generate` },
  { key: 'gallery', chrome: 'appshell', path: () => `/gallery` },
  { key: 'studio-projects', chrome: 'appshell', path: () => `/studio/projects` },
  { key: 'scenario-list', chrome: 'appshell', path: () => `/scenario` },
  { key: 'studio-editor-fullbleed', chrome: 'appshell', path: (s) => `/studio/${s.studio}` },
  { key: 'boards-canvas', chrome: 'boards', path: (s) => `/boards/${s.board}` },
  { key: 'scenario-canvas', chrome: 'scenario', path: (s) => `/scenario/${s.script}` },
  {
    key: 'boards-409-foreign',
    chrome: 'none',
    path: (s) => `/boards/${s.otherBoard}`,
    onlyValid: true,
  },
  {
    key: 'boards-invalid-early-return',
    chrome: 'none',
    path: (s) => `/boards/${s.board}`,
    forceQuery: 'projectId=a&projectId=b',
    onlyValid: true,
  },
];

const VIEWPORTS = [
  { name: '375', w: 375, h: 812 },
  { name: '1280', w: 1280, h: 800 },
  { name: '1600', w: 1600, h: 900 },
  { name: '1920', w: 1920, h: 1000 },
];

const ids = {
  pid: project.id,
  board: board.id,
  otherBoard: otherBoard.id,
  script: script.id,
  studio: studio.id,
};

const browser = await chromium.launch();
const results = [];
const consoleLog = [];

async function capture({ variant, stateName, vp, full }) {
  const ctx = await browser.newContext({
    storageState: STATE,
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)));

  if (stateName === 'loading') {
    // Hold the validation request open so the `loading` chrome stays painted.
    await page.route(`**/v1/projects/${project.id}`, async () => {
      /* never fulfilled → request hangs */
    });
  }

  let query = '';
  if (variant.forceQuery) query = `?${variant.forceQuery}`;
  else if (stateName === 'valid' || stateName === 'loading') query = `?projectId=${project.id}`;
  else if (stateName === 'invalid') query = `?projectId=${MISSING}`;
  // standalone → no query

  const url = `${WEB}${variant.path(ids)}${query}`;
  let nav = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .waitForLoadState('networkidle', { timeout: 15_000 })
      .catch(() => {})
      .then(() => {});
  } catch (e) {
    nav = String(e).slice(0, 200);
  }
  await page.waitForTimeout(stateName === 'loading' ? 1500 : 3500);

  const m = await page.evaluate(MEASURE(CHROME[variant.chrome])).catch((e) => ({
    error: String(e).slice(0, 300),
  }));

  const base = `${variant.key}__${stateName}__${vp.name}`;
  const clipW = Math.min(vp.w, 1000);
  await page
    .screenshot({
      path: `${OUT}/${base}.png`,
      clip: { x: 0, y: 0, width: clipW, height: Math.min(vp.h, 200) },
    })
    .catch(() => {});
  if (full) {
    await page.screenshot({ path: `${OUT}/${base}__full.png` }).catch(() => {});
  }

  results.push({
    variant: variant.key,
    state: stateName,
    viewport: vp.name,
    url: url.replace(WEB, ''),
    finalUrl: page.url().replace(WEB, ''),
    nav,
    consoleErrors: errors.slice(0, 4),
    ...m,
  });
  if (errors.length) consoleLog.push({ base, errors });
  await ctx.close();
  console.log('captured', base);
}

// Priority 1 — every chrome variant × valid × all four viewports.
for (const variant of VARIANTS) {
  for (const vp of VIEWPORTS) {
    await capture({ variant, stateName: 'valid', vp, full: vp.name === '1280' });
  }
}
// Priority 2 — the other three context states at 1280 only.
for (const variant of VARIANTS.filter((v) => !v.onlyValid)) {
  for (const stateName of ['loading', 'invalid', 'standalone']) {
    await capture({ variant, stateName, vp: VIEWPORTS[1], full: false });
  }
}

await browser.close();
writeFileSync(
  `${OUT}/_measurements.json`,
  JSON.stringify({ ids, results, consoleLog }, null, 2) + '\n',
);
console.log('DONE →', OUT);
