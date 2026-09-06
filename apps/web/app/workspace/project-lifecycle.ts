export type ProjectFetch = typeof fetch;

export interface ProjectRecoveryCounts {
  scripts: number;
  boards: number;
  studio: number;
  media: number;
}

export interface ProjectRestoreResult {
  ok: true;
  project: { id: string; title: string };
  recovery: {
    expected: ProjectRecoveryCounts;
    restored: ProjectRecoveryCounts;
    unavailable: ProjectRecoveryCounts;
    partial: boolean;
  };
  message: 'restored' | 'restored_partially';
}

export class ProjectLifecycleError extends Error {
  constructor(
    readonly code:
      | 'title_required'
      | 'request_failed'
      | 'name_collision'
      | 'retention_expired'
      | 'confirmation_mismatch',
    readonly status?: number,
    readonly suggestedTitle?: string,
  ) {
    super(code);
    this.name = 'ProjectLifecycleError';
  }
}

export function projectTitle(value: string): string {
  const title = value.trim();
  if (!title) throw new ProjectLifecycleError('title_required');
  return title;
}

async function projectRequest(
  fetcher: ProjectFetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetcher(url, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: unknown;
      suggestedTitle?: unknown;
    } | null;
    const error = payload?.error;
    if (error === 'name_collision') {
      throw new ProjectLifecycleError(
        'name_collision',
        response.status,
        typeof payload?.suggestedTitle === 'string' ? payload.suggestedTitle : undefined,
      );
    }
    if (error === 'retention_expired') {
      throw new ProjectLifecycleError('retention_expired', response.status);
    }
    if (error === 'confirmation_mismatch') {
      throw new ProjectLifecycleError('confirmation_mismatch', response.status);
    }
    throw new ProjectLifecycleError('request_failed', response.status);
  }
  return response;
}

export async function createWorkspaceProject(
  fetcher: ProjectFetch,
  apiUrl: string,
  titleInput: string,
): Promise<string> {
  const title = projectTitle(titleInput);
  const response = await projectRequest(fetcher, `${apiUrl}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  const payload = (await response.json()) as { id?: unknown };
  if (typeof payload.id !== 'string' || payload.id.length === 0) {
    throw new ProjectLifecycleError('request_failed', response.status);
  }
  return payload.id;
}

export async function renameWorkspaceProject(
  fetcher: ProjectFetch,
  apiUrl: string,
  projectId: string,
  titleInput: string,
): Promise<void> {
  const title = projectTitle(titleInput);
  await projectRequest(fetcher, `${apiUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function deleteWorkspaceProject(
  fetcher: ProjectFetch,
  apiUrl: string,
  projectId: string,
): Promise<void> {
  await projectRequest(fetcher, `${apiUrl}/v1/projects/${encodeURIComponent(projectId)}`, {
    method: 'DELETE',
  });
}

export async function restoreWorkspaceProject(
  fetcher: ProjectFetch,
  apiUrl: string,
  projectId: string,
  titleInput?: string,
): Promise<ProjectRestoreResult> {
  const body = titleInput === undefined ? {} : { title: projectTitle(titleInput) };
  const response = await projectRequest(
    fetcher,
    `${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
  const payload = (await response.json()) as ProjectRestoreResult;
  if (
    payload.ok !== true ||
    !payload.project ||
    typeof payload.project.id !== 'string' ||
    !payload.recovery
  ) {
    throw new ProjectLifecycleError('request_failed', response.status);
  }
  return payload;
}

export async function permanentlyDeleteWorkspaceProject(
  fetcher: ProjectFetch,
  apiUrl: string,
  projectId: string,
  confirmation: string,
): Promise<void> {
  await projectRequest(
    fetcher,
    `${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/permanent`,
    {
      method: 'DELETE',
      body: JSON.stringify({ confirmation }),
    },
  );
}

export function projectLifecycleErrorCopy(error: unknown): string {
  if (error instanceof ProjectLifecycleError && error.code === 'title_required') {
    return 'Введите название проекта.';
  }
  if (error instanceof ProjectLifecycleError && error.code === 'name_collision') {
    return 'Проект с таким названием уже существует. Укажите другое название.';
  }
  if (error instanceof ProjectLifecycleError && error.code === 'retention_expired') {
    return 'Срок хранения истёк. Проект уже нельзя восстановить.';
  }
  if (error instanceof ProjectLifecycleError && error.code === 'confirmation_mismatch') {
    return 'Название не совпадает. Введите его точно, чтобы удалить проект навсегда.';
  }
  return 'Не удалось сохранить изменения. Проверьте соединение и попробуйте ещё раз.';
}

export type SelectedProjectKeyAction = 'open' | 'rename' | 'delete' | 'clear' | null;

export function selectedProjectKeyAction(key: string): SelectedProjectKeyAction {
  if (key === 'Enter') return 'open';
  if (key === 'F2') return 'rename';
  if (key === 'Delete' || key === 'Backspace') return 'delete';
  if (key === 'Escape') return 'clear';
  return null;
}
