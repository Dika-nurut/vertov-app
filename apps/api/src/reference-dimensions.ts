import type { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { resolveS3ClientOptions } from './s3-config';

/**
 * O-6 — pre-reservation reference dimension preflight.
 *
 * On 2026-07-29 a production job attached a 6336px-wide Nano Banana Pro
 * reference to a kie-pinned Seedance r2v job, waited 548 seconds in queue, and
 * then failed with the vendor's own one-line reason — `Width must be between
 * 300px and 6000px`. The check is instant and free (the dimensions are in the
 * image header), so the failure should never have reached the vendor. This
 * module reads at most 128 KiB from the user's own object and refuses the job
 * BEFORE the credit reservation with the vendor's real numbers in the message.
 *
 * Deliberate posture (mirrors the §O rule in launch-backlog.md): a route
 * capability may record *unverified*, never *absent*. `referenceMaxDimension`
 * is therefore set ONLY on rows whose serving legs' documented pixel ceiling
 * we hold; rows without it are not validated, exactly as today.
 *
 * Failure posture: the probe is best-effort for formats we cannot parse and
 * FAIL-CLOSED for own-object read errors — a storage outage must not silently
 * wave through an unvalidated reference (the vendor failure mode this exists
 * to prevent is exactly what an unvalidated read would reproduce). Unknown
 * containers are allowed through so the bounded parser cannot become a false
 * rejection for a format we do not yet decode.
 *
 * Scope guard: only the authenticated user's own key prefix inside the
 * configured asset origins is read — the guard is never an SSRF probe or a
 * cross-user object oracle.
 */

export interface ReferenceDimensions {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'avif';
}

export type ReferenceProbeResult =
  | { status: 'dimensions'; dimensions: ReferenceDimensions }
  | { status: 'skipped' }
  | { status: 'unknown' }
  | { status: 'unavailable'; reason: string };

/** Injectable object reader — production wires MinIO; tests stub it. */
export type ReferenceObjectReader = (
  bucket: string,
  key: string,
  offset: number,
  length: number,
) => Promise<Readable | null>;

export type ReferenceDimensionProbe = (
  url: string,
  userId: string,
) => Promise<ReferenceProbeResult>;

export interface ReferenceCandidate {
  /** One-based index in send order, for the user-facing message. */
  index: number;
  url: string;
}

/** Param keys that carry image references the adapters actually send. */
const IMAGE_URL_PARAM_KEYS = ['imageUrls'] as const;

const PROBE_MAX_BYTES = 128 * 1024;

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

/**
 * Parse canvas dimensions from a leading byte slice: PNG (IHDR), JPEG (SOF
 * walk), WebP (VP8/VP8L/VP8X), GIF (logical screen descriptor), AVIF/HEIF
 * (ispe box). Returns null when the slice is truncated mid-header or the
 * container is unknown — callers treat that as "cannot know" and allow.
 */
export function parseImageReferenceDimensions(bytes: Uint8Array): ReferenceDimensions | null {
  // PNG: 8-byte signature, then IHDR: 4 len + 4 'IHDR' + 4 width + 4 height (BE).
  if (bytes.length >= 24 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (readUint32BE(bytes, 8) < 13 || readUint32BE(bytes, 12) !== 0x49484452) return null;
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    if (width === 0 || height === 0) return null;
    return { width, height, format: 'png' };
  }

  // GIF: 'GIF87a'/'GIF89a' + 4-byte LE logical screen descriptor.
  if (
    bytes.length >= 10 &&
    (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
      startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
  ) {
    const width = readUint16LE(bytes, 6);
    const height = readUint16LE(bytes, 8);
    if (width === 0 || height === 0) return null;
    return { width, height, format: 'gif' };
  }

  // AVIF/HEIF: ISO-BMFF — 'ftyp' brand, then walk top-level boxes. The ispe
  // property normally lives in meta/iprp/ipco, but a stripped/partial object
  // (and this module's own test fixture) can carry it at the top level.
  if (bytes.length >= 12 && startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    const dims = parseIsoBmffPrimaryItemProperties(bytes);
    return dims ? { ...dims, format: 'avif' } : null;
  }

  // WebP: 'RIFF' + size + 'WEBP', then chunk.
  if (
    bytes.length >= 30 &&
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    const fourcc = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (fourcc === 'VP8 ') {
      // Lossy VP8 bitstream: 3-byte frame header, 24-bit start code 0x9d 0x01 0x2a,
      // then 14-bit width / 14-bit height (LE, 2 bits scale each).
      if (bytes.length < 30) return null;
      const width = readUint16LE(bytes, 26) & 0x3fff;
      const height = readUint16LE(bytes, 28) & 0x3fff;
      if (width === 0 || height === 0) return null;
      return { width, height, format: 'webp' };
    }
    if (fourcc === 'VP8L') {
      // Lossless: 1-byte signature 0x2f, then 14-bit width-1 / height-1 packed LE.
      if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
      const b0 = bytes[21] ?? 0;
      const b1 = bytes[22] ?? 0;
      const b2 = bytes[23] ?? 0;
      const b3 = bytes[24] ?? 0;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height, format: 'webp' };
    }
    if (fourcc === 'VP8X') {
      // Extended: 24-bit canvas width-1 / height-1 as 3-byte LE uints at 24/27.
      if (bytes.length < 30) return null;
      const width = 1 + readUint24LE(bytes, 24);
      const height = 1 + readUint24LE(bytes, 27);
      return { width, height, format: 'webp' };
    }
    return null;
  }

  // JPEG: FF D8, walk segments to the first SOFn.
  if (bytes.length >= 4 && startsWith(bytes, [0xff, 0xd8])) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) return null; // marker desync
      const marker = bytes[off + 1] ?? 0;
      // Standalone markers without a length payload.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2;
        continue;
      }
      if (off + 4 > bytes.length) return null;
      const segLen = readUint16BE(bytes, off + 2);
      // SOF0–SOF15 except DHT (0xc4), JPG (0xc8), DAC (0xcc).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (off + 9 > bytes.length) return null;
        const height = readUint16BE(bytes, off + 5);
        const width = readUint16BE(bytes, off + 7);
        if (width === 0 || height === 0) return null;
        return { width, height, format: 'jpeg' };
      }
      off += 2 + segLen;
    }
    return null;
  }

  return null;
}

