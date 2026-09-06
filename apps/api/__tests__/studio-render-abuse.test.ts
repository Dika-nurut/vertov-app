import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type IORedis from 'ioredis';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  galleryItems,
  nid,
  outboxJobs,
  pool,
  studioRenders,
  usersApp,
  usersPii,
} from '@seed/db';
import { setupStudioRoutes } from '../src/studio';

/**
 * BL-2 + BL-4 — studio render is an unmetered ffmpeg farm fed arbitrary URLs.
 *
 * Pre-fix, `POST /v1/studio/render` had NO submit throttle, NO per-user
 * in-flight cap, NO duration ceiling, and validated clip/audio/overlay URLs
 * only as `z.string().url()` — so anyone could flood the 2-slot ffmpeg pool, or
 * make the worker `ffmpeg -i` an internal/arbitrary URL (SSRF). These tests are
 * the blocked exploits; each fails on the pre-fix handler.
 */

// Deterministic asset origin so studio-owned URLs are predictable. https keeps
// publicBase from falling back (no mixed-content rewrite). Set before setup.
const ASSET_ORIGIN = 'https://assets.seed.test';
const ASSET_BUCKET = process.env.MINIO_BUCKET ?? 'seed-assets';

/** In-memory eval (atomic INCR) Redis subset — same shape as the enhancer tests. */
function makeRedisStub(): IORedis {
  const store = new Map<string, number>();
  return {
    async eval(_script: string, _numKeys: number, key: string) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as IORedis;
}

const createdUsers: string[] = [];
const createdRenders: string[] = [];

async function makeUser(): Promise<string> {
  const id = nid();
  await db.insert(usersApp).values({ id, displayName: 'RenderAbuse', locale: 'ru' });
  await db.insert(usersPii).values({ id, email: `render-abuse+${id}@seed.local` });
  createdUsers.push(id);
  return id;
}

let app: FastifyInstance;
let currentUser: string;
let currentIsAnonymous = false;

beforeAll(async () => {
  process.env.ASSET_PUBLIC_URL = ASSET_ORIGIN;
  process.env.STUDIO_MAX_INFLIGHT_RENDERS = '3';
  delete process.env.STUDIO_MAX_RENDER_SECONDS; // use the 1800s default
  currentUser = await makeUser();
  app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  // A mutable session so each concern can act as a fresh user (isolated Redis
  // rate-counter + in-flight count) against one app instance.
  setupStudioRoutes(
    app,
    async () => ({ user: { id: currentUser, isAnonymous: currentIsAnonymous } }),
    { redis: makeRedisStub() },
  );
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
    await db.delete(galleryItems).where(eq(galleryItems.userId, id));
    await db.delete(usersPii).where(eq(usersPii.id, id));
    await db.delete(usersApp).where(eq(usersApp.id, id));
  }
  await pool.end();
});

const ownedUrl = (user: string, name: string): string =>
  `${ASSET_ORIGIN}/${ASSET_BUCKET}/${user}/${name}`;

async function post(payload: unknown) {
  return app.inject({ method: 'POST', url: '/v1/studio/render', payload });
}

