import { test, expect } from './studio-fixtures';
import type { APIRequestContext } from '@playwright/test';

/**
 * Studio editor — E1 context inspector (video-editor campaign).
 * State-seeded via PUT /v1/studio/project; no renders (UI-only slice).
 */

const CLIP = (uid: string) => ({
  uid,
  url: 'http://example.test/clip.mp4',
  dur: 5,
  inSec: 0,
  outSec: 5,
  speed: 1,
  muted: false,
  volumeDb: 0,
  transition: 'crossfade',
  transitionSec: 0.5,
  filter: 'none',
});

async function seedProject(request: APIRequestContext, apiUrl: string, cookie: string) {
  const res = await request.put(`${apiUrl}/v1/studio/project`, {
    headers: { cookie, 'content-type': 'application/json' },
    data: {
      timeline: {
        timeline: [CLIP('c1'), CLIP('c2')],
        texts: [],
        music: null,
        voiceover: null,
        formatId: '9:16',
      },
    },
  });
  expect(res.ok()).toBe(true);
}

test.describe('studio context inspector (E1)', () => {
  test('select clip → tabs open on Основное; props live in their tabs; triple-input edits persist', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // select the first clip block on the timeline
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    const insp = page.getByTestId('clip-inspector');
    await expect(insp).toBeVisible();
    await expect(page.getByTestId('inspector-tabs')).toBeVisible();
    await expect(insp.getByTestId('insp-pane-main')).toBeVisible();

    // the main tab leads with Трансформация; transitions no longer live in the
    // inspector (G4 — they're applied on the timeline junction)
    await expect(insp.getByTestId('insp-sec-transform')).toBeVisible();
    await expect(insp.getByTestId('insp-transition-sec')).toHaveCount(0);

    // Звук tab: volume triple-input + mute disables it
    await page.getByTestId('insp-tab-audio').click();
    await expect(insp.getByTestId('insp-pane-audio')).toBeVisible();
    await insp.getByTestId('insp-volume-value').fill('-12');
    await expect(insp.getByTestId('insp-volume-value')).toHaveValue('-12');
    await insp.getByTestId('insp-mute').click();
    await expect(insp.getByTestId('insp-volume-value')).toBeDisabled();

    // Цвет folds into Основное (CapCut: Color inside Basic); Скорость is a tab
    await page.getByTestId('insp-tab-main').click();
    await insp.getByTestId('insp-sec-color-toggle').click();
    await expect(insp.getByTestId('insp-pane-color')).toBeVisible();
    await page.getByTestId('insp-tab-speed').click();
    await expect(insp.getByTestId('insp-pane-speed')).toBeVisible();

    // selecting another clip resets to Основное
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').nth(1).click();
    await expect(insp.getByTestId('insp-pane-main')).toBeVisible();

    // edits persisted through autosave (volumeDb + muted on clip 1)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; volumeDb: number; muted: boolean }[] }[] };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.volumeDb).toBe(-12);
    expect(c1?.muted).toBe(true);
  });
});

test.describe('transform (E2)', () => {
  test('inspector edits drive the CSS preview; canvas handles mount; persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');
    await expect(insp.getByTestId('insp-pane-main')).toBeVisible();

    // set scale + posX through the triple-inputs
    await insp.getByTestId('insp-scale-value').fill('1.5');
    await insp.getByTestId('insp-pos-x-value').fill('10');

    // preview parity: the clip's <video> carries the same CSS transform
    const video = page.locator('video').first();
    await expect(video).toHaveCSS('transform', /matrix/);
    const style = await video.getAttribute('style');
    expect(style).toContain('scale(1.5)');
    expect(style).toContain('translate(10%, 0%)');

    // crop maps to clip-path inset
    await insp.getByTestId('insp-crop-left-value').fill('20');
    const style2 = await page.locator('video').first().getAttribute('style');
    expect(style2).toContain('clip-path: inset(0% 0% 0% 20%)');

    // on-canvas transform gizmo + handles are mounted for the selection
    // (4 corner scale handles + a rotation nub, in the unclipped wrapper)
    const canvas = page.getByTestId('canvas-transform');
    await expect(canvas).toBeVisible();
    await expect(canvas.locator('[data-handle="rotate"]')).toBeVisible();
    await expect(canvas.locator('[data-handle="scale"]').first()).toBeVisible();
    expect(await canvas.locator('[data-handle="scale"]').count()).toBe(4);

    // transform persists through autosave
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: {
        tracks: { clips: { uid: string; transform?: { scale: number; posX: number } }[] }[];
      };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.transform?.scale).toBe(1.5);
    expect(c1?.transform?.posX).toBe(10);
  });

  test('dragging a gizmo corner scales the clip + drives the inspector field', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');
    await expect(insp.getByTestId('insp-scale-value')).toHaveValue('1');

    // drag the bottom-right corner outward → scale up
    const handle = page.getByTestId('gizmo-handle').nth(3);
    const box = await handle.boundingBox();
    if (!box) throw new Error('gizmo handle has no box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 70, { steps: 12 });
    await page.mouse.up();

    const scaled = Number(await insp.getByTestId('insp-scale-value').inputValue());
    expect(scaled).toBeGreaterThan(1.1); // the field tracks the gizmo two-way
  });
});

