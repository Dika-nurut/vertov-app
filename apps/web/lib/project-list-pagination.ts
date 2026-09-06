export function projectListPageUrl(
  apiUrl: string,
  path: '/v1/scripts' | '/v1/boards' | '/v1/studio/projects',
  projectId: string | null,
  cursor: string,
): string {
  const url = new URL(path, `${apiUrl.replace(/\/$/, '')}/`);
  url.searchParams.set('limit', '50');
  if (projectId) url.searchParams.set('projectId', projectId);
  url.searchParams.set('cursor', cursor);
  return url.toString();
}

export function appendUniquePage<T extends { id: string }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
}
