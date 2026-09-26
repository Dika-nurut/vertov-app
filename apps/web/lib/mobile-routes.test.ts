import { describe, expect, it } from 'vitest';
import {
  isKnownMobileRoute,
  isMobileDesktopOnlyRoute,
  mobileGenerateHref,
  mobileRouteLabel,
} from './mobile-routes';

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

  it('labels the intercepted route RU-first with a Generate fallback', () => {
    expect(mobileRouteLabel('/boards/abc', 'ru')).toBe('Борды');
    expect(mobileRouteLabel('/studio', 'ru')).toBe('Студия');
    expect(mobileRouteLabel('/workspace', 'ru')).toBe('Среда');
    expect(mobileRouteLabel('/boards', 'en')).toBe('Boards');
    expect(mobileRouteLabel('/', 'ru')).toBe('Генерация');
    expect(mobileRouteLabel('/', 'en')).toBe('Generate');
    expect(mobileRouteLabel('/zz-nope-123', 'ru')).toBe('Генерация');
  });

  it('keeps the gated pathname out of Generate remix semantics', () => {
    expect(mobileGenerateHref('/boards/abc', 'ru')).toBe('/generate?gateFrom=%2Fboards%2Fabc');
    expect(mobileGenerateHref('/studio/one', 'en')).toBe(
      '/generate?gateFrom=%2Fstudio%2Fone&lang=en',
    );
  });
});