describe('BL-4: render URLs must be owned (SSRF)', () => {
  it('rejects a clip URL on an arbitrary external origin', async () => {
    currentUser = await makeUser();
    const res = await post({
      clips: [{ url: 'https://evil.example.com/steal.mp4' }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('asset_not_owned');
  });

  it('rejects an internal/link-local metadata URL', async () => {
    currentUser = await makeUser();
    const res = await post({
      clips: [{ url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('asset_not_owned');
  });

  it('rejects when a non-owned URL hides among owned clips (overlay/audio too)', async () => {
    const user = await makeUser();
    currentUser = user;
    await db
      .insert(galleryItems)
      .values({ id: nid(), userId: user, assetUrl: ownedUrl(user, 'a.mp4'), kind: 'video' });
    const res = await post({
      clips: [{ url: ownedUrl(user, 'a.mp4') }],
      // a non-owned audio line must still be caught
      music: { url: 'https://cdn.evil.test/track.mp3' },
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('asset_not_owned');
  });

  it('accepts a render whose every URL is an own studio asset', async () => {
    const user = await makeUser();
    currentUser = user;
    const res = await post({
      clips: [{ url: ownedUrl(user, 'clip.mp4'), inSec: 0, outSec: 5 }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode, res.body).toBe(201);
    createdRenders.push((res.json() as { renderId: string }).renderId);
  });
});

describe('Guest-CJM: render requires a real account', () => {
  it('rejects an anonymous («Гость») session with 403 signup_required, no row written', async () => {
    const user = await makeUser();
    currentUser = user;
    currentIsAnonymous = true;
    try {
      const res = await post({
        clips: [{ url: ownedUrl(user, 'clip.mp4'), inSec: 0, outSec: 5 }],
        width: 1280,
        height: 720,
        fps: 30,
      });
      expect(res.statusCode, res.body).toBe(403);
      expect((res.json() as { error: string }).error).toBe('signup_required');
      const rows = await db
        .select({ id: studioRenders.id })
        .from(studioRenders)
        .where(eq(studioRenders.userId, user));
      expect(rows.length).toBe(0); // nothing enqueued
    } finally {
      currentIsAnonymous = false;
    }
  });
});

describe('BL-2: render is metered', () => {
  it('rejects an over-duration timeline before enqueue (400, no row written)', async () => {
    const user = await makeUser();
    currentUser = user;
    const before = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    // One clip declaring 3600s output — over the 1800s default ceiling.
    const res = await post({
      clips: [{ url: ownedUrl(user, 'long.mp4'), inSec: 0, outSec: 3600 }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('render_too_long');
    const after = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    expect(after.length).toBe(before.length); // nothing enqueued
  });

  it('catches the speed-ramp amplification of a short trim', async () => {
    const user = await makeUser();
    currentUser = user;
    // 600s trim at 0.25× = 2400s output > 1800s ceiling.
    const res = await post({
      clips: [{ url: ownedUrl(user, 'slow.mp4'), inSec: 0, outSec: 600, speed: 0.25 }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('render_too_long');
  });

  it('catches a speedCurve that inflates duration past what `speed` declares', async () => {
    const user = await makeUser();
    currentUser = user;
    // The bypass: `speed:4` makes the old guard declare 3600/4 = 900s (< 1800),
    // but the worker IGNORES speed when a curve is set and renders the `flash`
    // ramp — 3600 × 1.292 ≈ 4650s. The guard must count the curve, not the speed.
    const before = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    const res = await post({
      clips: [
        { url: ownedUrl(user, 'long.mp4'), inSec: 0, outSec: 3600, speed: 4, speedCurve: 'flash' },
      ],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('render_too_long');
    const after = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    expect(after.length).toBe(before.length); // nothing enqueued
  });

  it('counts UPPER-TRACK clips in the duration guard (no bypass via tracks[])', async () => {
    const user = await makeUser();
    currentUser = user;
    // A 1s base clip declares 1s, but an upper-track clip {outSec:3600, speed:4,
    // speedCurve:'flash'} makes the worker normalize ~4650s of ProRes. The guard
    // must count upper-track clips too, not just d.clips.
    const before = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    const res = await post({
      clips: [{ url: ownedUrl(user, 'base.mp4'), inSec: 0, outSec: 1 }],
      tracks: [
        [
          {
            url: ownedUrl(user, 'upper.mp4'),
            inSec: 0,
            outSec: 3600,
            speed: 4,
            speedCurve: 'flash',
          },
        ],
      ],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('render_too_long');
    const after = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    expect(after.length).toBe(before.length);
  });

  it('rejects a degenerate aspect ratio the worker cannot fit without distortion', async () => {
    const user = await makeUser();
    currentUser = user;
    // 3840×64 is schema-valid (64–3840 per axis) but 60:1 — the worker's 1920 cap
    // + 64px floor can't preserve that ratio, so it must be rejected up front
    // rather than rendered as a stretched 1920×64.
    const before = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    const res = await post({
      clips: [{ url: ownedUrl(user, 'a.mp4'), inSec: 0, outSec: 5 }],
      width: 3840,
      height: 64,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('render_bad_aspect');
    const after = await db
      .select({ id: studioRenders.id })
      .from(studioRenders)
      .where(eq(studioRenders.userId, user));
    expect(after.length).toBe(before.length);
  });

  it('accepts a normal wide aspect ratio (16:9 4K downscales, not rejected)', async () => {
    const user = await makeUser();
    currentUser = user;
    const res = await post({
      clips: [{ url: ownedUrl(user, 'a.mp4'), inSec: 0, outSec: 5 }],
      width: 3840,
      height: 2160,
      fps: 30,
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects more than 12 upper-track clips (worker cap) instead of dropping the tail', async () => {
    const user = await makeUser();
    currentUser = user;
    const thirteen = Array.from({ length: 13 }, (_, i) => ({
      url: ownedUrl(user, `t${i}.mp4`),
      inSec: 0,
      outSec: 2,
      startSec: i,
    }));
    const res = await post({
      clips: [{ url: ownedUrl(user, 'base.mp4'), inSec: 0, outSec: 5 }],
      tracks: [thirteen],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('too_many_track_clips');
  });

  it('rejects a speedCurve / animOut clip with no trim bounds (silent no-op guard)', async () => {
    const user = await makeUser();
    currentUser = user;
    const curve = await post({
      clips: [{ url: ownedUrl(user, 'a.mp4'), speedCurve: 'hero' }], // no outSec
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(curve.statusCode).toBe(400);
    expect((curve.json() as { error: string }).error).toBe('invalid_body');
    const anim = await post({
      clips: [{ url: ownedUrl(user, 'a.mp4'), animOut: { kind: 'fade', durSec: 1 } }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(anim.statusCode).toBe(400);
  });

  it('rejects a freeform mask with fewer than 3 points', async () => {
    const user = await makeUser();
    currentUser = user;
    const res = await post({
      clips: [
        {
          url: ownedUrl(user, 'a.mp4'),
          inSec: 0,
          outSec: 5,
          mask: { shape: 'freeform', points: [{ x: 0.5, y: 0.5 }] },
        },
      ],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_body');
  });

  it('strips mask/blend/keyframes/anims from upper-track clips (static overlays only)', async () => {
    const user = await makeUser();
    currentUser = user;
    const res = await post({
      clips: [{ url: ownedUrl(user, 'base.mp4'), inSec: 0, outSec: 5 }],
      tracks: [
        [
          {
            url: ownedUrl(user, 'top.mp4'),
            inSec: 0,
            outSec: 3,
            startSec: 0,
            opacity: 0.5,
            transform: { scale: 1.2, posX: 10 },
            mask: { shape: 'circle' },
            blendMode: 'multiply',
            keyframes: {
              opacity: [
                { t: 0, v: 0 },
                { t: 1, v: 1 },
              ],
            },
            animIn: { kind: 'fade', durSec: 0.5 },
            animOut: { kind: 'slide', durSec: 0.5 },
          },
        ],
      ],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode, res.body).toBe(201);
    const renderId = (res.json() as { renderId: string }).renderId;
    createdRenders.push(renderId);
    const [row] = await db
      .select({ spec: studioRenders.spec })
      .from(studioRenders)
      .where(eq(studioRenders.id, renderId));
    const trackClip = (row!.spec as { tracks: Record<string, unknown>[][] }).tracks[0]![0]!;
    // The alpha-layer-unsafe instruments are dropped...
    for (const dropped of ['mask', 'blendMode', 'keyframes', 'animIn', 'animOut']) {
      expect(trackClip[dropped], `${dropped} should be stripped`).toBeUndefined();
    }
    // ...but static instruments survive.
    expect(trackClip.opacity).toBe(0.5);
    expect(trackClip.transform).toEqual({ scale: 1.2, posX: 10 });
  });

  it('caps simultaneous in-flight renders per user (429)', async () => {
    const user = await makeUser();
    currentUser = user;
    // Seed the cap's worth of active renders directly.
    for (let i = 0; i < 3; i++) {
      const id = nid();
      createdRenders.push(id);
      await db.insert(studioRenders).values({
        id,
        userId: user,
        status: i === 0 ? 'running' : 'queued',
        spec: { clips: [{ url: ownedUrl(user, `seed-${i}.mp4`) }], width: 1280, height: 720 },
      });
    }
    const res = await post({
      clips: [{ url: ownedUrl(user, 'extra.mp4'), inSec: 0, outSec: 5 }],
      width: 1280,
      height: 720,
      fps: 30,
    });
    expect(res.statusCode).toBe(429);
    expect((res.json() as { error: string }).error).toBe('too_many_active_renders');
  });

  it('throttles submit rate per user (429 rate_limit_exceeded)', async () => {
    const user = await makeUser();
    currentUser = user;
    // Use a non-owned URL so each call is cheap (rejected at ownership, after
    // the rate counter ticks) and never creates an in-flight render.
    const payload = {
      clips: [{ url: 'https://not-owned.test/x.mp4' }],
      width: 1280,
      height: 720,
      fps: 30,
    };
    let last = await post(payload);
    for (let i = 0; i < 10; i++) last = await post(payload); // 11 total → trips the 10/min cap
    expect(last.statusCode).toBe(429);
    expect((last.json() as { error: string }).error).toBe('rate_limit_exceeded');
  });
});

describe('UPL-1: studio uploads are typed and throttled', () => {
  it('rejects 51 MiB on the actual audio route even though the shared parser allows 64 MiB', async () => {
    currentUser = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/upload-audio?ext=mp3',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(51 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
  });

  it('rejects a generic upload whose bytes do not match the declared image extension', async () => {
    currentUser = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/upload?ext=png',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not a png'),
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: string }).error).toBe('invalid_media_type');
  });

  it('rejects an audio upload whose bytes do not match the declared audio extension', async () => {
    currentUser = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/studio/upload-audio?ext=mp3',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not an mp3'),
    });
    expect(res.statusCode).toBe(415);
    expect((res.json() as { error: string }).error).toBe('invalid_media_type');
  });

  it('throttles repeated multipart upload init calls per user', async () => {
    currentUser = await makeUser();
    let last = await app.inject({
      method: 'POST',
      url: '/v1/studio/upload/init',
      payload: { ext: 'mp4', size: 1024 },
    });
    for (let i = 0; i < 30; i++) {
      last = await app.inject({
        method: 'POST',
        url: '/v1/studio/upload/init',
        payload: { ext: 'mp4', size: 1024 },
      });
    }
    expect(last.statusCode).toBe(429);
    expect((last.json() as { error: string }).error).toBe('rate_limit_exceeded');
  });
});
