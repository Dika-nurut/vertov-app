import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import robots from '../robots';
import sitemap from '../sitemap';

const PAGE_SOURCE = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
const MIDDLEWARE_SOURCE = readFileSync(join(__dirname, '../../middleware.ts'), 'utf8');

describe('Wave 1.1 public /support page', () => {
  it('publishes /support in sitemap', () => {
    expect(sitemap().some(({ url }) => url === 'https://vertov.space/support')).toBe(true);
  });

  it('does not disallow /support in robots', () => {
    const rawRules = robots().rules;
    const rules = Array.isArray(rawRules) ? rawRules : [rawRules];
    const rule = rules.find((candidate) => candidate?.userAgent === '*');
    const disallow = rule?.disallow;
    const list = Array.isArray(disallow) ? disallow : [disallow];
    expect(list).not.toContain('/support');
    expect(JSON.stringify(disallow ?? null)).not.toContain('/support');
  });

  it('page exposes support contacts via SupportLink with canonical /support', () => {
    expect(PAGE_SOURCE).toContain('support@vertov.space');
    expect(PAGE_SOURCE).toContain('5 рабочих дней');
    expect(PAGE_SOURCE).toContain('SupportLink');
    expect(PAGE_SOURCE).toContain("'/support'");
    expect(PAGE_SOURCE).toContain('canonical');
    expect(PAGE_SOURCE).toContain('subject=');
    expect(PAGE_SOURCE).toContain('mailto:');
  });

  it('middleware allows public /support', () => {
    expect(MIDDLEWARE_SOURCE).toContain('/support');
    expect(MIDDLEWARE_SOURCE).toContain(String.raw`/^\/support$/`);
  });
});
