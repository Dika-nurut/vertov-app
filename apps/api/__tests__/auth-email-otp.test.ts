import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Email OTP — full send → verify → sign-in smoke.
 *
 * With no SMTP configured (dev/e2e), the code is captured to dev state (and
 * logged) while the email is handed to the durable auth.email outbox. We read
 * the code back via getDevLastEmailOtp and complete sign-in — exercising the
 * emailOTP() plugin and sign-up-on-first-login end to end. This is the
 * owner-preferred CODE login (a short code to type, not a magic link). The
 * created user and queued message are purged either side so the run is idempotent.
 */
const BASE = 'http://localhost:4000';
const TEST_EMAIL = 'email-otp-smoke@example.com';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getDevLastEmailOtp: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;

async function purge(): Promise<void> {
  await pool.query('DELETE FROM "user" WHERE email = $1', [TEST_EMAIL]);
  await pool.query(
    `DELETE FROM outbox_jobs WHERE queue_name = 'auth.email' AND payload->>'to' = $1`,
    [TEST_EMAIL],
  );
}

beforeAll(async () => {
  vi.stubEnv('BETTER_AUTH_URL', BASE);
  ({ auth, getDevLastEmailOtp } = await import('@seed/auth'));
  ({ pool } = await import('@seed/db'));
  await purge();
});

afterAll(async () => {
  await purge();
  vi.unstubAllEnvs();
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return auth.handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('email OTP sign-in', () => {
  it('sends a 6-digit code, verifies it, and signs the new user in', async () => {
    const sendRes = await post('/api/auth/email-otp/send-verification-otp', {
      email: TEST_EMAIL,
      type: 'sign-in',
    });
    expect(sendRes.status, `send-verification-otp → ${sendRes.status}`).toBe(200);

    const queued = await pool.query(
      `SELECT queue_name FROM outbox_jobs
       WHERE queue_name = 'auth.email' AND payload->>'to' = $1
       ORDER BY created_at DESC LIMIT 1`,
      [TEST_EMAIL],
    );
    expect(queued.rows[0]?.queue_name).toBe('auth.email');

    const otp = getDevLastEmailOtp(TEST_EMAIL);
    expect(otp?.code, 'OTP should be captured for dev').toBeTruthy();
    expect(otp.code).toHaveLength(6); // EMAIL_OTP_LENGTH default

    const verifyRes = await post('/api/auth/sign-in/email-otp', {
      email: TEST_EMAIL,
      otp: otp.code,
    });
    expect(verifyRes.status, `sign-in/email-otp → ${verifyRes.status}`).toBe(200);
    // Sign-up-on-first-login issues a session for the brand-new user.
    const data = (await verifyRes.json()) as { token?: string; user?: unknown };
    expect(data.token ?? data.user).toBeTruthy();
  });

  it('rejects a wrong code', async () => {
    await post('/api/auth/email-otp/send-verification-otp', { email: TEST_EMAIL, type: 'sign-in' });
    const verifyRes = await post('/api/auth/sign-in/email-otp', {
      email: TEST_EMAIL,
      otp: '000000',
    });
    expect(verifyRes.status).not.toBe(200);
  });
});
