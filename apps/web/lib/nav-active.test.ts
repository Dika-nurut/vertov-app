import { describe, expect, it } from 'vitest';
import { isNavItemActive } from './nav-active';

describe('primary navigation active matching', () => {
  it('keeps exact-only Generate matching', () => {
    expect(isNavItemActive('/generate', { href: '/generate' })).toBe(true);
    expect(isNavItemActive('/generate/history', { href: '/generate' })).toBe(false);
  });

  it('matches document descendants under a normal list URL', () => {
    expect(isNavItemActive('/boards/board-1', { href: '/boards' })).toBe(true);
    expect(isNavItemActive('/boardroom', { href: '/boards' })).toBe(false);
  });

  it('allows Studio documents to light the Studio tab', () => {
    const studio = { href: '/studio/projects', activePrefix: '/studio' };
    expect(isNavItemActive('/studio/projects', studio)).toBe(true);
    expect(isNavItemActive('/studio/abc123', studio)).toBe(true);
    expect(isNavItemActive('/studiox/abc123', studio)).toBe(false);
  });
});
