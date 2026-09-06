import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import {
  assetReferences,
  db,
  galleryItems,
  nid,
  outboxJobs,
  pool,
  projects,
  studioRenders,
  studioProjects,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupStudioRoutes } from '../src/studio';

/**
 * S0 — THE TRUST CONTRACT (blocks all of the editor rebuild).
 *
 * The API is the ONLY boundary the worker sees: the client serializes the whole
 * editor state down to a `StudioRenderSpec`, POSTs it, and `studio_renders.spec`
 * is what ffmpeg ultimately renders. If the route silently drops a validated
 * field on the way to the DB, "preview == export" is a lie no matter how good
 * the UI is. This suite POSTs a kitchen-sink render — every instrument family
 * E1–E9, overlays, audio lines, texts, format — and asserts the persisted spec
 * round-trips EXACTLY (deep-equal: nothing dropped, nothing injected).
 *
 * Guards the historical P0 (`studio-render-field-drop-p0`): the route once
 * validated the full schema then forwarded only ~9 basic clip fields, dropping
 * transform, color, reversed, flipH, flipV, freeze, speedCurve, anim-in/out,
 * keyframes, plus top-level overlays and format.
 */
const createdUsers: string[] = [];
const createdRenders: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'StudioContract', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `studio+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

let userId: string;
let app: ReturnType<typeof Fastify>;

// Every URL this suite posts. BL-4 now requires render URLs to be owned by the
// user, so we register them as the user's own gallery assets (the round-trip
// being tested is about field persistence, not ownership). x.mp4 is only used
// by the schema-rejection cases, which 400 before the ownership check.
const OWNED_URLS = [
  'https://assets.seed.local/clip-a.mp4',
  'https://assets.seed.local/clip-b.mp4',
  'https://assets.seed.local/clip.mp4',
  'https://assets.seed.local/pip.mp4',
  'https://assets.seed.local/music.mp3',
  'https://assets.seed.local/vo.mp3',
  'https://assets.seed.local/legacy.mp3',
  'https://assets.seed.local/advanced.mp4',
  'https://assets.seed.local/sfx-1.mp3',
  'https://assets.seed.local/sfx-2.mp3',
];

beforeAll(async () => {
  userId = await makeUser();
  await db
    .insert(galleryItems)
    .values(
      OWNED_URLS.map((url) => ({ id: nid(), userId, assetUrl: url, kind: 'video' as const })),
    );
  // This suite posts several renders for one user without a worker to drain
  // them; lift the BL-2 in-flight cap so the field-contract assertions aren't
  // gated by the abuse ceiling (that ceiling is exercised in the abuse suite).
  process.env.STUDIO_MAX_INFLIGHT_RENDERS = '1000';
  app = Fastify({ logger: false });
  setupStudioRoutes(app, async () => ({ user: { id: userId } }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  if (createdRenders.length) {
    await db.delete(studioRenders).where(inArray(studioRenders.id, createdRenders));
    await db.delete(outboxJobs).where(
      inArray(
        outboxJobs.jobId,
        createdRenders.map((r) => `render-${r}`),
      ),
    );
  }
  for (const id of createdUsers) {
    await db.delete(studioRenders).where(eq(studioRenders.userId, id));
    await db.delete(projects).where(eq(projects.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await pool.end();
});

/** POST a render body and return the persisted `spec` (the worker's input). */
async function postRender(payload: unknown): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: 'POST', url: '/v1/studio/render', payload });
  expect(res.statusCode, res.body).toBe(201);
  const { renderId } = res.json() as { renderId: string };
  createdRenders.push(renderId);
  const row = (
    await db.select().from(studioRenders).where(eq(studioRenders.id, renderId)).limit(1)
  )[0]!;
  return row.spec as unknown as Record<string, unknown>;
}

describe('S0: /v1/studio/render persists every validated field into studio_renders.spec', () => {
  it('persists Studio asset ids through named compositions without changing retention', async () => {
    const assetId = nid();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await db.insert(galleryItems).values({
      id: assetId,
      userId,
      assetUrl: `https://assets.seed.local/${assetId}.mp4`,
      kind: 'video',
      expiresAt,
    });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/studio/projects',
      payload: { title: 'Identity lifecycle' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const studioProjectId = (created.json() as { id: string }).id;
    const identifiedTimeline = {
      schemaVersion: 2,
      tracks: [
        {
          id: 'track-0',
          kind: 'video',
          clips: [
            {
              uid: 'clip-identified',
              url: 'https://assets.seed.local/url-snapshot.mp4',
              assetId,
            },
          ],
        },
      ],
    };
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/studio/projects/${studioProjectId}`,
      payload: { timeline: identifiedTimeline, rev: 0 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const loaded = await app.inject({
      method: 'GET',
      url: `/v1/studio/projects/${studioProjectId}`,
    });
    expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json().timeline).toMatchObject({
      tracks: [{ clips: [{ assetId }] }],
    });
    expect(
      await db
        .select({ assetId: assetReferences.galleryItemId, refId: assetReferences.refId })
        .from(assetReferences)
        .where(eq(assetReferences.galleryItemId, assetId)),
    ).toEqual([{ assetId, refId: `${studioProjectId}:clip-identified` }]);
    expect(
      (
        await db
          .select({ expiresAt: galleryItems.expiresAt })
          .from(galleryItems)
          .where(eq(galleryItems.id, assetId))
      )[0]?.expiresAt,
    ).toEqual(expiresAt);

    const legacy = await app.inject({
      method: 'PUT',
      url: `/v1/studio/projects/${studioProjectId}`,
      payload: {
        timeline: {
          schemaVersion: 2,
          tracks: [
            {
              id: 'track-0',
              kind: 'video',
              clips: [{ uid: 'legacy', url: 'https://assets.seed.local/legacy-url.mp4' }],
            },
          ],
        },
        rev: 1,
      },
    });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(
      await db
        .select({ id: assetReferences.id })
        .from(assetReferences)
        .where(eq(assetReferences.galleryItemId, assetId)),
    ).toEqual([]);
    await db.delete(studioProjects).where(eq(studioProjects.id, studioProjectId));
  });

  it('uses the canonical URL for an owned asset id and refuses it once unavailable', async () => {
    const [asset] = await db
      .select({ id: galleryItems.id, assetUrl: galleryItems.assetUrl })
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, OWNED_URLS[0]))
      .limit(1);
    expect(asset).toBeTruthy();

    const spec = await postRender({
      clips: [{ url: 'https://stale.example/old.mp4', assetId: asset!.id }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect((spec.clips as Array<{ url: string }>)[0]?.url).toBe(asset!.assetUrl);

    await db
      .update(galleryItems)
      .set({ deletedAt: new Date() })
      .where(eq(galleryItems.id, asset!.id));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/studio/render',
        payload: {
          clips: [{ url: asset!.assetUrl, assetId: asset!.id }],
          width: 1280,
          height: 720,
          fps: 30,
        },
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toEqual({
        error: 'asset_unavailable',
        assetIds: [asset!.id],
        message: 'Материал недоступен. Замените его перед экспортом.',
      });
    } finally {
      await db.update(galleryItems).set({ deletedAt: null }).where(eq(galleryItems.id, asset!.id));
    }
  });

  it('stores only an owned live optional desk project context', async () => {
    const foreignUser = await makeUser();
    const ownedId = nid();
    const foreignId = nid();
    const deletedId = nid();
    await db.insert(projects).values([
      { id: ownedId, userId, title: 'Owned' },
      { id: foreignId, userId: foreignUser, title: 'Foreign' },
      { id: deletedId, userId, title: 'Deleted', deletedAt: new Date() },
    ]);

    const owned = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: { projectId: ownedId, clips: [{ url: OWNED_URLS[0] }] },
    });
    expect(owned.statusCode, owned.body).toBe(201);
    const ownedRenderId = (owned.json() as { renderId: string }).renderId;
    createdRenders.push(ownedRenderId);
    const [stored] = await db
      .select({ projectId: studioRenders.projectId })
      .from(studioRenders)
      .where(eq(studioRenders.id, ownedRenderId));
    expect(stored?.projectId).toBe(ownedId);

    for (const projectId of [foreignId, deletedId]) {
      const before = await db
        .select({ id: studioRenders.id })
        .from(studioRenders)
        .where(eq(studioRenders.userId, userId));
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/studio/render',
        payload: { projectId, clips: [{ url: OWNED_URLS[0] }] },
      });
      expect(rejected.statusCode).toBe(404);
      const after = await db
        .select({ id: studioRenders.id })
        .from(studioRenders)
        .where(eq(studioRenders.userId, userId));
      expect(after).toHaveLength(before.length);
    }

    const projectless = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: { clips: [{ url: OWNED_URLS[0] }] },
    });
    expect(projectless.statusCode, projectless.body).toBe(201);
    const projectlessId = (projectless.json() as { renderId: string }).renderId;
    createdRenders.push(projectlessId);
    const [projectlessRow] = await db
      .select({ projectId: studioRenders.projectId })
      .from(studioRenders)
      .where(eq(studioRenders.id, projectlessId));
    expect(projectlessRow?.projectId).toBeNull();
  });

  it('rejects a soft-deleted asset in the picker and at render use time', async () => {
    const assetUrl = 'https://assets.seed.local/clip-b.mp4';
    const [asset] = await db
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, assetUrl))
      .limit(1);
    expect(asset).toBeTruthy();
    await db
      .update(galleryItems)
      .set({ deletedAt: new Date() })
      .where(eq(galleryItems.id, asset!.id));

    try {
      const picker = await app.inject({ method: 'GET', url: '/v1/studio/clips?kind=video' });
      const pickerUrls = (picker.json() as { clips: Array<{ assetUrl: string }> }).clips.map(
        (clip) => clip.assetUrl,
      );
      const render = await app.inject({
        method: 'POST',
        url: '/v1/studio/render',
        payload: { clips: [{ url: assetUrl }], width: 1280, height: 720, fps: 30 },
      });
      const captions = await app.inject({
        method: 'POST',
        url: '/v1/studio/captions',
        payload: { clipUrl: assetUrl, language: 'ru' },
      });
      if (render.statusCode === 201) {
        createdRenders.push((render.json() as { renderId: string }).renderId);
      }

      expect.soft(pickerUrls).not.toContain(assetUrl);
      expect.soft(render.statusCode).toBe(400);
      expect.soft(render.json()).toMatchObject({ error: 'asset_not_owned', url: assetUrl });
      expect.soft(captions.statusCode).toBe(403);
      expect.soft(captions.json()).toEqual({ error: 'asset_not_owned' });
    } finally {
      await db.update(galleryItems).set({ deletedAt: null }).where(eq(galleryItems.id, asset!.id));
    }
  });

  it('rejects an expired asset in the picker and every provider-backed Studio boundary', async () => {
    const assetUrl = 'https://assets.seed.local/clip-a.mp4';
    const [asset] = await db
      .select({ id: galleryItems.id })
      .from(galleryItems)
      .where(eq(galleryItems.assetUrl, assetUrl))
      .limit(1);
    expect(asset).toBeTruthy();
    await db
      .update(galleryItems)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(galleryItems.id, asset!.id));

    try {
      const picker = await app.inject({ method: 'GET', url: '/v1/studio/clips?kind=video' });
      const pickerUrls = (picker.json() as { clips: Array<{ assetUrl: string }> }).clips.map(
        (clip) => clip.assetUrl,
      );
      const render = await app.inject({
        method: 'POST',
        url: '/v1/studio/render',
        payload: { clips: [{ url: assetUrl }], width: 1280, height: 720, fps: 30 },
      });
      const captions = await app.inject({
        method: 'POST',
        url: '/v1/studio/captions',
        payload: { clipUrl: assetUrl, language: 'ru' },
      });

      expect(pickerUrls).not.toContain(assetUrl);
      expect(render.statusCode).toBe(400);
      expect(render.json()).toMatchObject({ error: 'asset_not_owned', url: assetUrl });
      expect(captions.statusCode).toBe(403);
      expect(captions.json()).toEqual({ error: 'asset_not_owned' });
    } finally {
      await db.update(galleryItems).set({ expiresAt: null }).where(eq(galleryItems.id, asset!.id));
    }
  });

  it('kitchen-sink clip survives the API boundary byte-for-byte', async () => {
    // Every per-clip instrument at once (E1–E9), at valid in-range values.
    const clip = {
      url: 'https://assets.seed.local/clip-a.mp4',
      inSec: 0.5,
      outSec: 6,
      speed: 1.5,
      speedCurve: 'hero' as const,
      animIn: { kind: 'fade' as const, durSec: 0.4 },
      animOut: { kind: 'zoom' as const, durSec: 0.5 },
      keyframes: {
        opacity: [
          { t: 0, v: 0.2 },
          { t: 2, v: 1 },
        ],
        posX: [
          { t: 0, v: -10 },
          { t: 2, v: 10 },
        ],
        posY: [
          { t: 0, v: 0 },
          { t: 2, v: -8 },
        ],
        scale: [
          { t: 0, v: 1 },
          { t: 2, v: 2 },
        ],
        rotate: [
          { t: 0, v: 0 },
          { t: 2, v: 30 },
        ],
      },
      muted: false,
      volumeDb: -6,
      transition: 'crossfade' as const,
      transitionSec: 0.5,
      filter: 'warm' as const,
      transform: {
        scale: 1.2,
        posX: 5,
        posY: -5,
        rotate: 10,
        crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 },
      },
      color: {
        brightness: 10,
        contrast: 5,
        saturation: 15,
        temperature: 8,
        highlight: -5,
        shadow: 5,
        vignette: 20,
        grain: 10,
        curve: 'vintage' as const,
        hsl: { b: { h: 30, s: 40, l: -10 }, r: { s: -25 } },
      },
      reversed: true,
      flipH: true,
      flipV: false,
      freeze: { atSec: 1, durSec: 2 },
      mask: { shape: 'circle' as const, feather: 30, invert: true },
      opacity: 0.8,
      blendMode: 'multiply' as const,
    };

    const spec = await postRender({
      clips: [clip, { url: 'https://assets.seed.local/clip-b.mp4' }],
      overlays: [
        {
          url: 'https://assets.seed.local/pip.mp4',
          atSec: 1,
          inSec: 0,
          outSec: 3,
          scale: 0.35,
          posX: 60,
          posY: 60,
          opacity: 0.9,
          muted: true,
          gainDb: -3,
        },
      ],
      music: {
        url: 'https://assets.seed.local/music.mp3',
        gainDb: -8,
        fromSec: 0,
        fadeIn: true,
        fadeOut: true,
      },
      voiceover: {
        url: 'https://assets.seed.local/vo.mp3',
        gainDb: -2,
        fromSec: 1,
        fadeIn: true,
        fadeOut: false,
      },
      sfx: [
        { url: 'https://assets.seed.local/sfx-1.mp3', atSec: 1.5, gainDb: -6 },
        // gainDb omitted (0) — must round-trip WITHOUT a phantom gainDb.
        { url: 'https://assets.seed.local/sfx-2.mp3', atSec: 4 },
      ],
      texts: [
        {
          text: 'Привет, Seed',
          fromSec: 0,
          toSec: 2,
          position: 'bottom',
          sizeFrac: 0.08,
          font: 'serif',
          fade: true,
          plate: { color: '#101014' },
        },
      ],
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mov',
      background: { type: 'color', color: '#101014' },
      coverSec: 3.5,
    });

    // The whole clip — every advanced field included — must round-trip exactly.
    expect(spec.clips).toHaveLength(2);
    expect((spec.clips as unknown[])[0]).toEqual(clip);

    // Top-level richness the route used to drop.
    expect(spec.overlays).toEqual([
      {
        url: 'https://assets.seed.local/pip.mp4',
        atSec: 1,
        inSec: 0,
        outSec: 3,
        scale: 0.35,
        posX: 60,
        posY: 60,
        opacity: 0.9,
        muted: true,
        gainDb: -3,
      },
    ]);
    expect(spec.music).toEqual({
      url: 'https://assets.seed.local/music.mp3',
      gainDb: -8,
      fromSec: 0,
      fadeIn: true,
      fadeOut: true,
    });
    expect(spec.voiceover).toEqual({
      url: 'https://assets.seed.local/vo.mp3',
      gainDb: -2,
      fromSec: 1,
      fadeIn: true,
      fadeOut: false,
    });
    expect(spec.sfx).toEqual([
      { url: 'https://assets.seed.local/sfx-1.mp3', atSec: 1.5, gainDb: -6 },
      { url: 'https://assets.seed.local/sfx-2.mp3', atSec: 4 },
    ]);
    expect(spec.texts).toEqual([
      {
        text: 'Привет, Seed',
        fromSec: 0,
        toSec: 2,
        position: 'bottom',
        sizeFrac: 0.08,
        font: 'serif',
        fade: true,
        plate: { color: '#101014' },
      },
    ]);
    expect(spec.width).toBe(1920);
    expect(spec.height).toBe(1080);
    expect(spec.fps).toBe(30);
    expect(spec.format).toBe('mov');
    expect(spec.background).toEqual({ type: 'color', color: '#101014' });
    expect(spec.coverSec).toBe(3.5);
  });

  it('word-pop captions (popText) round-trip into the spec as their own lane', async () => {
    const spec = await postRender({
      clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
      popText: {
        font: 'display',
        sizeFrac: 0.11,
        position: 'center',
        plate: { color: '#101014' },
        words: [
          { text: 'раз', fromSec: 0, toSec: 0.5 },
          { text: 'два', fromSec: 0.5, toSec: 1 },
        ],
      },
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(spec.popText).toEqual({
      font: 'display',
      sizeFrac: 0.11,
      position: 'center',
      plate: { color: '#101014' },
      words: [
        { text: 'раз', fromSec: 0, toSec: 0.5 },
        { text: 'два', fromSec: 0.5, toSec: 1 },
      ],
    });
  });

  it('music auto-ducking (duck.db + hold windows) round-trips into the spec', async () => {
    const spec = await postRender({
      clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
      music: {
        url: 'https://assets.seed.local/music.mp3',
        gainDb: -6,
        duck: {
          db: -12,
          segments: [
            { fromSec: 1.5, toSec: 3.2 },
            { fromSec: 5, toSec: 6.4 },
          ],
        },
      },
      voiceover: { url: 'https://assets.seed.local/vo.mp3' },
      width: 1080,
      height: 1920,
      fps: 30,
    });
    expect(spec.music).toEqual({
      url: 'https://assets.seed.local/music.mp3',
      gainDb: -6,
      duck: {
        db: -12,
        segments: [
          { fromSec: 1.5, toSec: 3.2 },
          { fromSec: 5, toSec: 6.4 },
        ],
      },
    });
  });

  it('rejects a duck db above 0 dB (ducking only attenuates)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: {
        clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
        music: {
          url: 'https://assets.seed.local/music.mp3',
          duck: { db: 3, segments: [{ fromSec: 0, toSec: 1 }] },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a popText word longer than 40 chars (abuse guard runs)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: {
        clips: [{ url: 'https://assets.seed.local/x.mp4' }],
        popText: { words: [{ text: 'x'.repeat(41), fromSec: 0, toSec: 1 }] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('the once-dropped advanced fields survive even with no basic fields set', async () => {
    // The exact P0 regression: a clip carrying ONLY advanced instruments.
    const advancedOnly = {
      url: 'https://assets.seed.local/advanced.mp4',
      transform: { scale: 1.4, rotate: 12 },
      color: { brightness: 20, saturation: 25 },
      reversed: true,
      flipH: true,
      flipV: true,
      freeze: { atSec: 0.5, durSec: 1.5 },
      speedCurve: 'montage' as const,
      animIn: { kind: 'slide' as const, durSec: 0.6 },
      animOut: { kind: 'fade' as const, durSec: 0.6 },
      keyframes: {
        opacity: [
          { t: 0, v: 0 },
          { t: 1, v: 1 },
        ],
      },
      // Freeform pen mask — the normalized polygon must survive the route→DB→spec
      // round-trip intact (no vertex drop, no coercion).
      mask: {
        shape: 'freeform' as const,
        feather: 25,
        points: [
          { x: 0.2, y: 0.15 },
          { x: 0.8, y: 0.2 },
          { x: 0.65, y: 0.9 },
          { x: 0.25, y: 0.75 },
        ],
      },
    };
    const spec = await postRender({ clips: [advancedOnly], width: 1080, height: 1920, fps: 24 });
    expect((spec.clips as unknown[])[0]).toEqual(advancedOnly);
  });

  it('legacy single `audio` line is preserved (back-compat path)', async () => {
    const spec = await postRender({
      clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
      audio: { url: 'https://assets.seed.local/legacy.mp3', gainDb: -4 },
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(spec.audio).toEqual({ url: 'https://assets.seed.local/legacy.mp3', gainDb: -4 });
  });

  it('BL-4: rejects an SFX URL the user does not own (SSRF guard covers sfx)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: {
        clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
        sfx: [{ url: 'https://evil.example/boom.mp3', atSec: 1 }],
        width: 1280,
        height: 720,
        fps: 30,
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: string; url?: string };
    expect(body.error).toBe('asset_not_owned');
    expect(body.url).toBe('https://evil.example/boom.mp3');
  });

  it('accepts true portrait UHD but rejects output larger than one UHD frame', async () => {
    const portrait = await postRender({
      clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
      width: 2160,
      height: 3840,
      fps: 24,
    });
    expect({ width: portrait.width, height: portrait.height }).toEqual({
      width: 2160,
      height: 3840,
    });

    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: {
        clips: [{ url: 'https://assets.seed.local/clip.mp4' }],
        width: 3840,
        height: 3840,
      },
    });
    expect(oversized.statusCode).toBe(400);
    expect((oversized.json() as { error: string }).error).toBe('invalid_body');
  });

  it('rejects an out-of-range field instead of silently coercing it', async () => {
    // scale max is 3 — proves validation runs at the boundary (no silent drop
    // of the guard either).
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: { clips: [{ url: 'https://assets.seed.local/x.mp4', transform: { scale: 99 } }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('rejects unsupported blur backgrounds until the worker can render them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/render',
      payload: {
        clips: [{ url: 'https://assets.seed.local/x.mp4' }],
        background: { type: 'blur' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('keeps Studio AI voice disabled until its pricing contract is approved', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/studio/tts',
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(410);
    expect((empty.json() as { error: string }).error).toBe('studio_tts_disabled');

    const normal = await app.inject({
      method: 'POST',
      url: '/v1/studio/tts',
      payload: { text: 'Привет, это озвучка.' },
    });
    expect(normal.statusCode).toBe(410);
    expect((normal.json() as { error: string }).error).toBe('studio_tts_disabled');
  });
});
