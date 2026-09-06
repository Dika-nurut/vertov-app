import { describe, expect, it } from 'vitest';
import { boardSceneObjectSchema } from '@seed/shared/board-contract';
import {
  mergeSceneObjects,
  projectSceneObjectExtraction,
  projectSceneObjects,
} from './scene-object-response';

describe('projectSceneObjects', () => {
  it('persists grounded descriptions, drops extraction-only fields, and de-duplicates in response order', () => {
    const stored = projectSceneObjects([
      {
        kind: 'person',
        name: 'Анна',
        description: 'Первое описание Анны.',
        quotes: ['A quote the board does not store'],
      },
      {
        kind: 'person',
        name: '  АННА ',
        description: 'Позднее дублирующее описание.',
        quotes: ['Another quote'],
      },
      { kind: 'place', name: 'Кафе', description: 'Окно и вечерний свет.' },
    ]);

    expect(stored).toEqual([
      { kind: 'person', name: 'Анна', description: 'Первое описание Анны.' },
      { kind: 'place', name: 'Кафе', description: 'Окно и вечерний свет.' },
    ]);
    expect(boardSceneObjectSchema.array().safeParse(stored).success).toBe(true);
  });

  it('projects the complete extraction envelope with its source hash', () => {
    const sourceHash = 'a'.repeat(64);
    expect(
      projectSceneObjectExtraction({
        objects: [
          {
            kind: 'thing',
            name: 'Флакон',
            description: 'Синий флакон на столе.',
            quotes: ['На столе стоит синий флакон.'],
          },
        ],
        sourceHash,
        sourceTruncated: false,
      }),
    ).toEqual({
      objects: [{ kind: 'thing', name: 'Флакон', description: 'Синий флакон на столе.' }],
      objectsSourceHash: sourceHash,
      sourceTruncated: false,
    });
    expect(projectSceneObjectExtraction({ objects: [], sourceHash: 'invalid' })).toBeNull();
  });
});

describe('mergeSceneObjects', () => {
  it('keeps matching cast links, takes the new description, retains missing linked chips, and drops missing unlinked chips', () => {
    const result = mergeSceneObjects({
      existing: [
        {
          kind: 'person',
          name: 'Анна',
          description: 'Старое описание.',
          castNodeId: 'cast-anna',
          absentFromLatestExtraction: true,
        },
        { kind: 'place', name: 'Кафе', description: 'Больше не нужно.' },
        {
          kind: 'thing',
          name: 'Флакон',
          description: 'Старое описание флакона.',
          castNodeId: 'cast-flacon',
        },
      ],
      extracted: [
        { kind: 'person', name: '  АННА ', description: 'Новое описание Анны.' },
        { kind: 'person', name: 'Официант', description: 'Приносит счёт.' },
      ],
    });

    expect(result).toEqual({
      ok: true,
      objects: [
        {
          kind: 'person',
          name: '  АННА ',
          description: 'Новое описание Анны.',
          castNodeId: 'cast-anna',
        },
        { kind: 'person', name: 'Официант', description: 'Приносит счёт.' },
        {
          kind: 'thing',
          name: 'Флакон',
          description: 'Старое описание флакона.',
          castNodeId: 'cast-flacon',
          absentFromLatestExtraction: true,
        },
      ],
    });
  });

  it('refuses an unsaveable union rather than silently losing a retained linked chip', () => {
    const result = mergeSceneObjects({
      existing: [
        {
          kind: 'person',
          name: 'Старый объект',
          description: 'Ссылка должна сохраниться.',
          castNodeId: 'cast-old',
        },
      ],
      extracted: Array.from({ length: 12 }, (_, index) => ({
        kind: 'person' as const,
        name: `Новый объект ${index}`,
        description: `Описание ${index}`,
      })),
    });

    expect(result).toEqual({ ok: false, reason: 'object_limit', limit: 12, required: 13 });
  });
});
