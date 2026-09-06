/** The two entry points into global Search: its shortcut and its full page. */

/**
 * ⌘/Ctrl+K, matched on the PHYSICAL key. Russian is the product's primary
 * layout and it reports `event.key === 'к'` for the same physical KeyK, which
 * silently killed the only advertised shortcut. `code` is absent in some
 * synthetic and legacy events, so the printed key stays as a fallback there.
 */
export function isSearchShortcut(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  code?: string;
  key: string;
}): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
  if (event.code) return event.code === 'KeyK';
  return event.key.toLocaleLowerCase() === 'k';
}

/**
 * Where the compact palette hands off. It shows only the first 10 results, so
 * it has to carry both the query AND the scope currently in effect — otherwise
 * «все результаты» silently searches something else.
 */
export function allResultsHref(query: string, projectId?: string | undefined): string {
  const params = new URLSearchParams();
  const trimmed = query.trim();
  if (trimmed) params.set('q', trimmed);
  if (projectId) params.set('projectId', projectId);
  return params.size > 0 ? `/search?${params}` : '/search';
}
