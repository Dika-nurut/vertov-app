import { describe, expect, it } from 'vitest';
import { allResultsHref, isSearchShortcut } from './global-search';

describe('isSearchShortcut', () => {
  it('matches the physical KeyK under a Russian layout, where event.key is Cyrillic', () => {
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, code: 'KeyK', key: 'к' })).toBe(true);
    expect(isSearchShortcut({ metaKey: false, ctrlKey: true, code: 'KeyK', key: 'К' })).toBe(true);
  });

  it('still matches a Latin layout', () => {
    expect(isSearchShortcut({ metaKey: false, ctrlKey: true, code: 'KeyK', key: 'k' })).toBe(true);
  });

  it('falls back to the printed key when the event carries no code', () => {
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: 'K' })).toBe(true);
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, key: 'j' })).toBe(false);
  });

  it('ignores a Cyrillic к produced by a DIFFERENT physical key', () => {
    // On the RU layout «к» is KeyR under some ISO variants; the shortcut is the
    // physical position, not the glyph.
    expect(isSearchShortcut({ metaKey: true, ctrlKey: false, code: 'KeyR', key: 'к' })).toBe(false);
  });

  it('requires a modifier and rejects Alt combinations', () => {
    expect(isSearchShortcut({ metaKey: false, ctrlKey: false, code: 'KeyK', key: 'k' })).toBe(
      false,
    );
    expect(
      isSearchShortcut({ metaKey: false, ctrlKey: true, altKey: true, code: 'KeyK', key: 'k' }),
    ).toBe(false);
  });
});

describe('allResultsHref', () => {
  it('carries the query and the project scope', () => {
    const url = new URL(allResultsHref('ночное кафе', 'project-1'), 'https://vertov.local');
    expect(url.pathname).toBe('/search');
    expect(url.searchParams.get('q')).toBe('ночное кафе');
    expect(url.searchParams.get('projectId')).toBe('project-1');
  });

  it('omits the project when the scope is «вся Среда»', () => {
    expect(allResultsHref('needle')).toBe('/search?q=needle');
  });

  it('degrades to the bare page when there is nothing to carry', () => {
    expect(allResultsHref('   ')).toBe('/search');
  });
});
