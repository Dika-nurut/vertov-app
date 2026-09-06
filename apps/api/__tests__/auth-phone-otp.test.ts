import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Phone OTP — full send → verify → sign-up smoke.
 *
 * With PHONE_AUTH_ENABLED=1 and the SMSC credentials CLEARED below, the OTP is captured
 * to dev state (and logged) instead of dialing out, so we can read the code back and
 * complete verification. Clearing them is the point: this suite used to merely assume no
 * creds were present, so on any box whose `.env` carries real ones it sent a live SMS —
 * and failed with a 500 when the gateway answered. A test must never depend on a
 * credential being ABSENT. — exercising the phoneNumber() plugin, sign-up-on-verification
 * (sentinel temp email), and the new `user.phone_number*` columns end to end.
 * The created user is cleaned up either side so the run is idempotent.
 */
const BASE = 'http://localhost:4000';
const TEST_PHONE = '+79990000001';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let getDevLastPhoneOtp: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;

async function purge(): Promise<void> {
  await pool.query('DELETE FROM "user" WHERE phone_number = $1', [TEST_PHONE]);
}

beforeAll(async () => {
  vi.stubEnv('PHONE_AUTH_ENABLED', '1');
  vi.stubEnv('BETTER_AUTH_URL', BASE);
  vi.stubEnv('SMSC_API_KEY', '');
  vi.stubEnv('SMSC_LOGIN', '');
  vi.stubEnv('SMSC_PASSWORD', '');
  ({ auth, getDevLastPhoneOtp } = await import('@seed/auth'));
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

describe('phone OTP sign-in', () => {
  it('sends a code, verifies it, and signs the new user in', async () => {
    const sendRes = await post('/api/auth/phone-number/send-otp', { phoneNumber: TEST_PHONE });
    expect(sendRes.status, `send-otp → ${sendRes.status}`).toBe(200);

    const otp = getDevLastPhoneOtp(TEST_PHONE);
    expect(otp?.code, 'OTP should be captured for dev').toBeTruthy();
    expect(otp.code).toHaveLength(4); // PHONE_OTP_LENGTH default (flash-call)

    const verifyRes = await post('/api/auth/phone-number/verify', {
      phoneNumber: TEST_PHONE,
      code: otp.code,
    });
    expect(verifyRes.status, `verify → ${verifyRes.status}`).toBe(200);
    const data = (await verifyRes.json()) as { status?: boolean; token?: string; user?: unknown };
    expect(data.status).toBe(true);
    // Sign-up-on-verification issues a session for the brand-new user.
    expect(data.token ?? data.user).toBeTruthy();
  });

  it('rejects a wrong code', async () => {
    await post('/api/auth/phone-number/send-otp', { phoneNumber: TEST_PHONE });
    const verifyRes = await post('/api/auth/phone-number/verify', {
      phoneNumber: TEST_PHONE,
      code: '0000',
    });
    expect(verifyRes.status).not.toBe(200);
  });
});