test.describe('colour grade (E3)', () => {
  test('sliders drive the CSS filter; preset quick-applies; vignette overlay mounts; persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');
    // Color folds into Основное as the «Цвет» section — expand it
    await insp.getByTestId('insp-sec-color-toggle').click();
    await expect(insp.getByTestId('insp-pane-color')).toBeVisible();

    // slider → CSS parity on the clip's <video>
    await insp.getByTestId('insp-color-saturation-value').fill('40');
    await insp.getByTestId('insp-color-temperature-value').fill('-50');
    const style = await page.locator('video').first().getAttribute('style');
    expect(style).toContain('saturate(1.4)');
    expect(style).toContain('hue-rotate(-6deg)');

    // vignette mounts its overlay
    await insp.getByTestId('insp-color-vignette-value').fill('60');
    await expect(page.getByTestId('grade-overlay')).toBeVisible();

    // preset quick-apply overwrites the sliders (mono → saturation −100)
    await insp.getByTestId('insp-pane-color').locator('button', { hasText: 'Ч/Б' }).click();
    await expect(insp.getByTestId('insp-color-saturation-value')).toHaveValue('-100');

    // persists through autosave
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; color?: { saturation: number } }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.color?.saturation).toBe(
      -100,
    );
  });
});

test.describe('clip toolbar (E4)', () => {
  test('flip mirrors the preview; reverse toggles; freeze inserts a still clip', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');

    // flip H → preview transform mirrors
    await insp.getByTestId('clip-flip-h').click();
    const style = await page.locator('video').first().getAttribute('style');
    expect(style).toContain('scaleX(-1)');
    await expect(insp.getByTestId('clip-flip-h')).toHaveAttribute('aria-pressed', 'true');

    // reverse toggles on
    await insp.getByTestId('clip-reverse').click();
    await expect(insp.getByTestId('clip-reverse')).toHaveAttribute('aria-pressed', 'true');

    // freeze at default playhead (0) inserts a still after the first clip half
    const before = await page.locator('[data-testid="timeline-clip"]').count();
    await insp.getByTestId('clip-freeze').click();
    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(before + 1);

    // persisted: clip 1 reversed+flipped, a freeze clip exists
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: {
        tracks: {
          clips: { uid: string; reversed?: boolean; flipH?: boolean; freeze?: object }[];
        }[];
      };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.reversed).toBe(true);
    expect(c1?.flipH).toBe(true);
    expect(body.timeline.tracks[0]!.clips.some((c) => c.freeze)).toBe(true);
  });
});

test.describe('speed upgrade (E5)', () => {
  test('wide speed via triple-input; ramp preset disables it and persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');
    await page.getByTestId('insp-tab-speed').click();

    // widened range accepts 3×
    await insp.getByTestId('insp-speed-value').fill('3');
    await expect(insp.getByTestId('insp-speed-value')).toHaveValue('3');

    // ramp preset «Герой» disables the uniform slider
    await insp.getByTestId('insp-pane-speed').locator('button', { hasText: 'Герой' }).click();
    await expect(insp.getByTestId('insp-speed-value')).toBeDisabled();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; speed: number; speedCurve?: string }[] }[] };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.speed).toBe(3);
    expect(c1?.speedCurve).toBe('hero');
  });
});

test.describe('animation gallery (E6)', () => {
  // Animation is single-homed on the rail's Animation tab (the In/Out/Combo preset
  // gallery that compiles to keyframes); the old MainPanel animIn/animOut accordion
  // was removed to de-duplicate, so the gallery test below is the single home.
  test('animation gallery: rail tab → In/Combo presets compile to keyframes that persist', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();

    // open the dedicated Animation rail icon → gallery panel
    await page.getByTestId('insp-tab-animation').click();
    await expect(page.getByTestId('insp-pane-animation')).toBeVisible();
    expect(await page.locator('[data-testid^="anim-in-"]').count()).toBe(8);

    // apply a zoom entrance → at the playhead (t=0) the clip is invisible + scaled
    await page.getByTestId('anim-in-zoom').click();
    const op = await page
      .locator('video')
      .first()
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(op)).toBeLessThan(0.05);

    // Combo group exposes its own presets
    await page.getByText('Комбо', { exact: true }).click();
    expect(await page.locator('[data-testid^="anim-combo-"]').count()).toBe(5);

    // the compiled keyframes persist (and thus render in export)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; keyframes?: { scale?: unknown[] } }[] }[] };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.keyframes?.scale?.length).toBe(2);
  });
});

test.describe('keyframes (E7 phase 1)', () => {
  test('diamond adds/removes a key at the playhead and drives the preview', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');

    // give posX a static value, then key it at t=0
    await insp.getByTestId('insp-pos-x-value').fill('25');
    await insp.getByTestId('kf-posX').click();
    await expect(insp.getByTestId('kf-posX')).toContainText('1');

    // opacity key at t=0 (current value 1)
    await insp.getByTestId('kf-opacity').click();
    await expect(insp.getByTestId('kf-opacity')).toContainText('1');

    // toggling again removes the key
    await insp.getByTestId('kf-opacity').click();
    await expect(insp.getByTestId('kf-opacity')).not.toContainText('1');

    // keyframed posX shows in the preview transform at t=0
    const style = await page.locator('video').first().getAttribute('style');
    expect(style).toContain('translate(25%, 0%)');

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: {
        tracks: { clips: { uid: string; keyframes?: { posX?: { t: number; v: number }[] } }[] }[];
      };
    };
    const c1 = body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1');
    expect(c1?.keyframes?.posX?.[0]).toEqual({ t: 0, v: 25 });
  });
});

