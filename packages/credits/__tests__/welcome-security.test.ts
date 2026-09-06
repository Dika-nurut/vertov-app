import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cogsBreakerTrips,
  clusterKeyFor,
  isDisposableEmail,
  normalizePhoneE164,
  networkPrefix,
  registrationVelocityKey,
  shouldAttemptWelcomeEnrollment,
  verifySmartCaptchaToken,
} from '../src/index';

describe('welcome anti-farm and signup policy', () => {
  it('clusters on cookie+/24 (distinct devices stay distinct) but keys velocity on /24 alone', () => {
    // Distinct device cookies behind the SAME /24 are DISTINCT clusters, so legit
    // shared-NAT (CGNAT) users are not collectively capped; a farmer clearing the
    // cookie is instead caught by the cookie-independent /24 velocity key.
    expect(clusterKeyFor('cookie-a', '203.0.113.10')).not.toBe(
      clusterKeyFor('cookie-cleared', '203.0.113.10'),
    );
    expect(clusterKeyFor('cookie-a', '203.0.113.10')).toBe(
      clusterKeyFor('cookie-a', '203.0.113.10'),
    );
    expect(registrationVelocityKey('203.0.113.10')).toBe(registrationVelocityKey('203.0.113.11'));
    expect(registrationVelocityKey('198.51.100.10')).not.toBe(
      registrationVelocityKey('203.0.113.10'),
    );
    expect(networkPrefix('203.0.113.10')).toBe('203.0.113.0/24');
  });

  it('recognizes maintained disposable-email domains', () => {
    expect(isDisposableEmail('attacker@mailinator.com')).toBe(true);
    expect(isDisposableEmail('person@seed.local')).toBe(false);
  });

  it('enrolls an anonymous conversion even when users_app was pre-created', () => {
    expect(shouldAttemptWelcomeEnrollment(false)).toBe(true); // ensureUserRows: created=false
    expect(shouldAttemptWelcomeEnrollment(true)).toBe(false);
  });

  it('trips the free-COGS breaker above 3% of rolling revenue', () => {
    expect(cogsBreakerTrips({ freeCogsRub: 3.01, revenueRub: 100 })).toBe(true);
    expect(cogsBreakerTrips({ freeCogsRub: 3, revenueRub: 100 })).toBe(false);
    expect(cogsBreakerTrips({ freeCogsRub: 1, revenueRub: 0 })).toBe(true);
  });

  it('returns a clearly invalid marker for non-E.164 phone garbage', () => {
    expect(normalizePhoneE164('123456')).toBeNull();
    expect(normalizePhoneE164('not a phone')).toBeNull();
  });
});

describe('Yandex SmartCaptcha verification', () => {
  afterEach(() => vi.restoreAllMocks());

  it('rejects a bad token when verification is enabled', async () => {
    vi.stubEnv('YANDEX_SMARTCAPTCHA_SERVER_KEY', 'server-secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'failed' }), { status: 200 })),
    );

    await expect(verifySmartCaptchaToken('bad-token')).resolves.toBe(false);
  });

  it('refuses a missing token without making a network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifySmartCaptchaToken('')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
