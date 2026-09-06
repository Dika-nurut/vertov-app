import type { SearchGroup, SearchResult } from './types';

export const SEARCH_QUERY_MAX = 100;

export interface MatchPart {
  text: string;
  match: boolean;
}

/** Produces React-safe text segments; callers render them as nodes, never HTML. */
export function splitSearchMatch(value: string, rawQuery: string): MatchPart[] {
  const query = rawQuery.trim();
  if (!query) return [{ text: value, match: false }];
  const expression = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu');
  return value
    .split(expression)
    .filter(Boolean)
    .map((text) => ({
      text,
      match: text.toLocaleLowerCase('ru-RU') === query.toLocaleLowerCase('ru-RU'),
    }));
}

export function flattenSearchGroups(groups: SearchGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.items);
}

export function searchIndexForKey(
  key: string,
  currentIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) return null;
  if (key === 'ArrowDown') return Math.min(itemCount - 1, currentIndex < 0 ? 0 : currentIndex + 1);
  if (key === 'ArrowUp') return Math.max(0, currentIndex < 0 ? itemCount - 1 : currentIndex - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  return null;
}

export function createLatestRequestGuard() {
  let current = 0;
  return {
    begin(): number {
      current += 1;
      return current;
    },
    invalidate(): void {
      current += 1;
    },
    isCurrent(request: number): boolean {
      return request === current;
    },
  };
}

export function associationLabel(result: SearchResult): string {
  if (result.type === 'project') return 'Проект';
  if (result.association === 'standalone') {
    return result.type === 'media' ? 'Личная библиотека · без проекта' : 'Самостоятельный объект';
  }
  if (result.association === 'multiple') {
    const suffix = result.projectCount > result.projects.length ? ', …' : '';
    return `В ${result.projectCount} проектах: ${result.projects.map((project) => project.title).join(', ')}${suffix}`;
  }
  return result.projects[0]?.title ?? 'Проект';
}
