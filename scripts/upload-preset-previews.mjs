#!/usr/bin/env node
// Populate the `seed-preset-previews` MinIO bucket with real demo assets for
// the Vitrina model-demo preset packs (see packages/db/seed/preset-packs.ts
// "Model demos" blocks). Unlike upload-demo-assets.mjs (synthetic placeholder
// PNGs), this reads REAL source files from disk. Two shapes, matching the
// samplePreviewUrl convention buildPresetPackRows() derives from `modality`:
//   video demo (.mp4 source)         → uploads <slug>.mp4 + a ffmpeg poster <slug>.png
//   image demo (.jpg/.jpeg/.png src) → uploads <slug>.png only (jpg sources
//                                       are transcoded via ffmpeg; a .png
//                                       source is copied through as-is)
//
//   node scripts/upload-preset-previews.mjs --dir /tmp/route-test --map scripts/preset-preview-map.json
//
// --dir  directory containing the source files (required).
// --map  JSON file mapping source filename → target slug (required). Only
//        filenames present in the map are uploaded; others are skipped.
//
// Env: MINIO_ENDPOINT, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD (same as the worker).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
const { Client: Minio } = require('minio');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dir = arg('dir');
const mapPath = arg('map');
if (!dir || !mapPath) {
  console.error(
    'usage: node scripts/upload-preset-previews.mjs --dir <mp4-dir> --map <filename-to-slug.json>',
  );
  process.exit(1);
}

/** @type {Record<string, string>} filename → slug */
const fileToSlug = JSON.parse(readFileSync(mapPath, 'utf8'));

const BUCKET = 'seed-preset-previews';

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
// Anonymous read so browsers load the mosaic tiles directly (matches AssetStorage).
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

const prodCommands = [];

for (const [filename, slug] of Object.entries(fileToSlug)) {
  const srcPath = path.join(dir, filename);
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.mp4') {
    const mp4Bytes = readFileSync(srcPath);
    await client.putObject(BUCKET, `${slug}.mp4`, mp4Bytes, mp4Bytes.length, {
      'Content-Type': 'video/mp4',
    });

    const posterPath = path.join(os.tmpdir(), `${slug}.png`);
    execFileSync('ffmpeg', ['-y', '-i', srcPath, '-frames:v', '1', '-q:v', '2', posterPath], {
      stdio: 'pipe',
    });
    const pngBytes = readFileSync(posterPath);
    await client.putObject(BUCKET, `${slug}.png`, pngBytes, pngBytes.length, {
      'Content-Type': 'image/png',
    });
    unlinkSync(posterPath);

    console.log(`upload-preset-previews: ${filename} → ${slug}.mp4 + ${slug}.png`);
    prodCommands.push(
      `yc storage s3api put-object --bucket ${BUCKET} --key ${slug}.mp4 --body ${srcPath} --content-type video/mp4`,
    );
    prodCommands.push(
      `yc storage s3api put-object --bucket ${BUCKET} --key ${slug}.png --body /tmp/${slug}.png --content-type image/png`,
    );
  } else {
    // Image demo — modality: 'image' derives a bare <slug>.png, no poster.
    const pngPath = ext === '.png' ? srcPath : path.join(os.tmpdir(), `${slug}.png`);
    if (ext !== '.png') {
      execFileSync('ffmpeg', ['-y', '-i', srcPath, pngPath], { stdio: 'pipe' });
    }
    const pngBytes = readFileSync(pngPath);
    await client.putObject(BUCKET, `${slug}.png`, pngBytes, pngBytes.length, {
      'Content-Type': 'image/png',
    });
    if (ext !== '.png') unlinkSync(pngPath);

    console.log(`upload-preset-previews: ${filename} → ${slug}.png`);
    prodCommands.push(
      `yc storage s3api put-object --bucket ${BUCKET} --key ${slug}.png --body /tmp/${slug}.png --content-type image/png`,
    );
  }
}

console.log(`\nupload-preset-previews: ${Object.keys(fileToSlug).length} assets → ${BUCKET}`);
console.log(
  '\n# Owner-gated prod step (see docs/ops/yc-migration-log.md ~line 164): re-run the poster',
  '\n# extraction against the same source files, then run these against the prod bucket:\n',
);
console.log(prodCommands.join('\n'));
