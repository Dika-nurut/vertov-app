#!/usr/bin/env node
// Authenticated Scenario workload driver. It creates isolated synthetic users,
// exercises real HTTP/session/credit/database paths, and emits machine-readable
// latency + correctness evidence. The AI gateway must be the staging mock.
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const pairs = process.argv.slice(2).reduce((out, value, index, all) => {
  if (value.startsWith('--')) out[value.slice(2)] = all[index + 1];
  return out;
}, {});
const API = (pairs.api ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const WEB = (pairs.web ?? 'http://127.0.0.1:3209').replace(/\/$/, '');
const EDITORS = Number(pairs.editors ?? 25);
const AI = Number(pairs.ai ?? 5);
const DURATION_S = Number(pairs.duration ?? 60);
const TIMEOUT_MS = Number(pairs.timeout ?? 15_000);
const DEV_ACCESS = pairs['dev-access'] ?? process.env.DEV_ACCESS ?? '';
const OUTPUT = pairs.output ?? `/tmp/scenario-load-${Date.now()}.json`;
const MIN_SUCCESS = Number(pairs['min-success'] ?? 0.99);
const MAX_CRUD_P95 = Number(pairs['max-crud-p95'] ?? 750);
const MAX_AI_ADMISSION_P95 = Number(pairs['max-ai-admission-p95'] ?? 1_000);
const MAX_TTFT_P95 = Number(pairs['max-ttft-p95'] ?? 2_500);
const IP_OFFSET = Number(pairs['ip-offset'] ?? 0);
const RUN = `load-${Date.now().toString(36)}`;
let deadline = Number.POSITIVE_INFINITY;
const samples = [];
const setupErrors = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const ipFor = (index) => {
  const value = index + IP_OFFSET;
  return `198.18.${Math.floor(value / 250)}.${(value % 250) + 1}`;
};
const headersFor = (user, extra = {}) => ({
  cookie: user.cookie,
  'x-forwarded-for': user.ip,
  ...extra,
});
const timedFetch = async (op, url, init = {}) => {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ms = performance.now() - started;
    return { response, started, ms, op };
  } catch (error) {
    samples.push({
      op,
      ok: false,
      status: 0,
      ms: performance.now() - started,
      error: String(error),
    });
    return null;
  }
};
const finish = async (timed, ok, extra = {}) => {
  if (!timed) return;
  samples.push({ op: timed.op, ok, status: timed.response.status, ms: timed.ms, ...extra });
};

