#!/usr/bin/env node
// Load / concurrency smoke (INF-21).
//
// Hammers a target endpoint at a fixed concurrency for a duration and reports
// throughput + latency percentiles + error rate. The point is NOT a benchmark —
// it's a guard that the stack DEGRADES GRACEFULLY under concurrency: no collapse
// (success rate stays high) and no false failures (timeouts/5xx). Exits non-zero
// when the pass thresholds are missed so CI / a release gate can block on it.
//
// Usage:
//   node scripts/load-smoke.mjs --url http://127.0.0.1:4000/health \
//     --concurrency 50 --duration 10 --timeout 5000 \
//     --min-success 0.99 --max-p95 750
//
// Defaults target the local API /health. Point --url at the edge/managed stack
// for the real pre-launch smoke.
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);

const URL_ = args.url ?? 'http://127.0.0.1:4000/health';
const CONCURRENCY = Number(args.concurrency ?? 50);
const DURATION_S = Number(args.duration ?? 10);
const TIMEOUT_MS = Number(args.timeout ?? 5000);
const MIN_SUCCESS = Number(args['min-success'] ?? 0.99);
const MAX_P95 = Number(args['max-p95'] ?? 1000);

const latencies = [];
let ok = 0;
let errors = 0;
let statusBad = 0;
const deadline = Date.now() + DURATION_S * 1000;

async function oneRequest() {
  const started = performance.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(URL_, { signal: ctrl.signal });
    // Drain the body so keep-alive sockets are reused, not leaked.
    await res.arrayBuffer();
    const ms = performance.now() - started;
    if (res.status >= 200 && res.status < 400) {
      ok += 1;
      latencies.push(ms);
    } else {
      statusBad += 1;
    }
  } catch {
    errors += 1;
  } finally {
    clearTimeout(t);
  }
}

async function worker() {
  while (Date.now() < deadline) {
    await oneRequest();
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

console.error(
  `[load-smoke] ${URL_}  concurrency=${CONCURRENCY} duration=${DURATION_S}s timeout=${TIMEOUT_MS}ms`,
);
const wall0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const wallMs = performance.now() - wall0;

const total = ok + errors + statusBad;
const successRate = total ? ok / total : 0;
const sorted = latencies.slice().sort((a, b) => a - b);
const p50 = pct(sorted, 50);
const p95 = pct(sorted, 95);
const p99 = pct(sorted, 99);
const rps = total / (wallMs / 1000);

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : 'n/a');
console.error('[load-smoke] results:');
console.error(`  requests:      ${total} (ok=${ok} bad-status=${statusBad} errors=${errors})`);
console.error(`  success rate:  ${(successRate * 100).toFixed(2)}%  (min ${MIN_SUCCESS * 100}%)`);
console.error(`  throughput:    ${fmt(rps)} req/s`);
console.error(
  `  latency p50/p95/p99: ${fmt(p50)} / ${fmt(p95)} / ${fmt(p99)} ms  (max-p95 ${MAX_P95})`,
);

const pass = successRate >= MIN_SUCCESS && (Number.isNaN(p95) || p95 <= MAX_P95);
console.error(`[load-smoke] ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
