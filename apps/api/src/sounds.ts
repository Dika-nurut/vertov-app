import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { Client as MinioClient } from 'minio';
import { z } from 'zod';
import { checkPerUserRateLimit } from './prompt-enhancer';
import { egressFetch } from './egress-fetch';
import { resolveS3ClientOptions } from './s3-config';
import { isSafeReferenceUrl } from './safe-ref-url';

/**
 * Audio catalog proxy for /studio: search Freesound (CC0) for both `sfx` and
 * `music` and copy a picked track into the caller's own storage so the
 * render worker only ever touches user-owned assets (BL-4 invariant, mirrors
 * studio.ts).
 *
 * Pixabay verdict (researched 2026-07-12, see WebFetch/WebSearch of
 * https://pixabay.com/api/docs/): the public REST API documents ONLY image
 * and video search (`/api/` and `/api/videos/`) — no audio/music search
 * endpoint exists (Pixabay Music is a browse-only web catalog, not part of
 * the API). So `kind=music` now reuses the same Freesound catalog as `sfx`,
 * just with a music-oriented filter (longer duration, `tag:music`) instead
 * of guessing at a Pixabay endpoint that doesn't exist.
 */

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null | undefined } } | null>;

export interface SoundItem {
  id: string;
  title: string;
  author: string;
  durSec: number;
  previewUrl: string;
  license: string;
  source: 'freesound';
}

// Search is free browsing (no provider spend beyond the request itself) — a
// generous cap, same class as captions. Pick writes to storage, so it's
// tighter.
const SEARCH_RATE_LIMIT_MAX = 30;
const PICK_RATE_LIMIT_MAX = 15;
const FETCH_TIMEOUT_MS = 8_000;
// Pick downloads a Freesound preview (never a full track — see below); cap
// well above a 30s preview mp3 but far under a real audio file, as an abuse
// guard against a compromised/rogue provider response.
const MAX_PICK_BYTES = 15 * 1024 * 1024;
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

const searchQuerySchema = z.object({
  kind: z.enum(['music', 'sfx']),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).max(20).default(1),
});

const pickBodySchema = z.object({
  kind: z.enum(['music', 'sfx']),
  id: z.string().max(40).regex(PROVIDER_ID_RE),
});

/** egressFetch has no built-in timeout; arm an AbortController so a hung provider
 * can't hold a request/rate-limit slot open indefinitely. The deadline must cover
 * the BODY read, not just the headers — a provider that returns headers fast then
 * drips a sub-cap body byte-by-byte would otherwise hold the slot forever. So the
 * signal stays armed until the caller calls `done()` (in a finally, AFTER reading
 * the body); a slow-drip body then trips the abort mid-read.
 *
 * `redirect: 'manual'` is a second SSRF layer: `isAllowedPreviewUrl` pins the
 * INITIAL URL to freesound.org, but the default `follow` mode would chase a
 * `302 Location: http://169.254.169.254/…` WITHOUT re-validating the new host.
 * Freesound serves its API + previews directly (no redirect in practice), so
 * failing closed on any 3xx (it surfaces as a non-ok response the callers reject)
 * costs nothing and closes the redirect-based SSRF bypass. */
function fetchWithDeadline(
  url: string,
  init: RequestInit,
  ms = FETCH_TIMEOUT_MS,
): { res: Promise<Response>; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const res = egressFetch(url, { redirect: 'manual', ...init, signal: ctrl.signal });
  return { res, done: () => clearTimeout(timer) };
}

interface FreesoundPreviews {
  'preview-hq-mp3'?: string;
  'preview-lq-mp3'?: string;
}
interface FreesoundSound {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  previews: FreesoundPreviews;
}
interface FreesoundSearchResponse {
  next: string | null;
  results: FreesoundSound[];
}

