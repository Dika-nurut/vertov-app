import { describe, expect, it, vi } from 'vitest';
import {
  isProjectProductPath,
  loadValidatedProjectContext,
  parseProjectContext,
  parseProjectIdSearchValue,
  withProjectContext,
  withoutProjectContext,
} from './project-context';

describe('project context browser contract', () => {
  it('limits project context to the five product route families', () => {
    for (const pathname of [
      '/scenario/script-1',
      '/boards',
      '/studio/projects/cut-1',
      '/generate',
      '/gallery/job-1',
    ]) {
      expect(isProjectProductPath(pathname)).toBe(true);
    }
    for (const pathname of ['/', '/login', '/workspace/project-1', '/settings']) {
      expect(isProjectProductPath(pathname)).toBe(false);
    }
  });

  it('distinguishes standalone, valid, and malformed explicit context', () => {
    expect(parseProjectContext('?tab=all')).toEqual({ mode: 'standalone' });
    expect(parseProjectContext('?projectId=project-1')).toEqual({
      mode: 'project',
      projectId: 'project-1',
    });
    expect(parseProjectContext('?projectId=')).toEqual({ mode: 'invalid', reason: 'malformed' });
    expect(parseProjectContext('?projectId=a&projectId=b')).toEqual({
      mode: 'invalid',
      reason: 'malformed',
    });
    expect(parseProjectIdSearchValue(undefined)).toEqual({ mode: 'standalone' });
    expect(parseProjectIdSearchValue('project-1')).toEqual({
      mode: 'project',
      projectId: 'project-1',
    });
    expect(parseProjectIdSearchValue(['project-1', 'project-2'])).toEqual({
      mode: 'invalid',
      reason: 'malformed',
    });
  });

  it('preserves or intentionally removes context without dropping other link state', () => {
    expect(withProjectContext('/boards?view=list#new', 'project/a')).toBe(
      '/boards?view=list&projectId=project%2Fa#new',
    );
    expect(withoutProjectContext('/boards?view=list&projectId=old#new')).toBe(
      '/boards?view=list#new',
    );
  });

  it('loads a live owned project into the unambiguous shared shape', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'project-1', title: 'Ночное кафе' }));
    await expect(
      loadValidatedProjectContext(fetcher as typeof fetch, 'https://api.test/', 'project-1'),
    ).resolves.toEqual({
      mode: 'valid',
      project: {
        id: 'project-1',
        title: 'Ночное кафе',
        returnHref: '/workspace/project-1',
      },
    });
    expect(fetcher).toHaveBeenCalledWith('https://api.test/v1/projects/project-1', {
      credentials: 'include',
    });
  });

  it('never turns a missing, foreign, deleted, or failed validation into standalone mode', async () => {
    for (const status of [404, 500]) {
      const fetcher = vi.fn(async () => new Response(null, { status }));
      const state = await loadValidatedProjectContext(
        fetcher as typeof fetch,
        'https://api.test',
        'unavailable',
      );
      expect(state).toMatchObject({
        mode: 'invalid',
        projectId: 'unavailable',
        reason: status === 404 ? 'not_found' : 'unavailable',
      });
    }
  });
});
