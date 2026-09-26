import { describe, expect, it } from 'vitest';
import { normalizeLocale, withLocale } from './locale';

describe('locale helpers', () => {
  it('normalizes unsupported values to Russian', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('de')).toBe('ru');
    expect(normalizeLocale(undefined)).toBe('ru');
  });

  it('adds English without disturbing an existing query', () => {
    expect(withLocale('/faq', 'ru')).toBe('/faq');
    expect(withLocale('/faq', 'en')).toBe('/faq?lang=en');
    expect(withLocale('/generate?from=job', 'en')).toBe('/generate?from=job&lang=en');
  });
});
