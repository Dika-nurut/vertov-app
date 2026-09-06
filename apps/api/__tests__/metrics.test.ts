import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  creditsGrantTotal,
  startMetricsServer,
  refreshGauges,
  scenarioAssistRequestsTotal,
  scenarioBoardHandoffs,
} from '../src/metrics';

/**
 * Pure registry tests + a thin HTTP smoke that the standalone /metrics
 * server emits Prometheus-format output. We don't boot the full API
 * here — it would force a Postgres connection and Better Auth setup —
 * but the registry is a singleton, so counters bumped here are
 * indistinguishable from counters bumped in the real api process.
 */
describe('metrics registry', () => {
  it('exposes Prometheus text format with our custom series', async () => {
    httpRequestsTotal.labels({ method: 'GET', route: '/health', status: '200' }).inc();
    httpRequestDuration.labels({ method: 'GET', route: '/health', status: '200' }).observe(0.012);
    creditsGrantTotal.labels('pack_grant').inc(50);

    const out = await registry.metrics();
    expect(out).toContain('seed_http_requests_total');
    expect(out).toMatch(
      /seed_http_requests_total\{[^}]*method="GET"[^}]*route="\/health"[^}]*status="200"[^}]*\} 1/,
    );
    expect(out).toContain('seed_credits_grant_total');
    expect(out).toMatch(/seed_credits_grant_total\{account="pack_grant"\} 50/);
    expect(out).toContain('seed_http_request_duration_seconds_bucket');
    expect(out).toContain('seed_outbox_pending_total');
  });

  it('exposes Scenario operational series with privacy-safe labels', async () => {
    scenarioAssistRequestsTotal.labels('economy', 'project', 'completed').inc();
    scenarioBoardHandoffs.labels('created').inc();
    const out = await registry.metrics();
    expect(out).toContain(
      'seed_scenario_assist_requests_total{tier="economy",scope="project",outcome="completed"}',
    );
    expect(out).toContain('seed_scenario_board_handoffs_total{outcome="created"}');
    expect(out).not.toMatch(/seed_scenario_[^\n]*\{[^}]*(_id|prompt|response)=/);
  });

  it('gauges BL-1 daily spend vs. cap when a spend reader is provided (INF-17)', async () => {
    // Fake Redis day-bucket counter; no live Redis/DB. queues={} so the queue
    // branch is a no-op and the DB query is skipped on connection error anyway.
    const fakeRedis = { get: async () => '250' } as unknown as import('ioredis').default;
    await refreshGauges({}, { redis: fakeRedis, env: { DAILY_SPEND_CAP_CREDITS: '1000' } });

    const out = await registry.metrics();
    expect(out).toMatch(/seed_daily_spend_credits 250/);
    expect(out).toMatch(/seed_daily_spend_cap_credits 1000/);
  });
});

describe('standalone metrics http server', () => {
  let close: (() => Promise<void>) | null = null;
  // Use a random ephemeral port to dodge collisions with the running
  // dev process on :4001.
  const port = 17_000 + Math.floor(Math.random() * 1000);
  const silentLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => silentLog,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  beforeAll(() => {
    const handle = startMetricsServer({
      port,
      host: '127.0.0.1',
      log: silentLog,
      // Empty queues — getJobCounts isn't called when the map is empty.
      queues: {},
    });
    close = handle.close;
  });
  afterAll(async () => {
    if (close) await close();
  });

  it('serves /metrics with our counters', async () => {
    // Wait for listen to settle.
    await new Promise((r) => setTimeout(r, 50));
    httpRequestsTotal.labels({ method: 'POST', route: '/v1/jobs', status: '201' }).inc();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    const body = await res.text();
    expect(body).toMatch(/seed_http_requests_total\{[^}]*route="\/v1\/jobs"/);
    expect(body).toContain('seed_outbox_pending_total');
  });

  it('returns 404 for any path other than /metrics', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(404);
  });
});
