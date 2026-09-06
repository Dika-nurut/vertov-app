/**
 * laozhang gpt-image-2 BILLED-RATE probe (finance ask, 2026-08-09).
 *
 * Finance cannot sign the gpt-image-2 legs because LaoZhang is the PRIMARY and
 * never invoices per task, so the rate on the executing leg is unknown. Their
 * arithmetic: flat $0.03 → 29.9% at the low rung, flat $0.05 → **-16.9%**. One
 * side of that is an R-1 violation, so the rate has to be measured, not read off
 * a blog post — LaoZhang's published `$0.03/call` is for the DEFAULT route, and
 * `laozhang-adapter.ts` sends `gpt-image-2-vip`, a different route.
 *
 * Measurement: `/v1/dashboard/billing/usage` is live on this account (verified
 * 2026-08-09, HTTP 200, `total_usage: 482`). Its start_date/end_date parameters
 * are IGNORED — every window returns the same figure — so treat it as an opaque
 * monotonic counter and read the DELTA around each call. The delta is the rate;
 * the counter's units and direction are recorded, not assumed.
 *
 * Content: the prompt is today's trend-radar #1 («Y2K Paparazzi Beauty Shot»,
 * docs/trend-radar/2026-08-09.md on branch trend-radar, Σ18) so the three renders
 * are publishable Витрина demo tiles rather than throwaway test apples — per the
 * owner's 2026-08-09 instruction to make paid probes earn their spend twice.
 *
 * PAID. Ceiling: 3 calls, at most ~$0.65 if every tier bills at the dearest
 * published figure ($0.211 high). Requires --yes-spend. Keys from the worktree
 * .env (never printed):
 *   export LAOZHANG_API_KEY="$(awk -F= '/^LAOZHANG_API_KEY=/{sub(/^LAOZHANG_API_KEY=/,"");print}' .env)"
 *   LAOZHANG_MODE=live tsx scripts/laozhang-gpt-image-2-rate-probe.ts --yes-spend
 */
import { writeFileSync } from 'node:fs';
import { LaozhangAdapter, LaozhangClient, type WorkflowSpec } from '../src/index';

if (!process.argv.includes('--yes-spend')) {
  console.error('REFUSING: paid probe requires explicit --yes-spend.');
  process.exit(2);
}

const BASE_URL = process.env.LAOZHANG_BASE_URL ?? 'https://api.laozhang.ai';
const API_KEY = process.env.LAOZHANG_API_KEY ?? '';
if (!API_KEY) {
  console.error('REFUSING: LAOZHANG_API_KEY is empty.');
  process.exit(2);
}

/** Trend radar 2026-08-09 #1 — Y2K Paparazzi Beauty Shot (Σ18, lane B+C). The
 * radar records the skeleton verbatim; the tail is ours, to make it a standalone
 * text-to-image tile (the viral original is an edit that needs a user selfie). */
const PROMPT =
  'authentic early-2000s flash photograph with strong direct frontal camera flash, ' +
  'glossy lips, luxurious hair volume, low-rise denim and rhinestone belt, red carpet ' +
  'at night, paparazzi crowd blurred behind, harsh falloff into darkness, slight motion ' +
  'blur, visible film grain, candid off-guard expression';

const TIERS = ['low', 'medium', 'high'] as const;

/** Read pixel dimensions from PNG or JPEG bytes without a dependency. */
function dimensions(bytes: Uint8Array): { w: number; h: number } | null {
  const b = Buffer.from(bytes);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Opaque monotonic spend counter. Returns null rather than throwing — a meter
 * that stops answering must not abort a run that has already spent money. */
async function meter(): Promise<number | null> {
  try {
    const res = await fetch(
      `${BASE_URL}/v1/dashboard/billing/usage?start_date=2026-08-01&end_date=2026-08-10`,
      { headers: { authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { total_usage?: number };
    return typeof body.total_usage === 'number' ? body.total_usage : null;
  } catch {
    return null;
  }
}

const adapter = new LaozhangAdapter(new LaozhangClient({ baseUrl: BASE_URL, apiKey: API_KEY }));

const rows: string[] = [];
let previous = await meter();
console.log(`meter before run: ${previous ?? 'UNREADABLE'}`);

for (const quality of TIERS) {
  const spec: WorkflowSpec = {
    modelId: 'gpt-image-2',
    providerModelId: 'gpt-image-2',
    providerEndpoint: '',
    kind: 'image',
    prompt: PROMPT,
    // `resolution` is where laozhang-adapter.ts reads the quality word from; it
    // passes low/medium/high through to the vip route untouched.
    params: { n: 1, resolution: quality, aspect_ratio: '1:1' },
    referenceAssets: [],
    maxDurationSeconds: null,
  };
  try {
    const handle = await adapter.generate(spec);
    const result = await adapter.awaitResult(handle, spec);
    const asset = result.assets[0]!;
    const path = `/tmp/lz-gpt-image-2-${quality}.${asset.extension}`;
    writeFileSync(path, asset.bytes);
    const dim = dimensions(asset.bytes);
    const after = await meter();
    const delta = previous !== null && after !== null ? after - previous : null;
    previous = after ?? previous;
    rows.push(
      `${quality.padEnd(7)} ${(dim ? `${dim.w}x${dim.h}` : '?').padEnd(11)} ` +
        `meter=${String(after ?? '?').padEnd(8)} delta=${delta ?? '?'}  ${path}`,
    );
  } catch (err) {
    const e = err as Error & { code?: string; status?: number };
    const after = await meter();
    const delta = previous !== null && after !== null ? after - previous : null;
    previous = after ?? previous;
    rows.push(
      `${quality.padEnd(7)} FAILED      meter=${String(after ?? '?').padEnd(8)} delta=${delta ?? '?'}  ` +
        `code=${e.code ?? '?'} status=${e.status ?? '?'} ${e.message.slice(0, 160)}`,
    );
  }
}

console.log('\nquality dimensions  billed-counter delta');
for (const row of rows) console.log(row);
console.log(
  '\nA delta of 0 on a SUCCEEDED call means the counter is not per-request-live;\n' +
    'read the console at api2.laozhang.ai before concluding the call was free.',
);
