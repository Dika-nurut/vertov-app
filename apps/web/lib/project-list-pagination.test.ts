import { describe, expect, it } from 'vitest';
import { appendUniquePage, projectListPageUrl } from './project-list-pagination';

describe('project product pagination', () => {
  it('preserves project identity and the opaque cursor', () => {
    expect(
      projectListPageUrl('https://api.seed.test', '/v1/boards', 'project/one', 'opaque+cursor='),
    ).toBe(
      'https://api.seed.test/v1/boards?limit=50&projectId=project%2Fone&cursor=opaque%2Bcursor%3D',
    );
  });

  it('appends a page without duplicate boundary rows', () => {
    expect(appendUniquePage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }])).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });
});
