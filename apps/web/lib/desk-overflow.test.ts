import { describe, expect, it } from 'vitest';
import { deskOverflowLinks } from './desk-overflow';

describe('desk overflow destinations', () => {
  it('routes every truncated source to its owning project-scoped product', () => {
    expect(
      deskOverflowLinks(
        { media: true, scenario: true, boards: true, studio: true },
        'project with space',
      ),
    ).toEqual([
      {
        key: 'media',
        label: 'Элементы',
        href: '/gallery?projectId=project%20with%20space',
      },
      {
        key: 'scenario',
        label: 'Сценарий',
        href: '/scenario?projectId=project%20with%20space',
      },
      {
        key: 'boards',
        label: 'Борды',
        href: '/boards?projectId=project%20with%20space',
      },
      {
        key: 'studio',
        label: 'Студия',
        href: '/studio/projects?projectId=project%20with%20space',
      },
    ]);
  });

  it('does not invent an overflow notice for a complete source', () => {
    expect(
      deskOverflowLinks({ media: false, scenario: false, boards: false, studio: false }, 'project'),
    ).toEqual([]);
  });
});