/**
 * Walk ISO-BMFF top-level boxes to `meta` → find the primary item's
 * `iprp/ipco/ispe` (ImageSpatialExtents) property. Bounded: gives up once the
 * slice ends. This covers AVIF and HEIC/HEIF canvases without a full demux.
 */
function parseIsoBmffPrimaryItemProperties(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let off = 0;
  while (off + 8 <= bytes.length) {
    const boxSize = readUint32BE(bytes, off);
    const boxType = String.fromCharCode(
      bytes[off + 4] ?? 0,
      bytes[off + 5] ?? 0,
      bytes[off + 6] ?? 0,
      bytes[off + 7] ?? 0,
    );
    if (boxSize < 8) return null; // malformed
    if (boxType === 'ispe') {
      // Top-level ispe (partial/stripped object): FullBox header + w/h.
      if (off + 16 > bytes.length) return null;
      const width = readUint32BE(bytes, off + 12);
      const height = readUint32BE(bytes, off + 16);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    if (boxType === 'meta') {
      // meta is a FullBox: 4 bytes version/flags before child boxes.
      return walkIsoBmffForIspe(bytes.subarray(off + 12, off + boxSize));
    }
    off += boxSize;
  }
  return null;
}

function walkIsoBmffForIspe(bytes: Uint8Array): { width: number; height: number } | null {
  let off = 0;
  let depth = 0;
  while (off + 8 <= bytes.length && depth < 8) {
    const boxSize = readUint32BE(bytes, off);
    const boxType = String.fromCharCode(
      bytes[off + 4] ?? 0,
      bytes[off + 5] ?? 0,
      bytes[off + 6] ?? 0,
      bytes[off + 7] ?? 0,
    );
    if (boxSize < 8) return null;
    if (boxType === 'ispe') {
      if (off + 16 > bytes.length) return null;
      const width = readUint32BE(bytes, off + 8);
      const height = readUint32BE(bytes, off + 12);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    // Descend into containers; skip leaf boxes.
    if (boxType === 'iprp' || boxType === 'ipco') {
      const inner = walkIsoBmffForIspe(bytes.subarray(off + 8, off + boxSize));
      if (inner) return inner;
      depth += 1;
    }
    off += boxSize;
  }
  return null;
}

/**
 * Collect the image reference URLs a generation request will actually send,
 * in send order (frameImages first, then imageUrls, then referenceAssets),
 * deduplicated, with video-looking assets excluded — the same set the kie
 * serializer and `referenceImageCountForPricing` see.
 */
export function collectImageReferenceCandidates(
  params: Record<string, unknown>,
  referenceAssets: readonly string[],
): ReferenceCandidate[] {
  const urls: string[] = [];
  for (const key of IMAGE_URL_PARAM_KEYS) {
    const value = params[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) urls.push(item);
      }
    }
  }
  const frameImages = params['frameImages'];
  if (Array.isArray(frameImages)) {
    for (const frame of frameImages) {
      if (
        frame &&
        typeof frame === 'object' &&
        typeof (frame as Record<string, unknown>)['url'] === 'string' &&
        ((frame as Record<string, unknown>)['url'] as string).length > 0
      ) {
        urls.push((frame as Record<string, unknown>)['url'] as string);
      }
    }
  }
  if (urls.length === 0) {
    for (const url of referenceAssets) {
      if (typeof url === 'string' && url.length > 0 && !/\.(mp4|mov|webm)(\?|$)/i.test(url)) {
        urls.push(url);
      }
    }
  }
  return [...new Set(urls)].map((url, i) => ({ index: i + 1, url }));
}