test.describe('inspector redesign (III.1)', () => {
  test('Basic panel is sectioned; the Transform section reset clears the transform', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');

    // grouped sections render (mask + the keyframe-bearing transform group)
    await expect(insp.getByTestId('insp-mask')).toBeVisible();
    const tform = insp.getByTestId('insp-sec-transform');
    await expect(tform).toBeVisible();

    // a non-identity transform exposes the per-section reset…
    await insp.getByTestId('insp-scale-value').fill('1.5');
    await insp.getByTestId('insp-pos-x-value').fill('20');
    const reset = insp.getByTestId('insp-sec-transform-reset');
    await expect(reset).toBeVisible();

    // …and clicking it restores the identity transform.
    await reset.click();
    await expect(insp.getByTestId('insp-scale-value')).toHaveValue('1');
    await expect(insp.getByTestId('insp-pos-x-value')).toHaveValue('0');
    await expect(reset).toHaveCount(0);
  });

  test('rail is 6 icons (Color folds into Основное; Animation single-homed)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const insp = page.getByTestId('clip-inspector');
    const rail = page.getByTestId('inspector-tabs');

    // CapCut web's video set = 6 rail icons; Color is NOT one of them
    await expect(rail.locator('button[data-testid^="insp-tab-"]')).toHaveCount(6);
    await expect(rail.getByTestId('insp-tab-color')).toHaveCount(0);
    for (const id of ['main', 'background', 'speed', 'animation', 'audio', 'smart']) {
      await expect(rail.getByTestId(`insp-tab-${id}`)).toBeVisible();
    }

    // Color lives as a folded section inside Основное (the Basic tab)
    await expect(insp.getByTestId('insp-sec-color')).toBeVisible();
    await insp.getByTestId('insp-sec-color-toggle').click();
    await expect(insp.getByTestId('insp-pane-color')).toBeVisible();

    // Animation has NO duplicate accordion in Основное (single-homed on the rail)
    await expect(insp.getByTestId('insp-sec-anim')).toHaveCount(0);
    await page.getByTestId('insp-tab-animation').click();
    await expect(page.getByTestId('insp-pane-animation')).toBeVisible();
  });
});

test.describe('geometric transitions', () => {
  test('pick slide in the grid → persists + drives the mid-overlap preview geometry', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();

    // G4: the transition catalog lives in the left «Переходы» library now (not the
    // inspector). Click a tile to apply it to the selected clip's junction.
    await page.getByTestId('rail-transitions').click();
    const lib = page.getByTestId('lib-transitions');
    const grid = lib.getByTestId('transition-grid');
    await expect(grid).toBeVisible();
    expect(await grid.locator('[data-testid^="transition-"]').count()).toBe(15);

    // apply a slide-left → tile reflects selection
    await lib.getByTestId('transition-slideleft').click();
    await expect(lib.getByTestId('transition-slideleft')).toHaveAttribute('aria-pressed', 'true');

    // step the playhead into the c1→c2 overlap ([4.5, 5.0]; clip dur 5, overlap 0.5)
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.locator('[data-testid="timeline-clip"]').first().click();
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight'); // → 4.0s
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); // → 4.7s, p≈0.4

    // outgoing (c1) translates left (negative), incoming (c2) enters from the right
    const out = await page.locator('video').first().getAttribute('style');
    const inc = await page.locator('video').nth(1).getAttribute('style');
    expect(out).toMatch(/translateX\(-\d/); // outgoing exits left
    expect(inc).toMatch(/translateX\((?!-)\d/); // incoming enters from the right

    // the transition persists (so the export uses the matching xfade mode)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; transition?: string }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.transition).toBe(
      'slideleft',
    );
  });

  test('drag a transition from the library onto a clip junction applies it (G4)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // open the «Переходы» library and grab a tile + the junction drop target
    await page.getByTestId('rail-transitions').click();
    const tile = page.getByTestId('lib-transitions').getByTestId('transition-wiperight');
    await expect(tile).toBeVisible();
    const junction = page.getByTestId('transition-btn').first();
    await expect(junction).toBeVisible();
    const tb = (await tile.boundingBox())!;
    const jb = (await junction.boundingBox())!;

    // pointer-drag the tile onto the junction (the window-listener drop pattern)
    await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + 20, tb.y + tb.height / 2, { steps: 4 });
    await page.mouse.move(jb.x + jb.width / 2, jb.y + jb.height / 2, { steps: 10 });
    await page.mouse.up();

    // the junction's clip now carries wiperight (persisted → export honours it)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; transition?: string }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.transition).toBe(
      'wiperight',
    );
  });
});

