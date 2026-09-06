/**
 * previz-s0-probe.ts — the two AUTHORIZED S0 micro-renders that gate the
 * previz campaign (research/archive/previz-loop-goal.md §S0b). PAID: refuses to run
 * without --yes-spend. Everything else in previz testing is stubbed.
 *
 * Probe A (openrouter):  seedance-2.0-fast reference-to-video, 4 s, 480p,
 *                        audio off, ONE image ref → does the PRIMARY gateway
 *                        fetch our http:// asset URL and carry the character?
 * Probe B (atlascloud):  same model family, image + short VIDEO ref → does
 *                        the only video-ref-capable gateway accept both?
 *
 * Usage (run from packages/providers/byteplus, keys via the root .env):
 *   set -a; . ../../../.env; set +a
 *   pnpm tsx scripts/previz-s0-probe.ts --gateway openrouter \
 *     --image "$ASSET_PUBLIC_URL/seed-assets/<key>" --yes-spend
 *   pnpm tsx scripts/previz-s0-probe.ts --gateway atlascloud \
 *     --image <url> --video <url> --yes-spend
 *
 * Writes the downloaded result to /tmp/previz-s0-<gateway>.<ext> and prints
 * the submitted wire body + outcome. Record results in previz-loop-goal.md.
 */
import { writeFileSync } from 'node:fs';
import {
  AtlasCloudAdapter,
  AtlasCloudClient,
  OpenRouterAdapter,
  OpenRouterClient,
  buildAtlasRequest,
  buildOpenRouterVideoBody,
  type WorkflowSpec,
} from '../src/index';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const gateway = arg('--gateway');
const image = arg('--image');
const video = arg('--video');
const prompt =
  arg('--prompt') ??
  'Эта женщина медленно поворачивает голову к камере, мягкий дневной свет. ' +
    'The same person as in the reference image.';

if (!process.argv.includes('--yes-spend')) {
  console.error('REFUSING: paid probe requires explicit --yes-spend (previz non-negotiable).');
  process.exit(2);
}
if ((gateway !== 'openrouter' && gateway !== 'atlascloud') || !image) {
  console.error('usage: --gateway openrouter|atlascloud --image <url> [--video <url>] --yes-spend');
  process.exit(2);
}
if (gateway === 'atlascloud' && !video) {
  console.error('atlascloud probe must include --video (the video-ref path is what it proves).');
  process.exit(2);
}

const spec: WorkflowSpec = {
  modelId: 'seedance-2-0-fast-reference-to-video',
  providerModelId: 'seedance-2.0-fast-reference-to-video',
  providerEndpoint: '/api/v3/videos/generations',
  kind: 'video',
  prompt,
  params: {
    duration_seconds: 4,
    resolution: '480p',
    aspect_ratio: '16:9',
    generate_audio: false,
    imageUrls: [image],
    ...(video ? { videoUrls: [video] } : {}),
  },
  referenceAssets: [],
  maxDurationSeconds: 15,
};

const adapter =
  gateway === 'openrouter'
    ? new OpenRouterAdapter(
        new OpenRouterClient({
          baseUrl: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
          apiKey: process.env.OPENROUTER_API_KEY ?? '',
        }),
      )
    : new AtlasCloudAdapter(
        new AtlasCloudClient({
          baseUrl: process.env.ATLASCLOUD_BASE_URL ?? 'https://api.atlascloud.ai/api/v1',
          apiKey: process.env.ATLASCLOUD_API_KEY ?? '',
        }),
      );

const wire =
  gateway === 'openrouter' ? buildOpenRouterVideoBody(spec) : buildAtlasRequest(spec).body;
console.log(`[probe:${gateway}] wire body:\n${JSON.stringify(wire, null, 2)}`);

try {
  const handle = await adapter.generate(spec);
  console.log(`[probe:${gateway}] submitted, job=${handle.providerJobId} — polling…`);
  const result = await adapter.awaitResult(handle, spec);
  const a = result.assets[0]!;
  const out = `/tmp/previz-s0-${gateway}.${a.extension}`;
  writeFileSync(out, a.bytes);
  console.log(
    `[probe:${gateway}] OK — ${a.contentType}, ${a.bytes.byteLength} bytes → ${out}` +
      (result.meta?.providerCostUsd !== undefined
        ? ` (provider cost $${result.meta.providerCostUsd})`
        : ''),
  );
} catch (err) {
  const e = err as Error & { code?: string; status?: number };
  console.error(
    `[probe:${gateway}] FAILED — code=${e.code ?? '?'} status=${e.status ?? '?'}: ${e.message}`,
  );
  process.exit(1);
}