/** SSRF guard: the preview URL comes from Freesound's own response and is
 * fetched server-side, so it must be pinned to Freesound's host before we
 * ever hand it to fetch. Two layers: the house SF-8 primitive
 * (`isSafeReferenceUrl`, blocks non-http(s) schemes and private/loopback/
 * link-local/CGNAT IPs — see safe-ref-url.ts), plus a narrow allowlist on
 * top since the only legit source here is Freesound itself — https +
 * freesound.org (or a subdomain, e.g. cdn.freesound.org) only. */
function isAllowedPreviewUrl(raw: string): boolean {
  if (!isSafeReferenceUrl(raw, [])) return false;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'freesound.org' || u.hostname.endsWith('.freesound.org');
  } catch {
    return false;
  }
}

// Freesound's CC0 license URL, e.g. "http://creativecommons.org/publicdomain/zero/1.0/".
const CC0_LICENSE_MATCH = 'creativecommons.org/publicdomain/zero';
function isCC0License(license: string): boolean {
  return license.includes(CC0_LICENSE_MATCH);
}

function toSoundItem(s: FreesoundSound): SoundItem | null {
  const previewUrl = s.previews?.['preview-hq-mp3'] ?? s.previews?.['preview-lq-mp3'];
  if (!previewUrl) return null; // no usable preview — drop rather than return a dead link
  if (!isAllowedPreviewUrl(previewUrl)) return null; // same treatment as no-preview: drop
  return {
    id: String(s.id),
    title: s.name,
    author: s.username,
    durSec: Math.round(s.duration * 10) / 10,
    previewUrl,
    license: s.license,
    source: 'freesound',
  };
}

// sfx: short one-shots (≤30s). music: longer background tracks, tagged music.
const FREESOUND_FILTERS: Record<'music' | 'sfx', string> = {
  sfx: 'license:"Creative Commons 0" duration:[0 TO 30]',
  music: 'license:"Creative Commons 0" duration:[30 TO 600] tag:music',
};

async function searchFreesound(
  kind: 'music' | 'sfx',
  q: string | undefined,
  page: number,
): Promise<{ items: SoundItem[]; nextPage: number | null }> {
  const token = process.env.FREESOUND_API_KEY;
  if (!token) throw Object.assign(new Error('catalog_unconfigured'), { code: 'unconfigured' });
  const params = new URLSearchParams({
    query: q ?? '',
    filter: FREESOUND_FILTERS[kind],
    sort: 'rating_desc',
    fields: 'id,name,username,license,duration,previews',
    page: String(page),
    page_size: '20',
  });
  const { res, done } = fetchWithDeadline(`https://freesound.org/apiv2/search/text/?${params}`, {
    headers: { Authorization: `Token ${token}` },
  });
  let data: FreesoundSearchResponse;
  try {
    const r = await res;
    if (!r.ok) throw Object.assign(new Error(`freesound ${r.status}`), { code: 'upstream' });
    data = (await r.json()) as FreesoundSearchResponse; // deadline still covers this read
  } finally {
    done();
  }
  const items = data.results.map(toSoundItem).filter((x): x is SoundItem => x !== null);
  return { items, nextPage: data.next ? page + 1 : null };
}

/** Streamed read capped at `cap` bytes — guards against a chunked response
 * with no content-length buffering unbounded via arrayBuffer(). Cancels the
 * reader and returns null the moment the running byte count exceeds cap. */
