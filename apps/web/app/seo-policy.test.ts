import { describe, expect, it } from 'vitest';
import robots from './robots';
import sitemap from './sitemap';

describe('P-4 preset catalog launch policy', () => {
  it('does not publish the parked catalog or its generated deep links in sitemap', () => {
    expect(sitemap().some(({ url }) => url.includes('/presets'))).toBe(false);
    expect(sitemap().some(({ url }) => url.includes('/generate?preset='))).toBe(false);
  });

  it('tells crawlers not to discover the parked catalog', () => {
    const rawRules = robots().rules;
    const rules = Array.isArray(rawRules) ? rawRules : [rawRules];
    const rule = rules.find((candidate) => candidate?.userAgent === '*');
    const disallow = rule?.disallow;
    expect(Array.isArray(disallow) ? disallow : [disallow]).toContain('/presets');
  });
});
