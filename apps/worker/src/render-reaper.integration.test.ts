import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { eq } from 'drizzle-orm';
import { db, studioRenders, pool } from '@seed/db';
import { sweepStaleRenders } from './render-reaper';
import { seedUser, seedStudioRender, cleanupIntegrationData } from './test-support/seed';

/**
 * S0 (trust): a hung render must be REAPABLE. A worker that dies mid-render
 * leaves `studio_renders.status='running'` forever; the render-reaper sweeps
 * stale running rows to `failed` so the client's poll reaches a terminal state.
 * Renders are not credit-reserved, so the credit reaper never covers them.
 *
 * We exercise the pure sweep (`sweepStaleRenders`) directly — the Redis leader
 * election that wraps it in production is shared with, and proven by, the
 * generation reaper.
 */
const log = pino({ level: 'silent' });
let userId: string;

const spec = () => ({
  clips: [{ url: 'http://127.0.0.1:9000/seed-assets/x.mp4' }],
  width: 320,
  height: 180,
  fps: 24,
});

/** Force a render into `running` with a chosen startedAt (queued by default). */
async function makeRunning(startedAtMsAgo: number): Promise<string> {
  const id = await seedStudioRender(userId, spec());
  await db
    .update(studioRenders)
    .set({ status: 'running', startedAt: new Date(Date.now() - startedAtMsAgo) })
    .where(eq(studioRenders.id, id));
  return id;
}

async function rowOf(id: string) {
  return (await db.select().from(studioRenders).where(eq(studioRenders.id, id)).limit(1))[0]!;
}

beforeAll(async () => {
  await cleanupIntegrationData();
  userId = await seedUser();
});

afterAll(async () => {
  await cleanupIntegrationData();
  await pool.end();
});

describe('render-reaper — hung studio renders sweep to failed (S0 trust)', () => {
  it('reaps a render stuck running past the timeout', async () => {
    const stale = await makeRunning(30 * 60_000); // started 30m ago
    const reaped = await sweepStaleRenders(log, 5 * 60_000, 10 * 60_000); // 5m running timeout
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = await rowOf(stale);
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toMatch(/timeout/i);
    expect(row.finishedAt).not.toBeNull();
  });

  it('leaves a render that is still within the timeout running', async () => {
    const fresh = await makeRunning(60_000); // started 1m ago
    await sweepStaleRenders(log, 30 * 60_000, 10 * 60_000); // 30m running timeout
    expect((await rowOf(fresh)).status).toBe('running');
  });

  it('reaps a render never picked up from the queue (worker down)', async () => {
    const queued = await seedStudioRender(userId, spec());
    // Age its createdAt past the queued timeout.
    await db
      .update(studioRenders)
      .set({ createdAt: new Date(Date.now() - 30 * 60_000) })
      .where(eq(studioRenders.id, queued));
    await sweepStaleRenders(log, 30 * 60_000, 10 * 60_000); // 10m queued timeout
    const row = await rowOf(queued);
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toMatch(/queue not consumed/i);
  });

  it('leaves a fresh queued render alone (within the queued timeout)', async () => {
    const queued = await seedStudioRender(userId, spec()); // createdAt = now
    await sweepStaleRenders(log, 30 * 60_000, 10 * 60_000);
    expect((await rowOf(queued)).status).toBe('queued');
  });
});
