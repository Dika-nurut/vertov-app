import { describe, expect, it, vi } from 'vitest';
import {
  createWorkspaceProject,
  deleteWorkspaceProject,
  permanentlyDeleteWorkspaceProject,
  ProjectLifecycleError,
  projectLifecycleErrorCopy,
  renameWorkspaceProject,
  restoreWorkspaceProject,
  selectedProjectKeyAction,
} from './project-lifecycle';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('workspace project lifecycle', () => {
  it('creates a project with a trimmed non-empty title', async () => {
    const fetcher = vi.fn(async () => response({ id: 'project-1' }, 201));
    await expect(
      createWorkspaceProject(fetcher as typeof fetch, 'https://api.test', '  Ночное кафе  '),
    ).resolves.toBe('project-1');
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/v1/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Ночное кафе' }),
        credentials: 'include',
      }),
    );
  });

  it('rejects an empty title without sending a request', async () => {
    const fetcher = vi.fn();
    await expect(
      createWorkspaceProject(fetcher as typeof fetch, 'https://api.test', '   '),
    ).rejects.toMatchObject({ code: 'title_required' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('renames and soft-deletes the selected owned project through its canonical routes', async () => {
    const fetcher = vi.fn(async () => response({ ok: true }));
    await renameWorkspaceProject(
      fetcher as typeof fetch,
      'https://api.test',
      'project/one',
      '  Новый титр ',
    );
    await deleteWorkspaceProject(fetcher as typeof fetch, 'https://api.test', 'project/one');
    expect(fetcher.mock.calls).toEqual([
      [
        'https://api.test/v1/projects/project%2Fone',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ title: 'Новый титр' }),
        }),
      ],
      ['https://api.test/v1/projects/project%2Fone', expect.objectContaining({ method: 'DELETE' })],
    ]);
  });

  it('surfaces request errors with honest Russian copy', async () => {
    const fetcher = vi.fn(async () => response({ error: 'not_found' }, 404));
    const promise = deleteWorkspaceProject(fetcher as typeof fetch, 'https://api.test', 'missing');
    await expect(promise).rejects.toEqual(new ProjectLifecycleError('request_failed', 404));
    await expect(promise.catch(projectLifecycleErrorCopy)).resolves.toContain(
      'Не удалось сохранить изменения',
    );
  });

  it('restores normally and carries an explicit collision suggestion', async () => {
    const recovery = {
      expected: { scripts: 1, boards: 1, studio: 1, media: 1 },
      restored: { scripts: 1, boards: 1, studio: 1, media: 0 },
      unavailable: { scripts: 0, boards: 0, studio: 0, media: 1 },
      partial: true,
    };
    const restored = vi.fn(async () =>
      response({
        ok: true,
        project: { id: 'project-1', title: 'Архив' },
        recovery,
        message: 'restored_partially',
      }),
    );
    await expect(
      restoreWorkspaceProject(restored as typeof fetch, 'https://api.test', 'project-1'),
    ).resolves.toMatchObject({ message: 'restored_partially', recovery });
    expect(restored).toHaveBeenCalledWith(
      'https://api.test/v1/projects/project-1/restore',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );

    const collision = vi.fn(async () =>
      response(
        {
          error: 'name_collision',
          suggestedTitle: 'Архив (восстановлен)',
        },
        409,
      ),
    );
    await expect(
      restoreWorkspaceProject(collision as typeof fetch, 'https://api.test', 'project-1'),
    ).rejects.toMatchObject({
      code: 'name_collision',
      suggestedTitle: 'Архив (восстановлен)',
    });
  });

  it('sends the exact typed title for strongly confirmed permanent deletion', async () => {
    const fetcher = vi.fn(async () => response({ ok: true, permanentlyDeleted: true }));
    await permanentlyDeleteWorkspaceProject(
      fetcher as typeof fetch,
      'https://api.test',
      'project/one',
      'Точный заголовок',
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.test/v1/projects/project%2Fone/permanent',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ confirmation: 'Точный заголовок' }),
      }),
    );
  });

  it('maps keyboard access without inventing destructive shortcuts', () => {
    expect(selectedProjectKeyAction('Enter')).toBe('open');
    expect(selectedProjectKeyAction('F2')).toBe('rename');
    expect(selectedProjectKeyAction('Delete')).toBe('delete');
    expect(selectedProjectKeyAction('Escape')).toBe('clear');
    expect(selectedProjectKeyAction('x')).toBeNull();
  });
});
