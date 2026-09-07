import { describe, expect, it } from 'vitest';
import { isKnownMobileRoute, isMobileDesktopOnlyRoute } from './mobile-routes';

describe('mobile route gate', () => {
  it('gates known app routes on small screens', () => {
    for (const p of ['/', '/boards', '/boards/abc', '/settings/billing', '/pricing', '/g/xyz']) {
      expect(isKnownMobileRoute(p), p).toBe(true);
    }
  });

  it('lets unknown paths through so not-found can render', () => {
    for (const p of ['/zz-nope-123', '/definitely-not-a-route', '/admin-secret']) {
      expect(isKnownMobileRoute(p), p).toBe(false);
    }
  });

  it('keeps only dense desktop products behind the mobile notice', () => {
    for (const p of ['/boards', '/boards/abc', '/studio', '/studio/abc', '/workspace']) {
      expect(isMobileDesktopOnlyRoute(p), p).toBe(true);
    }
    for (const p of ['/', '/generate', '/scenario', '/gallery', '/settings', '/faq', '/support']) {
      expect(isMobileDesktopOnlyRoute(p), p).toBe(false);
    }
  });
});
