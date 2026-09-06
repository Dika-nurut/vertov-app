import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * RU social login — initiation smoke.
 *
 * With dummy VK + Yandex creds present, the sign-in endpoints must mount and
 * hand back the provider's *authorization URL* (the consent screen), proving the
 * native `vk` provider and the `genericOAuth` Yandex config are wired correctly:
 *   - VK ID    → id.vk.com/authorize, with PKCE (S256) auto-applied
 *   - Yandex   → oauth.yandex.ru/authorize, scopes + our callback path
 * We can't complete consent here (that needs the real IdP), but reaching the
 * provider URL is the part our config owns. Env is stubbed BEFORE the dynamic
 * import because the provider gating reads process.env at module load.
 */
const BASE = 'http://localhost:4000';
const CALLBACK = 'http://localhost:3000/generate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let auth: any;

beforeAll(async () => {
  vi.stubEnv('VK_CLIENT_ID', 'vk-test-client');
  vi.stubEnv('VK_CLIENT_SECRET', 'vk-test-secret');
  vi.stubEnv('YANDEX_CLIENT_ID', 'yandex-test-client');
  vi.stubEnv('YANDEX_CLIENT_SECRET', 'yandex-test-secret');
  vi.stubEnv('MAILRU_CLIENT_ID', 'mailru-test-client');
  vi.stubEnv('MAILRU_CLIENT_SECRET', 'mailru-test-secret');
  vi.stubEnv('OK_CLIENT_ID', 'ok-test-client');
  vi.stubEnv('OK_CLIENT_SECRET', 'ok-test-secret');
  vi.stubEnv('OK_PUBLIC_KEY', 'ok-test-public-key');
  vi.stubEnv('BETTER_AUTH_URL', BASE);
  // Import only after env is in place so the *_ENABLED gates all latch on.
  ({ auth } = await import('@seed/auth'));
});

afterAll(() => {
  vi.unstubAllEnvs();
});

async function initiate(path: string, body: Record<string, unknown>): Promise<{ url?: string }> {
  const res = await auth.handler(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, callbackURL: CALLBACK }),
    }),
  );
  expect(res.status, `${path} → ${res.status}`).toBe(200);
  return res.json();
}

describe('VK ID sign-in initiation', () => {
  it('returns the VK authorization URL with our callback + PKCE', async () => {
    const { url } = await initiate('/api/auth/sign-in/social', { provider: 'vk' });
    expect(url, 'expected a redirect url').toBeTruthy();
    const u = new URL(url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://id.vk.com/authorize');
    expect(u.searchParams.get('client_id')).toBe('vk-test-client');
    expect(u.searchParams.get('redirect_uri')).toContain('/api/auth/callback/vk');
    // VK ID is OAuth 2.1 → PKCE must be applied automatically.
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('Yandex sign-in initiation', () => {
  it('returns the Yandex authorization URL with scopes + our callback', async () => {
    const { url } = await initiate('/api/auth/sign-in/oauth2', { providerId: 'yandex' });
    expect(url, 'expected a redirect url').toBeTruthy();
    const u = new URL(url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://oauth.yandex.ru/authorize');
    expect(u.searchParams.get('client_id')).toBe('yandex-test-client');
    expect(u.searchParams.get('redirect_uri')).toContain('/api/auth/oauth2/callback/yandex');
    expect(u.searchParams.get('scope') ?? '').toContain('login:email');
  });
});

describe('Mail.ru ID sign-in initiation', () => {
  it('returns the Mail.ru authorization URL with our callback', async () => {
    const { url } = await initiate('/api/auth/sign-in/oauth2', { providerId: 'mailru' });
    expect(url, 'expected a redirect url').toBeTruthy();
    const u = new URL(url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://oauth.mail.ru/login');
    expect(u.searchParams.get('client_id')).toBe('mailru-test-client');
    expect(u.searchParams.get('redirect_uri')).toContain('/api/auth/oauth2/callback/mailru');
  });
});

describe('Odnoklassniki sign-in initiation', () => {
  it('returns the OK authorization URL with our callback', async () => {
    const { url } = await initiate('/api/auth/sign-in/oauth2', { providerId: 'ok' });
    expect(url, 'expected a redirect url').toBeTruthy();
    const u = new URL(url as string);
    expect(`${u.origin}${u.pathname}`).toBe('https://connect.ok.ru/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('ok-test-client');
    expect(u.searchParams.get('redirect_uri')).toContain('/api/auth/oauth2/callback/ok');
  });
});