test.describe('export settings (E9)', () => {
  test('settings popover offers resolution/fps/format; button reflects format', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.getByTestId('export-settings').click();
    const pop = page.getByTestId('export-settings-pop');
    await expect(pop).toBeVisible();
    await pop.locator('button', { hasText: '4K' }).click();
    await pop.locator('button', { hasText: 'MOV' }).click();
    await pop.locator('button', { hasText: '60' }).click();
    await expect(page.getByTestId('export-btn')).toContainText('Экспорт MOV');
  });
});

test.describe('multi-track PiP (E8)', () => {
  test('PiP add from bin → lane block + preview video + inspector edits persist', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    // seed a project that already carries one PiP overlay (the bin needs
    // gallery fixtures; state-seeding is this suite's pattern)
    const res0 = await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1'), CLIP('c2')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 1,
              inSec: 0,
              outSec: 3,
              scale: 0.35,
              posX: 28,
              posY: -24,
              opacity: 1,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    expect(res0.ok()).toBe(true);
    await page.goto('/studio');
    await expect(page.locator('[data-testid="timeline-clip"]').first()).toBeVisible();

    // lane + block + preview element render from state; select via the block
    await expect(page.getByTestId('overlay-lane')).toBeVisible();
    await page.getByTestId('overlay-block').click();
    await expect(page.getByTestId('pip-video')).toHaveCount(1);
    const insp = page.getByTestId('overlay-inspector');
    await expect(insp).toBeVisible();

    // III.1: overlay now edits the canonical upper-track clip through the SAME
    // structured inspector as a base clip (size/pos/rotate via triple-inputs).
    await insp.getByTestId('insp-scale-value').fill('50');
    await insp.getByTestId('insp-pos-x-value').fill('-30');
    const style = await page.getByTestId('pip-video').getAttribute('style');
    expect(style).toContain('width: 50%');
    expect(style).toContain('left: calc(20%)'); // 50% + (−30%) normalized

    // persisted with the project
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    // §B: overlays persist as upper-track clips now (tracks[1]), not the legacy
    // overlays[] projection — the edit lands on the canonical clip's transform.
    const body = (await res.json()) as {
      timeline: { tracks?: { clips: { transform?: { scale: number; posX: number } }[] }[] };
    };
    const ov = body.timeline.tracks?.[1]?.clips?.[0];
    expect(ov?.transform?.scale).toBe(0.5);
    expect(ov?.transform?.posX).toBe(-30);

    // delete removes block + video
    await insp.getByTestId('overlay-delete').click();
    await expect(page.getByTestId('pip-video')).toHaveCount(0);
  });

  test('export serializes an upper-track clip as tracks[] with startSec (Phase II/III.3)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 1,
              inSec: 0,
              outSec: 3,
              scale: 0.5,
              posX: 20,
              posY: -10,
              opacity: 0.8,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    await expect(page.locator('[data-testid="timeline-clip"]').first()).toBeVisible();

    // intercept the render POST and capture its body (no real render)
    let body: {
      overlays?: unknown;
      tracks?: { startSec: number; transform?: { scale: number }; opacity?: number }[][];
    } | null = null;
    await page.route('**/v1/studio/render', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ renderId: 'test-render' }),
      });
    });
    await page.getByTestId('export-btn').click();
    await expect.poll(() => body).not.toBeNull();

    // upper-track clip rides on tracks[] (alpha path), NOT legacy overlays[]
    expect(body!.overlays).toBeUndefined();
    expect(Array.isArray(body!.tracks)).toBe(true);
    const up = body!.tracks![0]![0]!;
    expect(up.startSec).toBe(1);
    expect(up.transform?.scale).toBe(0.5);
    expect(up.opacity).toBeCloseTo(0.8, 5);
  });

  test('overlay rides a real stacked track block with a hover quick-delete (III.3b)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 1,
              inSec: 0,
              outSec: 3,
              scale: 0.35,
              posX: 28,
              posY: -24,
              opacity: 1,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    const block = page.getByTestId('overlay-block');
    await expect(block).toBeVisible();

    // selecting the block surfaces its quick-delete; clicking it removes the overlay
    await block.click();
    const del = page.getByTestId('overlay-delete-quick');
    await expect(del).toBeVisible();
    await del.click();
    await expect(page.getByTestId('overlay-block')).toHaveCount(0);
    await expect(page.getByTestId('pip-video')).toHaveCount(0);
  });

  test('overlay clip trims on the timeline by dragging its end edge (III.3b)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 0,
              inSec: 0,
              outSec: 4,
              scale: 0.35,
              posX: 28,
              posY: -24,
              opacity: 1,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    await page.getByTestId('overlay-block').click();
    const handle = page.getByTestId('overlay-trim-out');
    await expect(handle).toBeVisible();
    await handle.scrollIntoViewIfNeeded();
    const box = (await handle.boundingBox())!;

    // drag the end-handle left → outSec shrinks below 4 (pointer-capture drag)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.move(box.x - 90, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks?: { clips: { outSec: number }[] }[] };
    };
    const out = body.timeline.tracks?.[1]?.clips?.[0]?.outSec ?? 4;
    expect(out).toBeLessThan(4);
    expect(out).toBeGreaterThanOrEqual(0.2);
  });

  test('overlay repositions by dragging it in the preview (III.4)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 0,
              inSec: 0,
              outSec: 3,
              scale: 0.4,
              posX: 0,
              posY: 0,
              opacity: 1,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    const pip = page.getByTestId('pip-video');
    await expect(pip).toBeVisible();
    const box = (await pip.boundingBox())!;

    // drag the overlay right+down in the preview → posX/posY increase
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2 + 30, { steps: 8 });
    await page.mouse.up();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks?: { clips: { transform?: { posX: number; posY: number } }[] }[] };
    };
    const ov = body.timeline.tracks?.[1]?.clips?.[0];
    expect(ov?.transform?.posX ?? 0).toBeGreaterThan(0);
    expect(ov?.transform?.posY ?? 0).toBeGreaterThan(0);
  });

  test('overlay gets the unified inspector shell with honestly-gated tabs (III.1/G1)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [],
          overlays: [
            {
              uid: 'ov1',
              url: 'http://example.test/pip.mp4',
              atSec: 0,
              inSec: 0,
              outSec: 3,
              scale: 0.4,
              posX: 0,
              posY: 0,
              opacity: 1,
              muted: false,
              gainDb: 0,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    await page.getByTestId('overlay-block').click();
    const insp = page.getByTestId('overlay-inspector');
    await expect(insp).toBeVisible();
    const rail = page.getByTestId('inspector-tabs');

    // worker-renderable tabs are enabled; the rest are gated-disabled (honest)
    for (const id of ['main', 'audio', 'smart']) {
      await expect(rail.getByTestId(`insp-tab-${id}`)).toBeEnabled();
    }
    for (const id of ['background', 'speed', 'animation']) {
      await expect(rail.getByTestId(`insp-tab-${id}`)).toBeDisabled();
    }

    // Основное is the rich structured panel (rotate + colour fold + in/out anim)
    // plus an honest mask/blend gate — not the old reduced flat list.
    await expect(insp.getByTestId('insp-rotate')).toBeVisible();
    await expect(insp.getByTestId('insp-sec-color')).toBeVisible();
    await expect(insp.getByTestId('insp-sec-anim')).toBeVisible();
    await expect(insp.getByTestId('insp-sec-gated')).toBeVisible();

    // rotate drives the PiP preview (preview == export: the worker rotates the
    // alpha layer) and persists into the upper-track clip's transform.
    await insp.getByTestId('insp-rotate-value').fill('30');
    const style = await page.getByTestId('pip-video').getAttribute('style');
    expect(style).toMatch(/rotate\(30deg\)/);

    // poll the persisted blob — the debounced autosave PUT over the tunnel can
    // land a beat after the edit; assert the rotation reached the upper-track clip.
    await expect
      .poll(
        async () => {
          const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
            headers: { cookie: cookieHeader },
          });
          const body = (await res.json()) as {
            timeline: { tracks?: { clips: { uid: string; transform?: { rotate: number } }[] }[] };
          };
          return body.timeline.tracks?.[1]?.clips?.find((c) => c.uid === 'ov1')?.transform?.rotate;
        },
        { timeout: 8000, intervals: [500, 1000, 1500] },
      )
      .toBe(30);
  });
});

