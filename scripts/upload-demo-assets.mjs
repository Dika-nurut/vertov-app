#!/usr/bin/env node
// Populate the `seed-demo-assets` MinIO bucket with placeholder image bytes for
// the 15 curated showcase demo items (see packages/db/scripts/seed-public-gallery.ts).
//
// The DB seed (`pnpm seed`) writes the gallery ROWS; this writes the BYTES they
// point at, so the showcase grid renders real tiles instead of broken images on
// a fresh deploy. Tiles are deterministic diagonal gradients derived from the
// slug — clearly placeholders, replaceable later by real generations under the
// same slug. Idempotent (overwrites). Zero external image libs / provider spend.
//
//   node scripts/upload-demo-assets.mjs
//
// Env: MINIO_ENDPOINT, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (same as the worker).
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

// `minio`/`dotenv` aren't direct deps of the repo root, so resolve them from the
// worker package (which uses both) rather than depending on pnpm hoisting.
const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
const { Client: Minio } = require('minio');

// Must stay in lockstep with DEMO_ITEMS in packages/db/scripts/seed-public-gallery.ts.
// Inlined (not imported) so this stays a pure-node ops script with no DB connection.
const DEMO_SLUGS = [
  'sunset-mountains',
  'cyberpunk-street',
  'cosmonaut-balloon',
  'spb-bridge',
  'kazan-mosque',
  'taiga-cabin',
  'baikal-ice',
  'arctic-fox',
  'red-square',
  'volga-fisherman',
  'borscht-bowl',
  'matryoshka-line',
  'kremlin-snow',
  'sochi-palms',
  'kola-aurora',
];

const BUCKET = 'seed-demo-assets';
const SIZE = 768;

// --- minimal PNG encoder (truecolor, 8-bit, no deps) ---------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body), 0);
  return Buffer.concat([len, body, crc]);
}

// Two seeded colors per slug → a smooth diagonal gradient.
function colorsFor(slug) {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const hsl = (deg, l) => {
    const s = 0.55;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((deg / 60) % 2) - 1));
    const m = l - c / 2;
    const [r, g, b] =
      deg < 60
        ? [c, x, 0]
        : deg < 120
          ? [x, c, 0]
          : deg < 180
            ? [0, c, x]
            : deg < 240
              ? [0, x, c]
              : deg < 300
                ? [x, 0, c]
                : [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  };
  return [hsl(hue, 0.32), hsl((hue + 40) % 360, 0.55)];
}

function gradientPng(slug) {
  const [a, b] = colorsFor(slug);
  const stride = SIZE * 3 + 1; // +1 filter byte per scanline
  const raw = Buffer.alloc(stride * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const t = (x + y) / (2 * SIZE); // diagonal 0..1
      const o = y * stride + 1 + x * 3;
      raw[o] = Math.round(a[0] + (b[0] - a[0]) * t);
      raw[o + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
      raw[o + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- upload --------------------------------------------------------------------
function parseEndpoint(raw) {
  const u = new URL(raw);
  const useSSL = u.protocol === 'https:';
  return { endPoint: u.hostname, port: u.port ? Number(u.port) : useSSL ? 443 : 80, useSSL };
}

const { endPoint, port, useSSL } = parseEndpoint(
  process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000',
);
const client = new Minio({
  endPoint,
  port,
  useSSL,
  accessKey: process.env.MINIO_ROOT_USER ?? 'seedminio',
  secretKey: process.env.MINIO_ROOT_PASSWORD ?? 'CHANGE_ME_HEX24',
  region: process.env.S3_REGION ?? process.env.MINIO_REGION ?? 'us-east-1',
});

if (!(await client.bucketExists(BUCKET).catch(() => false))) {
  await client.makeBucket(BUCKET, 'us-east-1');
}
// Anonymous read so browsers load the tiles directly (matches AssetStorage).
await client
  .setBucketPolicy(
    BUCKET,
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    }),
  )
  .catch(() => {});

for (const slug of DEMO_SLUGS) {
  const png = gradientPng(slug);
  await client.putObject(BUCKET, `${slug}.png`, png, png.length, { 'Content-Type': 'image/png' });
}
console.log(`upload-demo-assets: ${DEMO_SLUGS.length} placeholder tiles → ${BUCKET}`);
