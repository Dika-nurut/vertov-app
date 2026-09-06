import { describe, expect, it } from 'vitest';
import {
  folderBreadcrumbs,
  folderChildren,
  folderDescendantIds,
  folderMoveTargets,
  type FolderPayload,
} from './folder-model';

const folder = (id: string, parentId: string | null, ord: number, name = id): FolderPayload => ({
  id,
  projectId: 'project-1',
  parentId,
  name,
  ord,
  version: 1,
  createdAt: `2026-01-0${ord + 1}T00:00:00.000Z`,
  updatedAt: '2026-01-01T00:00:00.000Z',
  count: 0,
  childCount: 0,
});

const folders = [
  folder('root', null, 0),
  folder('sibling', null, 1),
  folder('scene', 'root', 0),
  folder('takes', 'scene', 0),
  folder('later', 'root', 2),
];

describe('nested folder model', () => {
  it('orders direct children without mixing levels', () => {
    expect(folderChildren(folders, null).map((item) => item.id)).toEqual(['root', 'sibling']);
    expect(folderChildren(folders, 'root').map((item) => item.id)).toEqual(['scene', 'later']);
  });

  it('builds a three-level breadcrumb path safely', () => {
    expect(folderBreadcrumbs(folders, 'takes').map((item) => item.id)).toEqual([
      'root',
      'scene',
      'takes',
    ]);
  });

  it('excludes self and descendants from accessible move targets', () => {
    expect([...folderDescendantIds(folders, 'root')]).toEqual(
      expect.arrayContaining(['scene', 'takes', 'later']),
    );
    expect(folderMoveTargets(folders, 'root').map((item) => item?.id ?? null)).toEqual([
      null,
      'sibling',
    ]);
  });

  it('does not loop forever on malformed cyclic input', () => {
    const cyclic = [folder('a', 'b', 0), folder('b', 'a', 0)];
    expect(folderBreadcrumbs(cyclic, 'a').map((item) => item.id)).toEqual(['b', 'a']);
  });
});