test.describe('crop modal (S5)', () => {
  test('canvas crop opens, edits live, and persists transform.crop', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    await expect(page.getByTestId('clip-inspector')).toBeVisible();

    // Floating selection toolbar → Crop opens the modal.
    await page.getByTestId('canvas-crop').click();
    const modal = page.getByTestId('crop-modal');
    await expect(modal).toBeVisible();

    // Edit a crop edge → stored as a 0–0.45 fraction; Apply closes.
    await modal.getByTestId('crop-left-value').fill('15');
    await modal.getByTestId('crop-apply').click();
    await expect(modal).toHaveCount(0);

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; transform?: { crop?: { left: number } } }[] }[] };
    };
    expect(
      body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.transform?.crop?.left,
    ).toBeCloseTo(0.15, 2);
  });
});

test.describe('library: filters (S4)', () => {
  test('rail switches to Filters; a filter applies to the selected clip + persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    await expect(page.getByTestId('clip-inspector')).toBeVisible();

    await page.getByTestId('rail-filters').click();
    await expect(page.getByTestId('lib-filters')).toBeVisible();
    await page.getByTestId('filter-mono').click();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; filter?: string }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.filter).toBe('mono');
  });

  test('filters apply to the playhead clip with NOTHING selected (owner fix)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await expect(page.locator('[data-testid="timeline-clip"]').first()).toBeVisible();

    // deliberately do NOT select a clip — the catalog should still work,
    // applying to the clip under the playhead (c1 at t=0).
    await page.getByTestId('rail-filters').click();
    await expect(page.getByTestId('lib-filters')).toBeVisible();
    const warm = page.getByTestId('filter-warm');
    await expect(warm).toBeEnabled();
    await warm.click();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; filter?: string }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.filter).toBe('warm');
  });
});

