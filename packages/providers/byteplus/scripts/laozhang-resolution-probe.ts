/**
 * laozhang delivered-resolution probe (pricing source-of-truth, 2026-07-16).
 *
 * laozhang bills a FLAT $/request per image model but never declares the
 * resolution it actually returns, and has a documented silent-downgrade risk.
 * This calls the LaozhangAdapter DIRECTLY (no fallback chain) for each model at
 * its max resolution, then reads the ACTUAL pixel dimensions off the returned
 * bytes — so we know whether e.g. Nano Banana Pro's flat $0.09 really delivers
 * 4K or silently hands back 1K.
 *
 * PAID. Requires --yes-spend. Keys from root .env:
 *   set -a; . ../../../.env; set +a
 *   LAOZHANG_MODE=live tsx scripts/laozhang-resolution-probe.ts --yes-spend
 */
import { writeFileSync } from 'node:fs';
import { LaozhangAdapter, LaozhangClient, type WorkflowSpec } from '../src/index';

if (!process.argv.includes('--yes-spend')) {
  console.error('REFUSING: paid probe requires explicit --yes-spend.');
  process.exit(2);
}

// [modelId, providerModelId, requested resolution tier]
const PROBES: Array<[string, string, string]> = [
  ['gemini-3-pro-image', 'gemini-3-pro-image', '4K'],
  ['gemini-3-1-flash-image', 'gemini-3.1-flash-image', '4K'],
  ['gpt-image-2', 'gpt-image-2', '4K'],
];

const PROMPT =
  'A single ripe red apple on a plain white studio background, sharp product photography, centered.';

/** Read pixel dimensions from PNG or JPEG bytes without a dependency. */
function dimensions(bytes: Uint8Array): { w: number; h: number } | null {
  const b = Buffer.from(bytes);
  // PNG: 8-byte sig, IHDR width/height are big-endian u32 at offsets 16/20.
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // JPEG: scan segments for a SOF marker (0xFFC0..0xFFCF, excl C4/C8/CC).
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

const adapter = new LaozhangAdapter(
  new LaozhangClient({
    baseUrl: process.env.LAOZHANG_BASE_URL ?? 'https://api.laozhang.ai',
    apiKey: process.env.LAOZHANG_API_KEY ?? '',
  }),
);

console.log('model                          requested  ACTUAL       verdict');
for (const [modelId, providerModelId, res] of PROBES) {
  const spec: WorkflowSpec = {
    modelId,
    providerModelId,
    providerEndpoint: '',
    kind: 'image',
    prompt: PROMPT,
    params: { n: 1, resolution: res, aspect_ratio: '1:1' },
    referenceAssets: [],
    maxDurationSeconds: null,
  };
  try {
    const handle = await adapter.generate(spec);
    const result = await adapter.awaitResult(handle, spec);
    const a = result.assets[0]!;
    writeFileSync(`/tmp/lao-${modelId}.${a.extension}`, a.bytes);
    const dim = dimensions(a.bytes);
    const got = dim ? `${dim.w}x${dim.h}` : `? (${a.bytes.byteLength}B ${a.contentType})`;
    const maxSide = dim ? Math.max(dim.w, dim.h) : 0;
    const verdict = !dim
      ? 'UNKNOWN (decode failed)'
      : res === '4K' && maxSide >= 3000
        ? 'OK — real 4K'
        : res === '4K' && maxSide < 1600
          ? 'DOWNGRADE → ~1K'
          : `partial (${maxSide}px)`;
    console.log(`${modelId.padEnd(30)} ${res.padEnd(10)} ${got.padEnd(12)} ${verdict}`);
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    console.log(`${modelId.padEnd(30)} ${res.padEnd(10)} FAILED       code=${e.code ?? '?'} ${e.message}`);
  }
}
