#!/usr/bin/env node
/**
 * Long-edit/project durability gate. Creates an isolated named Studio project,
 * performs thousands of revisioned saves, verifies stale-write rejection and
 * a near-limit project round-trip, then deletes the project.
 *
 * STUDIO_SOAK_COOKIE='better-auth.session_token=…' node scripts/studio-project-soak.mjs \
 *   --base https://staging.example --iterations 2000
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, values) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
    return pairs;
  }, []),
);

const base = String(args.base ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const iterations = Number(args.iterations ?? 2_000);
let cookie = process.env.STUDIO_SOAK_COOKIE ?? '';
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error('invalid --iterations');

if (!cookie) {
  const email = String(args.email ?? `studio-soak-${Date.now()}@seed.local`);
  const signIn = await fetch(`${base}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: `${base}/health` }),
  });
  if (!signIn.ok) throw new Error(`dev sign-in failed: HTTP ${signIn.status}`);
  let verifyUrl = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const captured = await fetch(
      `${base}/v1/dev/last-magic-link?email=${encodeURIComponent(email)}`,
    );
    const body = await captured.json().catch(() => null);
    if (body?.email === email && body?.url) {
      verifyUrl = body.url;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!verifyUrl) throw new Error('dev magic link was not captured');
  const verified = await fetch(verifyUrl, { redirect: 'manual' });
  const setCookies = verified.headers.getSetCookie?.() ?? [verified.headers.get('set-cookie')];
  cookie = setCookies
    .filter(Boolean)
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  if (!cookie) throw new Error('magic-link verification did not issue a session cookie');
}

const headers = { cookie, 'content-type': 'application/json' };
// Better Auth owns the identity row; /v1/me materializes its users_app mirror
// before Studio's FK-protected project rows are created.
const me = await fetch(`${base}/v1/me`, { headers });
if (!me.ok) throw new Error(`session bootstrap failed: HTTP ${me.status}`);
let projectId = null;
const latencies = [];

async function json(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      `${init.method ?? 'GET'} ${path}: HTTP ${response.status} ${JSON.stringify(body)}`,
    );
  return body;
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

try {
  const created = await json('/v1/studio/projects', {
    method: 'POST',
    body: JSON.stringify({ title: `readiness-soak-${Date.now()}` }),
  });
  projectId = created.id;

  for (let rev = 1; rev <= iterations; rev += 1) {
    const started = performance.now();
    const result = await json(`/v1/studio/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify({
        rev,
        timeline: {
          schemaVersion: 2,
          marker: rev,
          tracks: [{ id: 'base', kind: 'video', clips: [] }],
          texts: [],
          music: null,
          voiceover: null,
          formatId: '16:9',
          bgColor: null,
        },
      }),
    });
    if (result.skipped) throw new Error(`fresh revision ${rev} was skipped`);
    latencies.push(performance.now() - started);

    if (rev % 100 === 0 || rev === iterations) {
      const current = await json(`/v1/studio/projects/${projectId}`);
      if (current.timeline?.__rev !== rev || current.timeline?.marker !== rev) {
        throw new Error(`round-trip mismatch at revision ${rev}`);
      }
    }
  }

  const stale = await json(`/v1/studio/projects/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({ rev: iterations, timeline: { marker: 'stale' } }),
  });
  if (stale.skipped !== true) throw new Error('equal/stale revision was not rejected');

  const nearLimitRev = iterations + 1;
  const padding = 'x'.repeat(235 * 1024);
  await json(`/v1/studio/projects/${projectId}`, {
    method: 'PUT',
    body: JSON.stringify({
      rev: nearLimitRev,
      timeline: {
        schemaVersion: 2,
        marker: 'near-limit',
        padding,
        tracks: [{ id: 'base', kind: 'video', clips: [] }],
      },
    }),
  });
  const large = await json(`/v1/studio/projects/${projectId}`);
  if (
    large.timeline?.padding?.length !== padding.length ||
    large.timeline?.__rev !== nearLimitRev
  ) {
    throw new Error('near-limit project did not round-trip exactly');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        result: 'PASS',
        projectId,
        iterations,
        saveLatencyMs: {
          p50: Math.round(percentile(latencies, 0.5)),
          p95: Math.round(percentile(latencies, 0.95)),
          p99: Math.round(percentile(latencies, 0.99)),
        },
        staleWriteRejected: true,
        nearLimitBytes: padding.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (projectId) {
    await fetch(`${base}/v1/studio/projects/${projectId}`, {
      method: 'DELETE',
      headers: { cookie },
    }).catch(() => {});
  }
}