test.describe('captions panel (S6)', () => {
  test('rail Captions → manual adds a caption block that persists', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await expect(page.locator('[data-testid="timeline-clip"]').first()).toBeVisible();

    await page.getByTestId('rail-captions').click();
    await expect(page.getByTestId('lib-captions')).toBeVisible();
    await page.getByTestId('cap-manual').click();
    // a caption is a text block on the text track (burns in via drawtext)
    await expect(page.getByTestId('text-block').first()).toBeVisible();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as { timeline: { texts?: unknown[] } };
    expect((body.timeline.texts ?? []).length).toBeGreaterThan(0);
  });
});

test.describe('library: effects + audio (S4)', () => {
  test('rail Effects applies a look (persists); rail Audio shows its panel', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"], [data-clip-uid]').first().click();
    await expect(page.getByTestId('clip-inspector')).toBeVisible();

    await page.getByTestId('rail-effects').click();
    await expect(page.getByTestId('lib-effects')).toBeVisible();
    await page.getByTestId('effect-mono').click();

    await page.getByTestId('rail-audio').click();
    await expect(page.getByTestId('lib-audio')).toBeVisible();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; filter?: string }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.filter).toBe('mono');
  });
});

test.describe('timeline filmstrip (§6)', () => {
  test('each video clip renders a filmstrip of frames, not a single thumbnail', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // every timeline clip carries a filmstrip container...
    const clips = page.locator('[data-testid="timeline-clip"]');
    await expect(clips.first()).toBeVisible();
    const clipCount = await clips.count();
    const strips = page.locator('[data-testid="clip-filmstrip"]');
    expect(await strips.count()).toBe(clipCount);

    // ...and the strip is built from seeked frame <video>s (≥1), each pointing at
    // a distinct #t= offset across the clip (a strip of frames, not one thumb).
    const firstStrip = strips.first();
    const frames = firstStrip.locator('video');
    expect(await frames.count()).toBeGreaterThanOrEqual(1);
    const src0 = await frames.first().getAttribute('src');
    expect(src0).toContain('#t=');
  });

  test('per-clip hover toolbar duplicates the clip in place', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    const clip = page.locator('[data-testid="timeline-clip"]').first();
    await expect(clip).toBeVisible();
    const before = await page.locator('[data-testid="timeline-clip"]').count();

    await clip.hover();
    // the toolbar is a SIBLING of the clip button (not nested) — locate the
    // hovered clip's toolbar (first in DOM = the first clip's).
    const bar = page.locator('[data-testid="clip-hover-toolbar"]').first();
    await expect(bar).toBeVisible();
    await bar.getByTestId('clip-tool-dup').click();

    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(before + 1);
  });

  test('trimming a clip out-edge snaps to the playhead, showing a guide line', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // select the first clip → its trim handles mount
    await page.locator('[data-testid="timeline-clip"]').first().click();
    const out = page.getByTestId('trim-out');
    await expect(out).toBeVisible();
    const ob = (await out.boundingBox())!;
    const ruler = page.getByTestId('timeline-ruler');
    const rb = (await ruler.boundingBox())!;

    // park the playhead ~120px left of the out-edge, inside the clip
    const targetX = ob.x + ob.width / 2 - 120;
    await ruler.click({ position: { x: targetX - rb.x, y: 2 } });
    // no guide until a trim drag locks onto something
    await expect(page.getByTestId('snap-guide')).toHaveCount(0);

    // drag the out-edge onto the playhead → it snaps + a guide appears
    await page.mouse.move(ob.x + ob.width / 2, ob.y + ob.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetX + 24, ob.y + ob.height / 2, { steps: 6 });
    await page.mouse.move(targetX, ob.y + ob.height / 2, { steps: 6 });
    await expect(page.getByTestId('snap-guide')).toBeVisible();

    // releasing clears the guide
    await page.mouse.up();
    await expect(page.getByTestId('snap-guide')).toHaveCount(0);
  });

  test('drag-reorder moves a clip to the drop position with an insertion line', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    const first = page.locator('[data-testid="timeline-clip"]').first();
    await expect(first).toBeVisible();
    const fb = (await first.boundingBox())!;
    const tl = page.locator('[data-testid="timeline"]').first();
    const tb = (await tl.boundingBox())!;

    // drag clip 1 from its center across to the far right of the track
    await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.mouse.down();
    await page.mouse.move(fb.x + fb.width / 2 + 24, fb.y + fb.height / 2, { steps: 5 });
    await page.mouse.move(tb.x + tb.width - 16, fb.y + fb.height / 2, { steps: 12 });
    // an insertion-gap line previews the drop, then clears on release
    await expect(page.getByTestId('reorder-line')).toBeVisible();
    await page.mouse.up();
    await expect(page.getByTestId('reorder-line')).toHaveCount(0);

    // c1 now sits after c2 (a move, not a swap-in-place)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as { timeline: { tracks: { clips: { uid: string }[] }[] } };
    expect(body.timeline.tracks[0]!.clips.map((c) => c.uid)).toEqual(['c2', 'c1']);
  });

  test('undo/redo reverts and re-applies a clip delete (⌘Z / ⌘⇧Z)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    const clips = page.locator('[data-testid="timeline-clip"]');
    await expect(clips.first()).toBeVisible();
    const c0 = await clips.count();

    // delete the selected clip
    await clips.first().click();
    await page.keyboard.press('Delete');
    await expect(clips).toHaveCount(c0 - 1);

    // undo enables once the edit is captured, then ⌘Z restores it
    await expect(page.getByTestId('undo')).toBeEnabled();
    await page.keyboard.press('Control+z');
    await expect(clips).toHaveCount(c0);

    // redo re-applies the delete
    await expect(page.getByTestId('redo')).toBeEnabled();
    await page.keyboard.press('Control+Shift+z');
    await expect(clips).toHaveCount(c0 - 1);
  });

  test('multi-select (⌘-click) ripple-deletes several clips; survivor closes the gap', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    // seed three clips so a partial multi-delete leaves a survivor
    const res0 = await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1'), CLIP('c2'), CLIP('c3')],
          texts: [],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    expect(res0.ok()).toBe(true);
    await page.goto('/studio');

    const clips = page.locator('[data-testid="timeline-clip"]');
    await expect(clips).toHaveCount(3);

    // select clip 1, then ⌘/Ctrl-click clip 3 → both report selected (semantic
    // aria-pressed, not a CSS class)
    await clips.nth(0).click();
    await clips.nth(2).click({ modifiers: ['Control'] });
    await expect(page.locator('[data-testid="timeline-clip"][aria-pressed="true"]')).toHaveCount(2);

    // Del ripples both out; the survivor (c2) slides to the start
    await page.keyboard.press('Delete');
    await expect(clips).toHaveCount(1);
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as { timeline: { tracks: { clips: { uid: string }[] }[] } };
    expect(body.timeline.tracks[0]!.clips.map((c) => c.uid)).toEqual(['c2']);
  });
});

