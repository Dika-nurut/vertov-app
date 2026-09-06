/**
 * kie FLUX.2 Pro 2K BILLED-RATE probe (finance ask, 2026-08-09).
 *
 * We sell FLUX.2 Pro at ONE rung. `kie-adapter.ts` hardcodes `resolution: '1K'`,
 * yet kie's own spec (`kie-specs/flux2__pro-text-to-image.md`) publishes an enum of
 * `1K | 2K`. The owner wants the ladder built; finance cannot sign the 2K rung
 * because the two published cost structures disagree by roughly 4x:
 *
 *   · BFL owner pricing is PER MEGAPIXEL ($0,03/MP) → 2K (~4 MP) ≈ $0,12
 *   · our catalogue records OpenRouter at a FLAT $0,03 «per picture» (owner-verified)
 *
 * R-2 forbids inventing a vendor rate, so this measures it. kie exposes a live
 * credit balance at `GET /api/v1/chat/credit`; the DELTA around each call is the
 * charge. The 1K call is not redundant — its rate is already signed at $0,025, so
 * it CALIBRATES what one kie credit is worth before the 2K delta is converted into
 * dollars. Measuring a delta in an unsourced unit is how a probe turns into a guess.
 *
 * PAID. Two calls. Worst case ≈ $0,15 if 2K bills at BFL's per-megapixel rate.
 *   export KIE_API_KEY="$(awk -F= '/^KIE_API_KEY=/{sub(/^KIE_API_KEY=/,"");print}' .env)"
 *   node <tsx> scripts/kie-flux-2k-rate-probe.ts --yes-spend
 */
import { writeFileSync } from 'node:fs';
import { KieClient } from '../src/index';

if (!process.argv.includes('--yes-spend')) {
  console.error('REFUSING: paid probe requires explicit --yes-spend.');
  process.exit(2);
}

const BASE_URL = process.env.KIE_BASE_URL ?? 'https://api.kie.ai';
const API_KEY = process.env.KIE_API_KEY ?? '';
if (!API_KEY) {
  console.error('REFUSING: KIE_API_KEY is empty.');
  process.exit(2);
}

/** Trend radar 2026-08-09 #2 — «Pearl earring» (Higgsfield, tag «new» three days
 * running, Σ17). A still portrait subject, so the same prompt is comparable across
 * both rungs and the 2K frame is a usable Витрина tile rather than a discarded test. */
const PROMPT =
  'Vermeer-style portrait of a young woman in soft north-window light, single pearl ' +
  'earring catching a specular highlight, dark umber background, visible canvas grain, ' +
  'oil-paint impasto on the fabric, museum photography';

async function credit(): Promise<number | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/v1/chat/credit`, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: number };
    return typeof body.data === 'number' ? body.data : null;
  } catch {
    return null;
  }
}

const client = new KieClient({ baseUrl: BASE_URL, apiKey: API_KEY });

let previous = await credit();
console.log(`kie credit before run: ${previous ?? 'UNREADABLE'}`);

for (const resolution of ['1K', '2K'] as const) {
  const before = previous;
  try {
    const task = await client.createTask({
      model: 'flux-2/pro-text-to-image',
      input: { prompt: PROMPT, aspect_ratio: '1:1', resolution },
    });
    const taskId =
      (task as { taskId?: string; data?: { taskId?: string } }).taskId ??
      (task as { data?: { taskId?: string } }).data?.taskId;
    let url: string | undefined;
    for (let i = 0; i < 60 && !url; i += 1) {
      await new Promise((r) => setTimeout(r, 5_000));
      const info = (await client.recordInfo(String(taskId))) as {
        data?: { state?: string; resultJson?: string; failMsg?: string };
      };
      const state = info.data?.state;
      if (state === 'success' && info.data?.resultJson) {
        url = (JSON.parse(info.data.resultJson) as { resultUrls?: string[] }).resultUrls?.[0];
      } else if (state === 'fail') {
        throw new Error(info.data?.failMsg ?? 'task failed');
      }
    }
    if (url) {
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      writeFileSync(`/tmp/kie-flux-${resolution}.png`, bytes);
    }
    const after = await credit();
    console.log(
      `${resolution}: credit ${before ?? '?'} -> ${after ?? '?'}  delta ${
        before !== null && after !== null ? (before - after).toFixed(2) : '?'
      }  ${url ? `/tmp/kie-flux-${resolution}.png` : 'NO URL'}`,
    );
    previous = after ?? previous;
  } catch (err) {
    const after = await credit();
    console.log(
      `${resolution}: FAILED ${(err as Error).message.slice(0, 180)}  delta ${
        before !== null && after !== null ? (before - after).toFixed(2) : '?'
      }`,
    );
    previous = after ?? previous;
  }
}

console.log(
  '\n1K is the CALIBRATION leg: its rate is signed at $0,025, so 1K delta = $0,025 fixes\n' +
    'the credit unit. Only then does the 2K delta become a dollar figure finance can sign.',
);
