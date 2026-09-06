import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsErrorBucket,
  countBucket,
  creditBucket,
  PlausibleEvent,
  sendAttribution,
  trackSignupStarted,
  trackEvent,
} from './PlausibleEvents';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Plausible funnel contract', () => {
  it('exposes only the canonical event names used by the funnel', () => {
    expect(PlausibleEvent.checkoutCompleted).toBe('checkout_completed');
    expect(PlausibleEvent.generateSucceeded).toBe('generate_succeeded');
    expect(PlausibleEvent.landingCta).toBe('landing_cta');
    expect(PlausibleEvent.checkoutFailed).toBe('checkout_failed');
    expect(PlausibleEvent.supportContact).toBe('support_contact');
  });

  it('buckets exact credit grants before checkout analytics', () => {
    expect(creditBucket(130)).toBe('S');
    expect(creditBucket(4_500)).toBe('M');
    expect(creditBucket(32_500)).toBe('L');
    expect(creditBucket(Number.NaN)).toBe('S');
  });

  it('buckets error codes and counts without forwarding raw values', () => {
    expect(analyticsErrorBucket('structurize_rate_limited')).toBe('rate_limited');
    expect(analyticsErrorBucket('signup_required')).toBe('auth');
    expect(analyticsErrorBucket('structurize_unusable')).toBe('validation');
    expect(analyticsErrorBucket('provider_failed')).toBe('unavailable');
    expect(countBucket(0)).toBe('0');
    expect(countBucket(4)).toBe('4-8');
    expect(countBucket(20)).toBe('9+');
  });

  it('is a no-op when the Plausible script has not loaded', () => {
    expect(() => trackEvent(PlausibleEvent.signupStarted)).not.toThrow();
  });

  it('sends signup start with a canonical method enum', () => {
    const plausible = vi.fn();
    vi.stubGlobal('window', { plausible });

    trackSignupStarted('email');

    expect(plausible).toHaveBeenCalledWith('signup_started', { props: { method: 'email' } });
  });

  it('keeps first-touch attribution when the server rejects the POST', async () => {
    const storage = new Map<string, string>([
      ['vertov_attribution', JSON.stringify({ utmSource: 'pilot', at: Date.now() })],
    ]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ user: { isAnonymous: false } }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal('fetch', fetchMock);

    await sendAttribution('https://api.example.test');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.has('vertov_attribution')).toBe(true);
  });

  it('does not attach first-touch attribution to an anonymous session', async () => {
    const storage = new Map<string, string>([
      ['vertov_attribution', JSON.stringify({ utmSource: 'pilot', at: Date.now() })],
    ]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ user: { isAnonymous: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendAttribution('https://api.example.test');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(storage.has('vertov_attribution')).toBe(true);
  });

  it('clears first-touch attribution only after a successful POST', async () => {
    const storage = new Map<string, string>([
      ['vertov_attribution', JSON.stringify({ utmSource: 'pilot', at: Date.now() })],
    ]);
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ user: { isAnonymous: false } }) })
        .mockResolvedValueOnce({ ok: true, status: 201 }),
    );

    await sendAttribution('https://api.example.test');

    expect(storage.has('vertov_attribution')).toBe(false);
  });
});