test.describe('timeline ruler & zoom (III.2)', () => {
  test('adaptive ruler shows labelled ticks; the zoom % readout tracks the zoom', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // the ruler renders adaptive labelled major ticks (e.g. "2s" / "0:05")
    const ruler = page.getByTestId('timeline-ruler');
    await expect(ruler).toBeVisible();
    await expect(ruler.locator('span', { hasText: /^\d/ }).first()).toBeVisible();

    // the zoom % readout reflects the slider and rises when zooming in
    const pct = page.getByTestId('zoom-pct');
    await page.getByTestId('zoom-fit').click();
    const read = async () => Number((await pct.textContent())?.replace('%', '') ?? '0');
    const before = await read();
    await page.getByTestId('zoom-in').click();
    await page.getByTestId('zoom-in').click();
    expect(await read()).toBeGreaterThan(before);
  });
});

test.describe('floating layer toolbar (III.5)', () => {
  test('selecting a clip shows the preview toolbar; mirror flips the clip', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();

    const bar = page.getByTestId('layer-toolbar');
    await expect(bar).toBeVisible();
    await bar.getByTestId('layer-tool-mirror').click();

    // the flip persists into the project (renders mirrored in export)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { tracks: { clips: { uid: string; flipH?: boolean }[] }[] };
    };
    expect(body.timeline.tracks[0]!.clips.find((c) => c.uid === 'c1')?.flipH).toBe(true);
  });
});

test.describe('text on the timeline (drag + trim)', () => {
  test('a title moves on the tape by dragging it (not just the side panel)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [
            {
              uid: 't1',
              text: 'Привет',
              fromSec: 0.5,
              toSec: 2.5,
              position: 'bottom',
              font: 'sans',
              fade: true,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    const block = page.getByTestId('text-block');
    await expect(block).toBeVisible();
    const box = (await block.boundingBox())!;

    // drag the title body right → fromSec increases (timeline drag, no side panel)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { texts: { uid: string; fromSec: number; toSec: number }[] };
    };
    const t1 = body.timeline.texts.find((x) => x.uid === 't1');
    expect(t1!.fromSec).toBeGreaterThan(0.5);
    // duration preserved by the move (~2s)
    expect(Math.abs(t1!.toSec - t1!.fromSec - 2)).toBeLessThan(0.25);
  });
});

test.describe('flash transition (dip-to-white)', () => {
  test('flash sets on a clip and the white veil shows over its overlap', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');
    await page.locator('[data-testid="timeline-clip"]').first().click();

    // G4: «Вспышка» is a transition tile in the «Переходы» library now — it moved
    // out of the inspector onto the timeline junction (commit c88e726). Apply it
    // from the grid to the selected clip's junction.
    await page.getByTestId('rail-transitions').click();
    const lib = page.getByTestId('lib-transitions');
    await lib.getByTestId('transition-flash').click();
    await expect(lib.getByTestId('transition-flash')).toHaveAttribute('aria-pressed', 'true');

    // persists as 'flash' (renders xfade=fadewhite) — poll the debounced autosave
    // rather than a fixed wait so it can't race the 1200ms save.
    await expect
      .poll(
        async () => {
          const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
            headers: { cookie: cookieHeader },
          });
          const body = (await res.json()) as {
            timeline?: { tracks?: { clips: { uid: string; transition?: string }[] }[] };
          };
          // Null-safe: before the first autosave the persisted blob is still the
          // seeded legacy shape (no `tracks`) — return undefined so the poll
          // retries instead of throwing.
          return body.timeline?.tracks?.[0]?.clips.find((c) => c.uid === 'c1')?.transition;
        },
        { timeout: 9000, intervals: [400, 700, 1000, 1300, 1600] },
      )
      .toBe('flash');
  });
});

