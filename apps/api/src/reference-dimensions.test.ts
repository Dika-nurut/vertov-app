import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  collectImageReferenceCandidates,
  createMinioReferenceDimensionProbe,
  parseImageReferenceDimensions,
  preflightReferenceDimensions,
  type ReferenceDimensionProbe,
} from './reference-dimensions';

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR chunk length
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width: number, height: number): Buffer {
  // SOF0 segment: marker + length + precision + height + width + component stub.
  const bytes = Buffer.alloc(2 + 2 + 2 + 7);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xc0;
  bytes.writeUInt16BE(7, 4);
  bytes[6] = 8;
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webpVp8x(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = (width - 1) >> 16;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = (height - 1) >> 16;
  return bytes;
}

function gif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  return bytes;
}

function avif(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32BE(16, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write('avif', 8, 'ascii');
  bytes.writeUInt32BE(20, 16);
  bytes.write('ispe', 20, 'ascii');
  bytes.writeUInt32BE(width, 28);
  bytes.writeUInt32BE(height, 32);
  return bytes;
}

describe('reference image dimensions', () => {
  it.each([
    ['PNG', png(6336, 2688), { width: 6336, height: 2688, format: 'png' }],
    ['JPEG', jpeg(4096, 2160), { width: 4096, height: 2160, format: 'jpeg' }],
    ['WebP', webpVp8x(6000, 3375), { width: 6000, height: 3375, format: 'webp' }],
    ['GIF', gif(320, 240), { width: 320, height: 240, format: 'gif' }],
    ['AVIF', avif(8192, 4096), { width: 8192, height: 4096, format: 'avif' }],
  ])('reads %s without decoding the full object', (_label, bytes, expected) => {
    expect(parseImageReferenceDimensions(bytes)).toEqual(expected);
  });

  it('returns null for malformed or unsupported bytes', () => {
    expect(parseImageReferenceDimensions(Buffer.from('not an image'))).toBeNull();
    expect(parseImageReferenceDimensions(png(0, 100))).toBeNull();
  });
});

describe('reference candidate collection and preflight', () => {
  it('deduplicates referenceAssets, imageUrls, and frameImages', () => {
    expect(
      collectImageReferenceCandidates(
        {
          imageUrls: ['https://assets.test/a.png', 'https://assets.test/a.png'],
          frameImages: [{ role: 'first', url: 'https://assets.test/b.png' }],
        },
        ['https://assets.test/a.png'],
      ),
    ).toEqual([
      { index: 1, url: 'https://assets.test/a.png' },
      { index: 2, url: 'https://assets.test/b.png' },
    ]);
  });

  it('fails before reservation when a known reference exceeds the cap', async () => {
    const probe: ReferenceDimensionProbe = async () => ({
      status: 'dimensions',
      dimensions: { width: 6336, height: 2688, format: 'png' },
    });
    await expect(
      preflightReferenceDimensions(
        [{ index: 1, url: 'https://assets.test/a.png' }],
        6000,
        'user-1',
        probe,
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'too_large',
      dimensions: { width: 6336, height: 2688 },
      maxDimension: 6000,
    });
  });

  it('fails closed on an own-object read error', async () => {
    const probe: ReferenceDimensionProbe = async () => ({
      status: 'unavailable',
      reason: 'NoSuchKey',
    });
    await expect(
      preflightReferenceDimensions(
        [{ index: 1, url: 'https://assets.test/a.png' }],
        6000,
        'user-1',
        probe,
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'unavailable', detail: 'NoSuchKey' });
  });

  it('allows an unknown container and models without a declared cap', async () => {
    const probe: ReferenceDimensionProbe = async () => ({ status: 'unknown' });
    const candidate = [{ index: 1, url: 'https://assets.test/a.avif' }];
    await expect(preflightReferenceDimensions(candidate, 6000, 'user-1', probe)).resolves.toEqual({
      ok: true,
    });
    await expect(preflightReferenceDimensions(candidate, null, 'user-1', probe)).resolves.toEqual({
      ok: true,
    });
  });

  it('reads only the bounded own-user object and skips foreign origins', async () => {
    const calls: Array<[string, string, number, number]> = [];
    const probe = createMinioReferenceDimensionProbe(
      async (bucket, key, offset, length) => {
        calls.push([bucket, key, offset, length]);
        return Readable.from([png(1200, 800)]);
      },
      { ASSET_PUBLIC_URL: 'https://assets.test', MINIO_BUCKET: 'seed-assets' },
    );
    await expect(
      probe('https://assets.test/seed-assets/user-1/job-1/0.png?cache=1', 'user-1'),
    ).resolves.toMatchObject({ status: 'dimensions', dimensions: { width: 1200, height: 800 } });
    await expect(
      probe('https://assets.test/seed-assets/user-2/secret.png', 'user-1'),
    ).resolves.toEqual({ status: 'skipped' });
    await expect(
      probe('https://external.test/seed-assets/user-1/other.png', 'user-1'),
    ).resolves.toEqual({ status: 'skipped' });
    expect(calls).toEqual([['seed-assets', 'user-1/job-1/0.png', 0, 128 * 1024]]);
  });

  it('does not raw-fetch external references in the production default probe', async () => {
    const probe = createMinioReferenceDimensionProbe(undefined, {
      ASSET_PUBLIC_URL: 'https://assets.test',
      MINIO_BUCKET: 'seed-assets',
    });
    await expect(probe('https://attacker.example/redirect-to-metadata', 'user-1')).resolves.toEqual(
      { status: 'skipped' },
    );
    await expect(
      probe('https://assets.test/seed-assets/user-2/other.png', 'user-1'),
    ).resolves.toEqual({ status: 'skipped' });
    await expect(
      probe('https://assets.test/seed-assets/user-1/../other.png', 'user-1'),
    ).resolves.toEqual({ status: 'skipped' });
  });
});