async function login(index) {
  const ip = ipFor(index);
  const email = `${RUN}-${index}@scenario-load.test`;
  const devHeaders = {
    'x-forwarded-for': ip,
    ...(DEV_ACCESS ? { 'x-dev-access': DEV_ACCESS } : {}),
  };
  const signIn = await fetch(`${API}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { ...devHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: `${WEB}/dev/enter` }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!signIn.ok) throw new Error(`sign-in ${signIn.status}`);
  let link;
  for (let attempt = 0; attempt < 30; attempt++) {
    const captured = await fetch(
      `${API}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
      { headers: devHeaders, signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (captured.ok) {
      const body = await captured.json();
      if (body?.url) {
        link = body.url;
        break;
      }
    }
    await sleep(100);
  }
  if (!link) throw new Error('magic link not captured');
  // The captured URL uses the public auth origin. A private load generator may
  // reach the same staging API through an internal address, so keep the signed
  // path/query while routing verification through the configured API endpoint.
  const verifyUrl = new URL(link);
  const apiUrl = new URL(API);
  verifyUrl.protocol = apiUrl.protocol;
  verifyUrl.host = apiUrl.host;
  const verified = await fetch(verifyUrl, {
    redirect: 'manual',
    headers: { 'x-forwarded-for': ip },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const setCookies = verified.headers.getSetCookie?.() ?? [verified.headers.get('set-cookie')];
  const cookie = setCookies
    .filter(Boolean)
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  if (!cookie) throw new Error(`verify ${verified.status} produced no cookie`);
  // Mirror the real app bootstrap: /v1/me materializes the application-side
  // users_app/users_pii rows before the dev credit fixture references them.
  const bootstrap = await fetch(`${API}/v1/me`, {
    headers: { ...devHeaders, cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!bootstrap.ok) throw new Error(`bootstrap ${bootstrap.status}`);
  const godmode = await fetch(`${API}/v1/dev/godmode`, {
    method: 'POST',
    headers: { ...devHeaders, cookie },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!godmode.ok) throw new Error(`godmode ${godmode.status}`);
  const created = await fetch(`${API}/v1/scripts`, {
    method: 'POST',
    headers: { ...devHeaders, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: `${RUN}-${index}`,
      title: `Scenario load ${index}`,
      fountain: 'ИНТ. НАГРУЗОЧНАЯ СЦЕНА — ДЕНЬ\n\nГерой проверяет систему.\n',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!created.ok) throw new Error(`create ${created.status}`);
  const script = await created.json();
  return { email, ip, cookie, scriptId: script.id, rev: script.rev ?? 0 };
}

async function createUsers(count) {
  const users = new Array(count);
  let cursor = 0;
  const worker = async () => {
    while (cursor < count) {
      const index = cursor++;
      try {
        users[index] = await login(index);
      } catch (error) {
        setupErrors.push({ index, error: String(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, count) }, worker));
  return users.filter(Boolean);
}

async function editorLoop(user) {
  let iteration = 0;
  while (Date.now() < deadline) {
    const read = await timedFetch('script_get', `${API}/v1/scripts/${user.scriptId}`, {
      headers: headersFor(user),
    });
    if (read) {
      const body = await read.response.json().catch(() => null);
      await finish(read, read.response.ok && body?.id === user.scriptId);
      if (read.response.ok) user.rev = body.rev;
    }
    const save = await timedFetch('autosave_put', `${API}/v1/scripts/${user.scriptId}`, {
      method: 'PUT',
      headers: headersFor(user, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        fountain: `ИНТ. НАГРУЗОЧНАЯ СЦЕНА — ДЕНЬ\n\nИтерация ${iteration}.\n`,
        baseRev: user.rev,
      }),
    });
    if (save) {
      const body = await save.response.json().catch(() => null);
      await finish(save, save.response.ok && Number.isInteger(body?.rev));
      if (save.response.ok) user.rev = body.rev;
    }
    const sidePath = iteration % 2 ? 'threads' : 'materials';
    const side = await timedFetch(
      `read_${sidePath}`,
      `${API}/v1/scripts/${user.scriptId}/${sidePath}`,
      {
        headers: headersFor(user),
      },
    );
    if (side) {
      await side.response.arrayBuffer();
      await finish(side, side.response.ok);
    }
    iteration += 1;
    await sleep(Math.min(8_000, Math.max(0, deadline - Date.now())));
  }
}

async function assistOnce(user, iteration) {
  const isStructurize = iteration % 10 === 9;
  if (isStructurize) {
    const call = await timedFetch('structurize', `${API}/v1/scripts/${user.scriptId}/structurize`, {
      method: 'POST',
      headers: headersFor(user, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        idempotencyKey: randomUUID(),
        idea: 'Герой проверяет систему и находит безопасное решение.',
      }),
    });
    if (!call) return;
    const body = await call.response.json().catch(() => null);
    await finish(call, call.response.ok && body?.outline?.beats?.length > 0, { ttftMs: call.ms });
    return;
  }
  const started = performance.now();
  const call = await timedFetch('assist', `${API}/v1/scripts/${user.scriptId}/assist`, {
    method: 'POST',
    headers: headersFor(user, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      question: 'Сделай действие точнее.',
      tier: ['economy', 'standard', 'max'][iteration % 3],
      anchor: {
        from: 0,
        to: 31,
        rev: user.rev,
        quote: 'ИНТ. НАГРУЗОЧНАЯ СЦЕНА — ДЕНЬ',
      },
    }),
  });
  if (!call) return;
  const admissionMs = call.ms;
  let ttftMs = null;
  let done = false;
  let errorFrame = false;
  try {
    if (call.response.body) {
      const reader = call.response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((value) => value.startsWith('data:'));
          if (!line) continue;
          try {
            const payload = JSON.parse(line.slice(5));
            if (payload.delta && ttftMs == null) ttftMs = performance.now() - started;
            if (payload.done) {
              // A rewrite-only answer becomes actionable when the final frame
              // carries its proposal, even if no visible prose delta preceded it.
              if (ttftMs == null && payload.proposal) ttftMs = performance.now() - started;
              done = true;
            }
            if (payload.error) errorFrame = true;
          } catch {
            errorFrame = true;
          }
        }
      }
    }
  } catch {
    errorFrame = true;
  }
  samples.push({
    op: 'assist',
    ok: call.response.ok && done && !errorFrame && ttftMs != null,
    status: call.response.status,
    ms: performance.now() - started,
    admissionMs,
    ttftMs,
  });
}

async function aiLoop(user) {
  let iteration = 0;
  while (Date.now() < deadline) {
    await assistOnce(user, iteration++);
    // Stay below the product's 30 calls / 10 minute per-user abuse ceiling.
    await sleep(Math.min(20_000, Math.max(0, deadline - Date.now())));
  }
}

console.error(
  `[scenario-load] setup editors=${EDITORS} ai=${AI} duration=${DURATION_S}s api=${API}`,
);
const users = await createUsers(EDITORS + AI);
if (setupErrors.length || users.length !== EDITORS + AI) {
  const report = { run: RUN, setupErrors, expectedUsers: EDITORS + AI, createdUsers: users.length };
  await writeFile(OUTPUT, JSON.stringify(report, null, 2));
  console.error(`[scenario-load] setup failed; evidence=${OUTPUT}`);
  process.exit(1);
}
const wallStarted = performance.now();
deadline = Date.now() + DURATION_S * 1_000;
await Promise.all([
  ...users.slice(0, EDITORS).map(editorLoop),
  ...users.slice(EDITORS).map(aiLoop),
]);
const wallMs = performance.now() - wallStarted;
const crud = samples.filter((sample) => sample.op !== 'assist' && sample.op !== 'structurize');
const ai = samples.filter((sample) => sample.op === 'assist' || sample.op === 'structurize');
const successRate = (rows) => rows.filter((row) => row.ok).length / Math.max(1, rows.length);
const report = {
  run: RUN,
  config: {
    api: API,
    editors: EDITORS,
    ai: AI,
    durationSeconds: DURATION_S,
    timeoutMs: TIMEOUT_MS,
  },
  totals: {
    requests: samples.length,
    wallMs,
    rps: samples.length / (wallMs / 1_000),
    successRate: successRate(samples),
    crudSuccessRate: successRate(crud),
    aiSuccessRate: successRate(ai),
  },
  latency: {
    crudP50Ms: percentile(
      crud.map((row) => row.ms),
      50,
    ),
    crudP95Ms: percentile(
      crud.map((row) => row.ms),
      95,
    ),
    crudP99Ms: percentile(
      crud.map((row) => row.ms),
      99,
    ),
    aiAdmissionP95Ms: percentile(
      ai.map((row) => row.admissionMs ?? row.ms),
      95,
    ),
    aiTtftP95Ms: percentile(ai.map((row) => row.ttftMs).filter(Number.isFinite), 95),
    aiCompletionP95Ms: percentile(
      ai.map((row) => row.ms),
      95,
    ),
  },
  statuses: Object.fromEntries(
    [...new Set(samples.map((row) => `${row.op}:${row.status}`))].map((key) => [
      key,
      samples.filter((row) => `${row.op}:${row.status}` === key).length,
    ]),
  ),
  failures: samples.filter((row) => !row.ok).slice(0, 100),
  setupErrors,
};
const pass =
  report.totals.crudSuccessRate >= MIN_SUCCESS &&
  report.totals.aiSuccessRate >= MIN_SUCCESS &&
  (report.latency.crudP95Ms ?? Infinity) <= MAX_CRUD_P95 &&
  (report.latency.aiAdmissionP95Ms ?? Infinity) <= MAX_AI_ADMISSION_P95 &&
  (report.latency.aiTtftP95Ms ?? Infinity) <= MAX_TTFT_P95;
report.pass = pass;
await writeFile(OUTPUT, JSON.stringify(report, null, 2));
console.error(JSON.stringify(report, null, 2));
console.error(`[scenario-load] ${pass ? 'PASS' : 'FAIL'} evidence=${OUTPUT}`);
process.exit(pass ? 0 : 1);