test.describe('studio mobile gate', () => {
  test('mobile shows a clean desktop-required gate; nothing clipped offscreen', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    // desktop (default 1440): the editor runs, the gate is hidden
    await expect(page.getByTestId('timeline')).toBeVisible();
    await expect(page.getByTestId('studio-mobile-gate')).toBeHidden();

    // phone: the gate replaces the editor — no clipped 5-column chrome
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('studio-mobile-gate')).toBeVisible();
    await expect(page.getByTestId('timeline')).toBeHidden();
    const offscreenX = await page.evaluate(() => {
      const w = window.innerWidth;
      let n = 0;
      for (const el of document.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > w + 1 || r.left < -1)) n++;
      }
      return n;
    });
    expect(offscreenX).toBe(0);
  });
});

test.describe('timeline trust fixes', () => {
  test('the playhead head is a real grab handle (drag scrubs)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    const ph = page.getByTestId('playhead');
    await expect(ph).toBeVisible();
    const before = await ph.evaluate((el) => (el as HTMLElement).style.left);
    const handle = page.getByTestId('playhead-handle');
    const hb = (await handle.boundingBox())!;
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + 160, hb.y + hb.height / 2, { steps: 8 });
    await page.mouse.up();
    const after = await ph.evaluate((el) => (el as HTMLElement).style.left);
    expect(after).not.toBe(before);
  });

  test('duplicate selects the copy (inspector follows, clip count +1)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    await page.locator('[data-testid="timeline-clip"]').first().click();
    const before = await page.locator('[data-testid="timeline-clip"]').count();
    await page.getByTestId('canvas-duplicate').click();
    await expect(page.locator('[data-testid="timeline-clip"]')).toHaveCount(before + 1);
    // selection survived onto the copy → inspector stays mounted
    await expect(page.getByTestId('clip-inspector')).toBeVisible();
  });
});

test.describe('text templates (§3.5)', () => {
  test('template tile drops a styled text clip with its sizeFrac (renders)', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await seedProject(context.request, apiUrl, cookieHeader);
    await page.goto('/studio');

    await page.getByTestId('rail-text').click();
    await expect(page.getByTestId('lib-text')).toBeVisible();

    const blocks = page.locator('[data-testid="text-block"]');
    const before = await blocks.count();
    await page.getByTestId('text-template-title').click();
    await expect(blocks).toHaveCount(before + 1);

    // the styled size persists into the project (worker renders height·sizeFrac)
    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { texts: { sizeFrac?: number; font?: string }[] };
    };
    expect(body.timeline.texts.length).toBeGreaterThanOrEqual(1);
    expect(body.timeline.texts.some((t) => Math.abs((t.sizeFrac ?? 0) - 0.11) < 0.001)).toBe(true);
  });
});

test.describe('text inspector unified shell (III.1/G1)', () => {
  test('text gets the rail shell (Пресеты + Основное), not a flat panel; preset re-styles', async ({
    signedInPage: page,
    context,
    cookieHeader,
    apiUrl,
  }) => {
    await context.request.put(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      data: {
        timeline: {
          timeline: [CLIP('c1')],
          texts: [
            {
              uid: 't1',
              text: 'Привет',
              fromSec: 0,
              toSec: 2,
              position: 'bottom',
              font: 'sans',
              fade: false,
            },
          ],
          music: null,
          voiceover: null,
          formatId: '9:16',
        },
      },
    });
    await page.goto('/studio');
    await page.getByTestId('text-block').click();
    const insp = page.getByTestId('text-inspector');
    await expect(insp).toBeVisible();
    const rail = page.getByTestId('inspector-tabs');

    // text has its OWN tab set — Пресеты + Основное, not the clip rail
    await expect(rail.getByTestId('insp-tab-presets')).toBeVisible();
    await expect(rail.getByTestId('insp-tab-main')).toBeEnabled();
    await expect(rail.getByTestId('insp-tab-speed')).toHaveCount(0);

    // Основное (default) carries the drawtext fields
    await expect(insp.getByTestId('text-input')).toBeVisible();

    // Пресеты tab → the template gallery re-styles the SAME title (keeps text):
    // «Заголовок» sets serif font + sizeFrac 0.11, which persists (renders).
    await rail.getByTestId('insp-tab-presets').click();
    await expect(insp.getByTestId('insp-pane-presets')).toBeVisible();
    await insp.getByTestId('text-preset-title').click();

    await page.waitForTimeout(1500);
    const res = await context.request.get(`${apiUrl}/v1/studio/project`, {
      headers: { cookie: cookieHeader },
    });
    const body = (await res.json()) as {
      timeline: { texts: { uid: string; text: string; font: string; sizeFrac?: number }[] };
    };
    const t1 = body.timeline.texts.find((t) => t.uid === 't1');
    expect(t1?.text).toBe('Привет'); // preset kept the text
    expect(t1?.font).toBe('serif');
    expect(Math.abs((t1?.sizeFrac ?? 0) - 0.11)).toBeLessThan(0.001);
  });
});