/** The one declared per-side ceiling on a model row, or null (→ not validated). */
export function referenceMaxDimension(capabilities: unknown): number | null {
  const bag = (capabilities ?? {}) as Record<string, unknown>;
  const value = bag['referenceMaxDimension'];
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

export type ReferencePreflightResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'too_large';
      candidate: ReferenceCandidate;
      dimensions: ReferenceDimensions;
      maxDimension: number;
    }
  | { ok: false; reason: 'unavailable'; candidate: ReferenceCandidate; detail: string };

/**
 * Probe every candidate and refuse the FIRST known image whose side exceeds
 * `maxDimension`. Own-object read failures fail closed (retryable 503 from
 * the route); unknown containers and non-own origins are skipped.
 */
export async function preflightReferenceDimensions(
  candidates: readonly ReferenceCandidate[],
  maxDimension: number | null,
  userId: string,
  probe: ReferenceDimensionProbe,
): Promise<ReferencePreflightResult> {
  if (maxDimension === null || candidates.length === 0) return { ok: true };
  for (const candidate of candidates) {
    const result = await probe(candidate.url, userId);
    if (result.status === 'dimensions') {
      const { width, height } = result.dimensions;
      if (width > maxDimension || height > maxDimension) {
        return {
          ok: false,
          reason: 'too_large',
          candidate,
          dimensions: { width, height, format: result.dimensions.format },
          maxDimension,
        };
      }
    } else if (result.status === 'unavailable') {
      return { ok: false, reason: 'unavailable', candidate, detail: result.reason };
    }
    // 'skipped' (foreign origin / outside own prefix) and 'unknown' (container
    // we cannot parse) proceed — the vendor remains the authority.
  }
  return { ok: true };
}

const ORIGIN_ENV_KEYS = [
  'ASSET_PUBLIC_URL',
  'API_PUBLIC_URL',
  'MINIO_PUBLIC_URL',
  'MINIO_ENDPOINT',
  'MINIO_BUCKET',
] as const;

/**
 * Production probe: map an own-origin asset URL onto the authenticated user's
 * MinIO object and read at most PROBE_MAX_BYTES of it. External origins and
 * keys outside `<userId>/` are SKIPPED (never read), so this cannot become an
 * object oracle for other users' buckets or an SSRF amplifier.
 */
export function createMinioReferenceDimensionProbe(
  getObjectRange?: ReferenceObjectReader,
  env: NodeJS.ProcessEnv = process.env,
): ReferenceDimensionProbe {
  return async (url: string, userId: string): Promise<ReferenceProbeResult> => {
    const bucket = env.MINIO_BUCKET ?? 'seed-assets';
    const origins = ORIGIN_ENV_KEYS.filter((k) => k !== 'MINIO_BUCKET')
      .map((k) => env[k]?.replace(/\/$/, ''))
      .filter((o): o is string => Boolean(o));
    const assetOrigin = (env.ASSET_PUBLIC_URL ?? env.MINIO_PUBLIC_URL ?? '').replace(/\/$/, '');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { status: 'skipped' };
    }
    if (!assetOrigin || `${parsed.protocol}//${parsed.host}` !== assetOrigin) {
      return { status: 'skipped' };
    }
    // Path is `/seed-assets/<userId>/...` — the asset origin prefixes the
    // bucket segment (assets.vertov.space edge → MinIO). Only the user's own
    // prefix may be read; the bucket name is fixed by env, not by the URL.
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 3) return { status: 'skipped' };
    if (parts[0] !== bucket) return { status: 'skipped' };
    if (parts[1] !== userId) return { status: 'skipped' };
    const key = parts.slice(1).join('/');
    if (key.length === 0) return { status: 'skipped' };

    const reader =
      getObjectRange ??
      (async (b: string, k: string, offset: number, length: number) => {
        const client = new MinioClient(resolveS3ClientOptions(env));
        return client.getPartialObject(b, k, offset, length);
      });
    try {
      const stream = await reader(bucket, key, 0, PROBE_MAX_BYTES);
      if (!stream) return { status: 'unavailable', reason: 'NotFound' };
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const bytes = new Uint8Array(Buffer.concat(chunks).subarray(0, PROBE_MAX_BYTES));
      const dims = parseImageReferenceDimensions(bytes);
      if (!dims) return { status: 'unknown' };
      return { status: 'dimensions', dimensions: dims };
    } catch (err) {
      const reason =
        err instanceof Error ? ((err as { code?: string }).code ?? err.message) : String(err);
      return { status: 'unavailable', reason };
    }
  };
}
