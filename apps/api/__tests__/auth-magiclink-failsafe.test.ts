import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * D (preprod gap) — magic-link login must fail SAFE when the mailer is down.
 *
 * We point SMTP at a closed local port (127.0.0.1:1 → ECONNREFUSED). SMTP is
 * owned by the worker now, so the API should return 200 after persisting the
 * auth.email outbox row instead of waiting for that dead endpoint. The link
 * must still be captured for dev.
 *
 * Env is stubbed before importing `@seed/auth` to model a production SMTP
 * configuration while keeping the API test independent from the worker.
 * Vitest isolates module state per test file.
 */
const BASE = 'http://localhost:4000';
const EMAIL = 'magiclink-failsafe@example.test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getDevLastMagicLink: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;

async function purge(): Promise<void> {
  // Magic-link sign-in writes a `verification` token row; clean it up so the run
  // stays idempotent. The email lands in identifier/value depending on version,
  // so match either (a no-op if nothing was written).
  await pool.query('DELETE FROM verification WHERE identifier LIKE $1 OR value LIKE $1', [
    `%${EMAIL}%`,
  ]);
  await pool.query(
    `DELETE FROM outbox_jobs WHERE queue_name = 'auth.email' AND payload->>'to' = $1`,
    [EMAIL],
  );
}

beforeAll(async () => {
  vi.stubEnv('BETTER_AUTH_URL', BASE);
  vi.stubEnv('SMTP_HOST', '127.0.0.1');
  vi.stubEnv('SMTP_PORT', '1'); // closed port → fast ECONNREFUSED on send
  vi.stubEnv('SMTP_FROM', 'login@vertov.space');
  ({ auth, getDevLastMagicLink } = await import('@seed/auth'));
  ({ pool } = await import('@seed/db'));
  await purge();
});

afterAll(async () => {
  await purge();
  vi.unstubAllEnvs();
});

describe('magic-link login fail-safe (mailer outage)', () => {
  it('returns 200 and still captures the link when SMTP send fails', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL }),
      }),
    );
    // The whole point: a dead mailer must not surface as a 500 to the user.
    expect(res.status, `sign-in → ${res.status} (mailer down must not 500)`).toBe(200);
    // And the link is still observable for dev/e2e despite the send failing.
    const link = getDevLastMagicLink(EMAIL);
    expect(link?.url, 'dev link should be captured even though send failed').toBeTruthy();
    const queued = await pool.query(
      `SELECT queue_name, job_id FROM outbox_jobs
       WHERE queue_name = 'auth.email' AND payload->>'to' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [EMAIL],
    );
    expect(queued.rows[0]?.queue_name).toBe('auth.email');
    expect(queued.rows[0]?.job_id).toMatch(/^auth-email-/);
    expect(queued.rows[0]?.job_id).not.toContain(':');
  });
});
