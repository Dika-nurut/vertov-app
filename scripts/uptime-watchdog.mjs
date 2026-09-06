#!/usr/bin/env node
// Lightweight uptime + health watchdog for the single-VM MVP (INF-18 / M-24).
//
// A full Prometheus + Alertmanager stack is overkill for one cheap VM, but
// "monitoring that actually runs" is not optional. This is a single-shot check
// (drive it from cron every 1-2 min) that:
//   1. confirms the API /health is 200 (the site is up),
//   2. scrapes /metrics and flags: credit outbox not draining, daily spend near
//      the cap, a stuck oldest-running job, and queue backlog.
// On any breach it logs a structured line to stderr (so `docker logs`/journald
// captures it) and, if ALERT_WEBHOOK_URL is set, POSTs the alert JSON there
// (point it at a Telegram-bot proxy, email-to-webhook, Mattermost, etc.).
// Exit code is non-zero on breach so cron MAILTO / an external uptime ping can
// also catch it. Zero deps (global fetch), zero provider spend.
//
//   node scripts/uptime-watchdog.mjs
//   # crontab:  */2 * * * * cd /root/seed && node scripts/uptime-watchdog.mjs >> /var/log/seed-watchdog.log 2>&1
//
// Env: WATCHDOG_HEALTH_URL, WATCHDOG_METRICS_URL, ALERT_WEBHOOK_URL,
//      WATCHDOG_OUTBOX_MAX (default 20), WATCHDOG_SPEND_RATIO (default 0.8),
//      WATCHDOG_JOB_AGE_MAX_S (default 900), WATCHDOG_QUEUE_WAIT_MAX (default 100).

const HEALTH_URL = process.env.WATCHDOG_HEALTH_URL ?? 'http://127.0.0.1:4000/health';
const METRICS_URL = process.env.WATCHDOG_METRICS_URL ?? 'http://127.0.0.1:4001/metrics';
const TIMEOUT_MS = 8000;
const OUTBOX_MAX = Number(process.env.WATCHDOG_OUTBOX_MAX ?? 20);
const SPEND_RATIO = Number(process.env.WATCHDOG_SPEND_RATIO ?? 0.8);
const JOB_AGE_MAX_S = Number(process.env.WATCHDOG_JOB_AGE_MAX_S ?? 900);
const QUEUE_WAIT_MAX = Number(process.env.WATCHDOG_QUEUE_WAIT_MAX ?? 100);

const alerts = [];
const add = (severity, code, message) => alerts.push({ severity, code, message });

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } finally {
    clearTimeout(t);
  }
}

// Sum every sample of a Prometheus series (optionally matching a label substring).
function sumSeries(text, name, labelMatch) {
  let total = 0;
  for (const line of text.split('\n')) {
    if (line[0] === '#' || !line.startsWith(name)) continue;
    const after = line.slice(name.length);
    if (after[0] !== ' ' && after[0] !== '{') continue; // avoid prefix collisions
    if (labelMatch && !line.includes(labelMatch)) continue;
    const val = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(val)) total += val;
  }
  return total;
}
function firstValue(text, name) {
  for (const line of text.split('\n')) {
    if (line[0] === '#' || !line.startsWith(name)) continue;
    const after = line.slice(name.length);
    if (after[0] !== ' ' && after[0] !== '{') continue;
    const val = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(val)) return val;
  }
  return null;
}

// 1. Liveness — the one check that matters most for a demo.
try {
  const h = await fetchText(HEALTH_URL);
  if (!h.ok) add('critical', 'api_down', `GET ${HEALTH_URL} → HTTP ${h.status}`);
} catch (err) {
  add('critical', 'api_unreachable', `GET ${HEALTH_URL} failed: ${err.message}`);
}

// 2. Metrics-derived health (best-effort; absence of metrics is itself a warning).
try {
  const m = await fetchText(METRICS_URL);
  if (!m.ok) {
    add('warning', 'metrics_down', `GET ${METRICS_URL} → HTTP ${m.status}`);
  } else {
    const outbox = sumSeries(m.body, 'seed_outbox_pending_total');
    if (outbox > OUTBOX_MAX)
      add(
        'critical',
        'outbox_stuck',
        `credit outbox ${outbox} rows pending (>${OUTBOX_MAX}) — money ops stalled`,
      );

    const spend = firstValue(m.body, 'seed_daily_spend_credits');
    const cap = firstValue(m.body, 'seed_daily_spend_cap_credits');
    if (spend != null && cap && cap > 0 && spend / cap > SPEND_RATIO)
      add(
        'warning',
        'spend_near_cap',
        `daily spend ${spend}/${cap} (${Math.round((spend / cap) * 100)}%) — generation refused at 100%`,
      );

    const jobAge = firstValue(m.body, 'seed_oldest_running_job_age_seconds');
    if (jobAge != null && jobAge > JOB_AGE_MAX_S)
      add(
        'warning',
        'job_stuck',
        `oldest running job ${Math.round(jobAge)}s old (>${JOB_AGE_MAX_S}s) — reaper should recover, verify`,
      );

    const queueWait = sumSeries(m.body, 'seed_queue_depth', 'state="wait"');
    if (queueWait > QUEUE_WAIT_MAX)
      add(
        'warning',
        'queue_backlog',
        `${queueWait} jobs waiting (>${QUEUE_WAIT_MAX}) — scale workers or investigate`,
      );
  }
} catch (err) {
  add('warning', 'metrics_unreachable', `GET ${METRICS_URL} failed: ${err.message}`);
}

const stamp = new Date().toISOString();
if (alerts.length === 0) {
  console.log(`[watchdog ${stamp}] ok`);
  process.exit(0);
}

for (const a of alerts)
  console.error(`[watchdog ${stamp}] ${a.severity.toUpperCase()} ${a.code}: ${a.message}`);

if (process.env.ALERT_WEBHOOK_URL) {
  try {
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'vertov', at: stamp, alerts }),
    });
  } catch (err) {
    console.error(`[watchdog ${stamp}] WARNING webhook_failed: ${err.message}`);
  }
}
process.exit(1);
