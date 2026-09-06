import { describe, expect, it } from 'vitest';
import { isKnownMobileRoute } from './mobile-routes';

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
});
