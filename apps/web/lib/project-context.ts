export const PROJECT_CONTEXT_STORAGE_KEY = 'sreda:active-desk';
const PROJECT_PRODUCT_PATH = /^\/(scenario|boards|studio|generate|gallery)(\/|$)/;

export function isProjectProductPath(pathname: string): boolean {
  return PROJECT_PRODUCT_PATH.test(pathname);
}

export type ParsedProjectContext =
  | { mode: 'standalone' }
  | { mode: 'invalid'; reason: 'malformed' }
  | { mode: 'project'; projectId: string };

export type ProjectIdSearchValue = string | string[] | undefined;

export function parseProjectIdSearchValue(value: ProjectIdSearchValue): ParsedProjectContext {
  if (value === undefined) return { mode: 'standalone' };
  const values = Array.isArray(value) ? value : [value];
  const projectId = values[0]?.trim() ?? '';
  if (values.length !== 1 || projectId.length === 0 || projectId.length > 160) {
    return { mode: 'invalid', reason: 'malformed' };
  }
  return { mode: 'project', projectId };
}

export type ProjectContextState =
  | { mode: 'standalone' }
  | { mode: 'loading'; projectId: string | null }
  | {
      mode: 'valid';
      project: { id: string; title: string; returnHref: string };
    }
  | {
      mode: 'invalid';
      projectId: string | null;
      reason: 'malformed' | 'not_found' | 'unavailable';
    };

export function parseProjectContext(search: string): ParsedProjectContext {
  const params = new URLSearchParams(search);
  return parseProjectIdSearchValue(
    params.has('projectId') ? params.getAll('projectId') : undefined,
  );
}

export function withProjectContext(href: string, projectId: string): string {
  const url = new URL(href, 'https://vertov.local');
  url.searchParams.set('projectId', projectId);
  if (/^https?:\/\//i.test(href)) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export function withoutProjectContext(href: string): string {
  const url = new URL(href, 'https://vertov.local');
  url.searchParams.delete('projectId');
  if (/^https?:\/\//i.test(href)) return url.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function loadValidatedProjectContext(
  fetcher: typeof fetch,
  apiUrl: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectContextState> {
  try {
    const response = await fetcher(
      `${apiUrl.replace(/\/$/, '')}/v1/projects/${encodeURIComponent(projectId)}`,
      { credentials: 'include', ...(signal ? { signal } : {}) },
    );
    if (response.status === 404) return { mode: 'invalid', projectId, reason: 'not_found' };
    if (!response.ok) return { mode: 'invalid', projectId, reason: 'unavailable' };
    const payload = (await response.json()) as { id?: unknown; title?: unknown };
    if (payload.id !== projectId || typeof payload.title !== 'string' || !payload.title.trim()) {
      return { mode: 'invalid', projectId, reason: 'unavailable' };
    }
    return {
      mode: 'valid',
      project: {
        id: projectId,
        title: payload.title,
        returnHref: `/workspace/${encodeURIComponent(projectId)}`,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return { mode: 'invalid', projectId, reason: 'unavailable' };
  }
}