async function readCapped(r: Response, cap: number): Promise<Buffer | null> {
  const reader = r.body?.getReader();
  if (!reader) return Buffer.from(await r.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** True if the response's Content-Type declares audio, or the buffer starts
 * with a real MP3 frame sync (0xFF + high nibble 0xE/0xF) or an ID3 tag —
 * same signature check studio.ts uses for uploads (kept local, no import, to
 * preserve this file's no-coupling-to-studio.ts stance noted above). */
function looksLikeMp3(contentType: string | null, buf: Buffer): boolean {
  if (contentType?.startsWith('audio/')) return true;
  if (buf.toString('ascii', 0, 3) === 'ID3') return true;
  return buf.length >= 2 && buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0;
}

/** Sound detail — used by /pick to resolve a provider id to a preview URL +
 * display metadata (title/author/license/duration), independent of whatever
 * page the client last saw in search results. */
async function freesoundDetail(id: string): Promise<FreesoundSound> {
  const token = process.env.FREESOUND_API_KEY;
  if (!token) throw Object.assign(new Error('catalog_unconfigured'), { code: 'unconfigured' });
  const params = new URLSearchParams({ fields: 'id,name,username,license,duration,previews' });
  const { res, done } = fetchWithDeadline(`https://freesound.org/apiv2/sounds/${id}/?${params}`, {
    headers: { Authorization: `Token ${token}` },
  });
  try {
    const r = await res;
    if (r.status === 404) throw Object.assign(new Error('not_found'), { code: 'not_found' });
    if (!r.ok) throw Object.assign(new Error(`freesound ${r.status}`), { code: 'upstream' });
    return (await r.json()) as FreesoundSound; // deadline still covers this read
  } finally {
    done();
  }
}

export function setupSoundsRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  opts: { redis?: IORedis; minio?: MinioClient } = {},
): void {
  const minioEndpoint = process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000';
  const bucket = process.env.MINIO_BUCKET ?? 'seed-assets';
  // Same mixed-content-safe public base derivation as studio.ts (asset-src
  // same-origin invariant) — duplicated rather than imported so this file has
  // no coupling to studio.ts's internals; keep the two in sync if it changes.
  const apiPublic = process.env.API_PUBLIC_URL?.replace(/\/$/, '');
  const assetPublic = process.env.ASSET_PUBLIC_URL?.replace(/\/$/, '');
  const mixedContentBlocked =
    !!assetPublic && assetPublic.startsWith('http://') && !!apiPublic?.startsWith('https://');
  const publicBase = (
    (assetPublic && !mixedContentBlocked ? assetPublic : undefined) ??
    apiPublic ??
    process.env.MINIO_PUBLIC_URL ??
    minioEndpoint
  ).replace(/\/$/, '');
  const minio = opts.minio ?? new MinioClient(resolveS3ClientOptions(process.env));

  const checkRate = async (
    reply: FastifyReply,
    userId: string,
    bucketName: string,
    max: number,
  ): Promise<boolean> => {
    if (!opts.redis) return true;
    const rl = await checkPerUserRateLimit(opts.redis, userId, bucketName, max);
    reply.header('x-ratelimit-limit', String(max));
    reply.header('x-ratelimit-remaining', String(rl.remaining));
    if (!rl.allowed) {
      reply.status(429).send({ error: 'rate_limit_exceeded' });
      return false;
    }
    return true;
  };

  // Browsing is free in the guest model — the wall is at spend (pick), not
  // search — so anonymous sessions ARE allowed here.
  app.get<{ Querystring: { kind?: string; q?: string; page?: string } }>(
    '/v1/studio/sounds/search',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;
      if (!(await checkRate(reply, session.user.id, 'sounds-search', SEARCH_RATE_LIMIT_MAX)))
        return;

      const parsed = searchQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_query' });
      const { kind, q, page } = parsed.data;

      try {
        const { items, nextPage } = await searchFreesound(kind, q, page);
        return { items, nextPage };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'unconfigured') {
          return reply.status(503).send({ error: 'catalog_unconfigured', provider: 'freesound' });
        }
        req.log.error({ err }, 'sounds: freesound search failed');
        return reply.status(502).send({ error: 'catalog_search_failed' });
      }
    },
  );

  // Pick writes to the caller's own storage — same wall shape as
  // /v1/studio/render: anonymous («Гость») sessions are blocked.
  app.post('/v1/studio/sounds/pick', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    if (session.user.isAnonymous) {
      return reply.status(403).send({ error: 'signup_required' });
    }
    if (!(await checkRate(reply, session.user.id, 'sounds-pick', PICK_RATE_LIMIT_MAX))) return;

    const parsed = pickBodySchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_body' });
    const { kind, id } = parsed.data;

    let detail: FreesoundSound;
    try {
      detail = await freesoundDetail(id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'unconfigured') {
        return reply.status(503).send({ error: 'catalog_unconfigured', provider: 'freesound' });
      }
      if (code === 'not_found') return reply.status(404).send({ error: 'not_found' });
      req.log.error({ err, id }, 'sounds: freesound detail failed');
      return reply.status(502).send({ error: 'catalog_fetch_failed' });
    }
    if (!isCC0License(detail.license)) {
      return reply.status(403).send({ error: 'license_not_allowed' });
    }
    const previewUrl = detail.previews?.['preview-hq-mp3'] ?? detail.previews?.['preview-lq-mp3'];
    if (!previewUrl) return reply.status(502).send({ error: 'no_preview' });
    if (!isAllowedPreviewUrl(previewUrl)) {
      return reply.status(502).send({ error: 'preview_rejected' });
    }

    const key = `${session.user.id}/audio/catalog-${kind}-${id}.mp3`;

    // Dedup: skip the (re-)download+upload when this user already picked this
    // id before, but metadata is refetched every call above so a cache hit
    // still returns fresh title/author/license/duration.
    let cached = false;
    try {
      await minio.statObject(bucket, key);
      cached = true;
    } catch {
      /* not cached — download below */
    }

    if (!cached) {
      // Full downloads require Freesound OAuth2 (out of scope for this MVP);
      // the preview-hq-mp3 is the pragmatic source — same quality tier the
      // search results already showed the user.
      let buf: Buffer;
      let contentType: string | null;
      const { res, done } = fetchWithDeadline(previewUrl, {});
      try {
        const r = await res;
        if (!r.ok) return reply.status(502).send({ error: 'preview_fetch_failed' });
        contentType = r.headers.get('content-type');
        const declaredLen = Number(r.headers.get('content-length') ?? '0');
        if (declaredLen > MAX_PICK_BYTES) {
          return reply.status(413).send({ error: 'preview_too_large' });
        }
        // The deadline is still armed, so a slow-drip body trips the abort here.
        const capped = await readCapped(r, MAX_PICK_BYTES);
        if (capped === null) {
          return reply.status(413).send({ error: 'preview_too_large' });
        }
        buf = capped;
      } catch (err) {
        req.log.error({ err, id }, 'sounds: preview download failed');
        return reply.status(502).send({ error: 'preview_fetch_failed' });
      } finally {
        done();
      }
      // Validate BEFORE any storage write — the object key is deterministic and
      // a stat-hit is treated as cache-forever below, so a CDN error page or
      // truncated payload written once would poison every future pick for this
      // id. Validating the in-memory buffer up front means there's no staging
      // key / promote step to build: a rejected buffer never touches storage.
      if (!looksLikeMp3(contentType, buf)) {
        req.log.error({ id }, 'sounds: preview payload failed audio signature check');
        return reply.status(502).send({ error: 'invalid_audio' });
      }
      // Cache hits above (statObject success) are trusted unconditionally and
      // NOT re-validated here — re-checking every hit would mean re-downloading
      // on every pick, defeating the cache. That's safe only because writes are
      // now validated at write-time (this block); pre-fix cache entries could
      // still be bad, but re-validating retroactively isn't attempted.
      await minio.putObject(bucket, key, buf, buf.length, { 'Content-Type': 'audio/mpeg' });
    }

    return {
      url: `${publicBase}/${bucket}/${key}`,
      name: detail.name,
      durSec: Math.round(detail.duration * 10) / 10,
      license: detail.license,
      author: detail.username,
      source: 'freesound' as const,
    };
  });
}
