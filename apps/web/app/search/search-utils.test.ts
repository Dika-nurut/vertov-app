import { describe, expect, it } from 'vitest';
import {
  associationLabel,
  createLatestRequestGuard,
  flattenSearchGroups,
  searchIndexForKey,
  splitSearchMatch,
} from '../../components/search/search-utils';
import type { SearchResult } from '../../components/search/types';

const standalone: SearchResult = {
  type: 'script',
  id: 'script-1',
  title: 'Needle',
  href: '/scenario/script-1',
  mediaKind: null,
  thumbnailUrl: null,
  projects: [],
  projectCount: 0,
  association: 'standalone',
  updatedAt: '2026-07-24T00:00:00.000Z',
};

describe('search result utilities', () => {
  it('splits literal matches without creating or interpreting HTML', () => {
    expect(splitSearchMatch('<img onerror=alert(1)> NEEDLE', 'needle')).toEqual([
      { text: '<img onerror=alert(1)> ', match: false },
      { text: 'NEEDLE', match: true },
    ]);
    expect(splitSearchMatch('A [literal] value', '[literal]')).toEqual([
      { text: 'A ', match: false },
      { text: '[literal]', match: true },
      { text: ' value', match: false },
    ]);
  });

  it('preserves fixed group ordering when flattened', () => {
    expect(
      flattenSearchGroups([
        { type: 'script', items: [standalone] },
        { type: 'media', items: [{ ...standalone, id: 'media-1', type: 'media' }] },
      ]).map((item) => item.id),
    ).toEqual(['script-1', 'media-1']);
  });

  it('makes standalone and multiple associations explicit', () => {
    expect(associationLabel(standalone)).toBe('Самостоятельный объект');
    expect(
      associationLabel({
        ...standalone,
        type: 'media',
        association: 'multiple',
        projects: [
          { id: 'p1', title: 'Alpha' },
          { id: 'p2', title: 'Beta' },
        ],
        projectCount: 2,
      }),
    ).toBe('В 2 проектах: Alpha, Beta');
  });

  it('covers the complete list-navigation key set at its boundaries', () => {
    expect(searchIndexForKey('ArrowDown', -1, 3)).toBe(0);
    expect(searchIndexForKey('ArrowDown', 2, 3)).toBe(2);
    expect(searchIndexForKey('ArrowUp', -1, 3)).toBe(2);
    expect(searchIndexForKey('ArrowUp', 0, 3)).toBe(0);
    expect(searchIndexForKey('Home', 2, 3)).toBe(0);
    expect(searchIndexForKey('End', 0, 3)).toBe(2);
    expect(searchIndexForKey('Tab', 1, 3)).toBeNull();
    expect(searchIndexForKey('ArrowDown', 0, 0)).toBeNull();
  });

  it('rejects stale responses after a newer request or invalidation', () => {
    const guard = createLatestRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
    guard.invalidate();
    expect(guard.isCurrent(second)).toBe(false);
  });
});
