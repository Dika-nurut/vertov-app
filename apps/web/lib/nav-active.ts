export interface NavMatch {
  href: string;
  /** Optional canonical section prefix when the list URL is not the document URL. */
  activePrefix?: string;
}

/**
 * Return whether a primary-nav item owns the current pathname.
 *
 * Most products use their list URL as the section root. Studio is different:
 * its list is `/studio/projects`, while an open document is `/studio/:id`, so
 * callers can provide `activePrefix: '/studio'` without weakening the exact
 * match required by `/generate`.
 */
export function isNavItemActive(pathname: string, item: NavMatch): boolean {
  const section = item.activePrefix ?? item.href;
  if (section === '/generate') return pathname === section;
  return pathname === section || pathname.startsWith(`${section}/`);
}
