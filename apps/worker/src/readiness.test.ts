import { describe, expect, it } from 'vitest';
import { probeReadiness } from './readiness';

describe('probeReadiness (INF-17)', () => {
  it('is ok when every dependency probe resolves', async () => {
    const r = await probeReadiness({
      db: () => Promise.resolve(1),
      redis: () => Promise.resolve('PONG'),
    });
    expect(r).toEqual({ ok: true, checks: { db: true, redis: true } });
  });

  it('is NOT ok and pinpoints the failing dependency', async () => {
    const r = await probeReadiness({
      db: () => Promise.resolve(1),
      redis: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual({ db: true, redis: false });
  });

  it('never lets a probe rejection escape (no unhandled rejection)', async () => {
    const r = await probeReadiness({
      boom: () => {
        throw new Error('sync throw');
      },
    });
    expect(r.ok).toBe(false);
  });
});
