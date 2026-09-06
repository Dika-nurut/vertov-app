import { describe, expect, it } from 'vitest';
import { DEV_AUTH_SECRET, resolveAuthSecret, shouldUseSecureCookies } from '@seed/auth';

/**
 * BL-12 — Secure session cookie hinges on env; auth secret defaults to a dev value.
 *
 * Pre-fix, `BETTER_AUTH_SECRET` silently fell back to `dev-secret-change-me`
 * (forgeable sessions) and the cookie `Secure` flag was derived only from
 * whether `BETTER_AUTH_URL` happened to be `https://`. These assertions encode
 * the fail-closed contract: production refuses the default/missing secret, and
 * production always forces `Secure`. The helpers are wired into
 * `packages/auth/src/index.ts` (boot throws; `advanced.useSecureCookies`).
 */
describe('BL-12: auth secret fails closed in production', () => {
  it('throws when BETTER_AUTH_SECRET is the dev default in production', () => {
    expect(() =>
      resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: DEV_AUTH_SECRET }),
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('throws when BETTER_AUTH_SECRET is unset or blank in production', () => {
    expect(() => resolveAuthSecret({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: '   ' }),
    ).toThrow();
  });

  it('accepts a strong, non-default secret in production', () => {
    const strong = 'b3b1f0c7e9d24a1f8c6e0a2b4d6f8091';
    expect(resolveAuthSecret({ NODE_ENV: 'production', BETTER_AUTH_SECRET: strong })).toBe(strong);
  });

  it('keeps the dev default outside production so local/e2e need no config', () => {
    expect(resolveAuthSecret({ NODE_ENV: 'development' })).toBe(DEV_AUTH_SECRET);
    expect(resolveAuthSecret({})).toBe(DEV_AUTH_SECRET);
  });
});

describe('BL-12: session cookies carry Secure', () => {
  it('forces Secure in production regardless of the baseURL scheme', () => {
    expect(
      shouldUseSecureCookies({ NODE_ENV: 'production', BETTER_AUTH_URL: 'http://localhost:4000' }),
    ).toBe(true);
    expect(shouldUseSecureCookies({ NODE_ENV: 'production' })).toBe(true);
  });

  it('tracks an https public URL in non-production, and stays off for plain-http dev', () => {
    expect(
      shouldUseSecureCookies({
        NODE_ENV: 'development',
        BETTER_AUTH_URL: 'https://app.seed.local',
      }),
    ).toBe(true);
    // The dev/e2e origin is plain http (cookie must NOT be Secure there or login breaks).
    expect(
      shouldUseSecureCookies({ NODE_ENV: 'development', BETTER_AUTH_URL: 'http://109.199.97.163' }),
    ).toBe(false);
  });
});
