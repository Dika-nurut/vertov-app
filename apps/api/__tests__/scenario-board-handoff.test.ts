import { describe, expect, it } from 'vitest';
import { BOARD_LIMITS } from '@seed/shared/board-contract';
import {
  boardLinksToScript,
  extractScenarioHandoffSources,
  extractScenarioHandoffScenes,
  mergeScenarioScenesIntoBoard,
  ScenarioBoardMaterializationLimitError,
} from '../src/scenario-board-handoff';

const FOUNTAIN = [
  'ИНТ. КУХНЯ — УТРО',
  '= Алиса находит письмо.',
  '',
  'Алиса открывает конверт.',
  '',
  'НАТ. ДВОР — ДЕНЬ',
  '',
  'Борис ждёт у машины.',
  '',
].join('\n');

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

describe('Board scene-source sync model', () => {
  it('extracts ordered full scene sources and a compact synopsis', () => {
    expect(extractScenarioHandoffScenes(FOUNTAIN)).toMatchObject([
      {
        ordinal: 1,
        heading: 'ИНТ. КУХНЯ — УТРО',
        synopsis: 'Алиса находит письмо.',
      },
      {
        ordinal: 2,
        heading: 'НАТ. ДВОР — ДЕНЬ',
        synopsis: 'Борис ждёт у машины.',
      },
    ]);
  });

  it('creates non-executable scene nodes with stable provenance', () => {
    const scenes = extractScenarioHandoffScenes(FOUNTAIN);
    const merged = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 4,
      scenes,
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    });

    expect(merged).toMatchObject({ added: 2, updated: 0, removed: 0 });
    expect(merged.document.nodes).toHaveLength(2);
    expect(merged.document.nodes[0]).toMatchObject({
      id: 'node-1',
      type: 'scene',
      data: {
        sourceScriptId: 'script-1',
        sourceScriptRevision: 4,
        sourceSceneId: 'source-1',
        sourceOrdinal: 1,
        sourceStatus: 'current',
      },
    });
    expect(boardLinksToScript(merged.document, 'script-1')).toBe(true);
  });

  it('projects non-Film beats into stable Board scene sources', () => {
    const sources = extractScenarioHandoffSources({
      format: 'social',
      fountain: '',
      outline: {
        version: 1,
        beats: [
          {
            id: 'hook-1',
            kind: 'hook',
            title: 'Первый кадр',
            summary: 'Сразу показывает конфликт.',
            visual: 'Крупный план',
          },
        ],
      },
    });
    const merged = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-social',
      scriptRevision: 2,
      scenes: sources,
      fullSync: true,
      makeId: ids('node-1'),
    });

    expect(sources[0]).toMatchObject({ sourceId: 'hook-1', ordinal: 1, heading: 'Первый кадр' });
    expect(merged.document.nodes[0]).toMatchObject({
      id: 'node-1',
      data: { sourceSceneId: 'hook-1', sourceText: expect.stringContaining('Крупный план') },
    });
  });

  it('prefers a stable outline source ID when its content, heading and ordinal change', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-social',
      scriptRevision: 1,
      scenes: [
        {
          sourceId: 'beat-a',
          ordinal: 1,
          heading: 'Первый кадр',
          synopsis: 'Старая завязка.',
          sourceText: 'Старая завязка.',
          sourceHash: 'a'.repeat(64),
        },
        {
          sourceId: 'beat-b',
          ordinal: 2,
          heading: 'Второй кадр',
          synopsis: 'Старый финал.',
          sourceText: 'Старый финал.',
          sourceHash: 'b'.repeat(64),
        },
      ],
      fullSync: true,
      makeId: ids('node-a', 'node-b'),
    }).document;
    const withLocalObject = {
      ...first,
      nodes: first.nodes.map((node) =>
        node.id === 'node-a'
          ? {
              ...node,
              position: { x: 777, y: 333 },
              data: {
                ...node.data,
                objects: [
                  {
                    kind: 'person' as const,
                    name: 'Алиса',
                    description: 'В красном пальто.',
                    castNodeId: 'cast-alice',
                  },
                ],
              },
            }
          : node,
      ),
    };

    const merged = mergeScenarioScenesIntoBoard({
      document: withLocalObject,
      scriptId: 'script-social',
      scriptRevision: 2,
      scenes: [
        {
          sourceId: 'beat-a',
          ordinal: 2,
          heading: 'Совсем другой первый кадр',
          synopsis: 'Новая завязка.',
          sourceText: 'Новая завязка.',
          sourceHash: 'c'.repeat(64),
        },
        {
          sourceId: 'beat-b',
          ordinal: 1,
          heading: 'Совсем другой второй кадр',
          synopsis: 'Новый финал.',
          sourceText: 'Новый финал.',
          sourceHash: 'd'.repeat(64),
        },
      ],
      fullSync: true,
      makeId: ids('unused'),
    });

    expect(merged).toMatchObject({ added: 0, updated: 2, removed: 0, skipped: 0 });
    expect(merged.document.nodes.find((node) => node.id === 'node-a')).toMatchObject({
      position: { x: 777, y: 333 },
      data: {
        sourceSceneId: 'beat-a',
        sourceOrdinal: 2,
        title: 'Совсем другой первый кадр',
        objects: [
          {
            kind: 'person',
            name: 'Алиса',
            description: 'В красном пальто.',
            castNodeId: 'cast-alice',
          },
        ],
      },
    });
  });

  it('updates source-owned fields while preserving user nodes and scene geometry', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    }).document;
    const withUserWork = {
      ...first,
      nodes: [
        ...first.nodes.map((node) =>
          node.id === 'node-1' ? { ...node, position: { x: 777, y: 333 } } : node,
        ),
        {
          id: 'user-note',
          type: 'note',
          version: 1,
          position: { x: 900, y: 400 },
          data: { text: 'Не перезаписывать' },
        },
      ],
    };
    const changed = FOUNTAIN.replace('Алиса находит письмо.', 'Алиса находит ключ.');
    const merged = mergeScenarioScenesIntoBoard({
      document: withUserWork,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: extractScenarioHandoffScenes(changed),
      fullSync: true,
      makeId: ids('unused'),
    });

    expect(merged).toMatchObject({ added: 0, updated: 2, removed: 0 });
    expect(merged.document.nodes.find((node) => node.id === 'node-1')).toMatchObject({
      position: { x: 777, y: 333 },
      data: {
        sourceSceneId: 'source-1',
        sourceScriptRevision: 2,
        synopsis: 'Алиса находит ключ.',
      },
    });
    expect(merged.document.nodes.find((node) => node.id === 'user-note')).toMatchObject({
      data: { text: 'Не перезаписывать' },
    });
    expect(merged.document.nodes.find((node) => node.id === 'node-1')?.data).not.toHaveProperty(
      'objects',
    );
  });

  it('reports capacity exhaustion for a scene-only handoff before schema parsing', () => {
    const document = {
      schemaVersion: 1,
      nodes: Array.from({ length: BOARD_LIMITS.nodes }, (_, index) => ({
        id: 'note-' + index,
        type: 'note',
        version: 1,
        position: { x: index, y: index },
        data: { text: 'filler' },
      })),
      edges: [],
      tray: [],
      __rev: 0,
    };

    expect(() =>
      mergeScenarioScenesIntoBoard({
        document,
        scriptId: 'script-full',
        scriptRevision: 1,
        scenes: extractScenarioHandoffScenes(FOUNTAIN),
        fullSync: false,
        makeId: ids('scene-source', 'scene-node'),
      }),
    ).toThrow(ScenarioBoardMaterializationLimitError);
  });

  it('preserves extracted objects when a reused scene source changes', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    }).document;
    const withObjects = {
      ...first,
      nodes: first.nodes.map((node) =>
        node.id === 'node-1'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [
                  {
                    kind: 'person' as const,
                    name: 'Алиса',
                    description: 'В красном пальто.',
                    castNodeId: 'cast-alice',
                  },
                ],
              },
            }
          : node,
      ),
    };
    const same = mergeScenarioScenesIntoBoard({
      document: withObjects,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('unused'),
    });
    expect(same.document.nodes.find((node) => node.id === 'node-1')?.data).toMatchObject({
      objects: [
        {
          kind: 'person',
          name: 'Алиса',
          description: 'В красном пальто.',
          castNodeId: 'cast-alice',
        },
      ],
    });

    const changedSource = FOUNTAIN.replace('Алиса находит письмо.', 'Алиса находит ключ.');
    const changed = mergeScenarioScenesIntoBoard({
      document: withObjects,
      scriptId: 'script-1',
      scriptRevision: 3,
      scenes: extractScenarioHandoffScenes(changedSource),
      fullSync: true,
      makeId: ids('unused'),
    });
    expect(changed.document.nodes.find((node) => node.id === 'node-1')?.data).toMatchObject({
      objects: [
        {
          kind: 'person',
          name: 'Алиса',
          description: 'В красном пальто.',
          castNodeId: 'cast-alice',
        },
      ],
    });
  });

  it('keeps the object extraction hash so a changed source can report stale objects', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    }).document;
    const extractedAt = first.nodes.find((node) => node.id === 'node-1')!;
    const withExtraction = {
      ...first,
      nodes: first.nodes.map((node) =>
        node.id === 'node-1'
          ? {
              ...node,
              data: {
                ...node.data,
                objectsSourceHash: (extractedAt.data as { sourceHash: string }).sourceHash,
                objects: [{ kind: 'person' as const, name: 'Алиса', castNodeId: 'cast-alice' }],
              },
            }
          : node,
      ),
    };

    const changedSource = FOUNTAIN.replace('Алиса находит письмо.', 'Алиса находит ключ.');
    const changed = mergeScenarioScenesIntoBoard({
      document: withExtraction,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: extractScenarioHandoffScenes(changedSource),
      fullSync: true,
      makeId: ids('unused'),
    });

    const data = changed.document.nodes.find((node) => node.id === 'node-1')!.data as {
      sourceHash: string;
      objectsSourceHash?: string;
    };
    // The banner exists only when both hashes survive and differ.
    expect(data.objectsSourceHash).toBe((extractedAt.data as { sourceHash: string }).sourceHash);
    expect(data.sourceHash).not.toBe(data.objectsSourceHash);
  });

  it('does not materialize an empty preserved object array', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    }).document;
    const withEmptyObjects = {
      ...first,
      nodes: first.nodes.map((node) =>
        node.id === 'node-1' ? { ...node, data: { ...node.data, objects: [] } } : node,
      ),
    };
    const merged = mergeScenarioScenesIntoBoard({
      document: withEmptyObjects,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('unused'),
    });

    expect(merged.document.nodes.find((node) => node.id === 'node-1')?.data).not.toHaveProperty(
      'objects',
    );
  });

  it('marks a removed source scene without deleting user work', () => {
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: extractScenarioHandoffScenes(FOUNTAIN),
      fullSync: true,
      makeId: ids('source-1', 'node-1', 'source-2', 'node-2'),
    }).document;
    const onlyFirst = extractScenarioHandoffScenes(FOUNTAIN).slice(0, 1);
    const merged = mergeScenarioScenesIntoBoard({
      document: first,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: onlyFirst,
      fullSync: true,
      makeId: ids('unused'),
    });

    expect(merged.removed).toBe(1);
    expect(merged.document.nodes.find((node) => node.id === 'node-2')?.data).toMatchObject({
      sourceSceneId: 'source-2',
      sourceStatus: 'removed',
    });
  });

  it('protects ambiguous Film candidates from update, duplication and full-sync removal', () => {
    const source = extractScenarioHandoffScenes(FOUNTAIN).slice(0, 1);
    const first = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-1',
      scriptRevision: 1,
      scenes: source,
      fullSync: true,
      makeId: ids('source-1', 'node-1'),
    }).document;
    const original = first.nodes[0]!;
    const duplicated = {
      ...first,
      nodes: [
        original,
        {
          ...original,
          id: 'node-duplicate',
          data: { ...original.data, sourceSceneId: 'another-local-source' },
        },
      ],
    };
    const changedSource = [
      'ИНТ. КУХНЯ — УТРО',
      '= Алиса находит ключ.',
      '',
      'Алиса открывает конверт.',
      '',
    ].join('\n');

    const merged = mergeScenarioScenesIntoBoard({
      document: duplicated,
      scriptId: 'script-1',
      scriptRevision: 2,
      scenes: extractScenarioHandoffScenes(changedSource),
      fullSync: true,
      makeId: ids('must-not-create'),
    });

    expect(merged).toMatchObject({ added: 0, updated: 0, removed: 0, skipped: 1 });
    expect(merged.document.nodes).toHaveLength(2);
    expect(merged.document.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'node-1',
          data: expect.objectContaining({ sourceStatus: 'current' }),
        }),
        expect.objectContaining({
          id: 'node-duplicate',
          data: expect.objectContaining({ sourceStatus: 'current' }),
        }),
      ]),
    );
  });
});
