import { describe, expect, it } from 'vitest';
import { BOARD_LIMITS } from '@seed/shared/board-contract';
import { SCENARIO_SHOT_PLAN_VERSION } from '@seed/shared/scenario-shot-plan';
import {
  boardLinksToScript,
  extractScenarioHandoffSources,
  extractScenarioHandoffScenes,
  mergeScenarioScenesIntoBoard,
  scenarioHandoffLocks,
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
  it('builds one bounded lock catalog for characters and locations', () => {
    expect(
      scenarioHandoffLocks({
        characters: [{ name: ' Алиса ', description: ' В красном пальто. ' }],
        locations: [{ name: ' Кухня ', description: ' Тесная и тёплая. ' }],
      }),
    ).toEqual([
      {
        id: 'canon:character:1',
        kind: 'character',
        name: 'Алиса',
        description: 'В красном пальто.',
      },
      {
        id: 'canon:location:1',
        kind: 'location',
        name: 'Кухня',
        description: 'Тесная и тёплая.',
      },
    ]);
  });

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

  it.each([1, 2])(
    'stacks planned scenes so no node overlaps another (%i shots + a cast node per scene)',
    (shotsPerScene) => {
      const scenes = extractScenarioHandoffScenes(FOUNTAIN).map((scene) => {
        const shot = (order: number) => ({
          order,
          title: `Кадр ${order}`,
          durationSec: 4,
          dramaticBeat: 'Бит.',
          promptDraft: `Кадр ${order} сцены ${scene.ordinal}`,
          requiredLocks: [`canon:character:${scene.ordinal}`],
          unresolvedAssets: [],
        });
        return {
          ...scene,
          shotPlan: {
            version: SCENARIO_SHOT_PLAN_VERSION,
            sceneId: `scene:${scene.ordinal}`,
            targetDurationSeconds: 8,
            shots: Array.from({ length: shotsPerScene }, (_, index) => shot(index + 1)),
          },
          locks: [
            {
              id: `canon:character:${scene.ordinal}`,
              kind: 'character' as const,
              name: `Герой ${scene.ordinal}`,
            },
          ],
        };
      });
      const merged = mergeScenarioScenesIntoBoard({
        document: {},
        scriptId: 'script-stacked',
        scriptRevision: 1,
        scenes,
        fullSync: true,
        makeId: ids(),
      });

      const boxes = merged.document.nodes.map((node) => ({
        id: node.id,
        left: node.position.x,
        right: node.position.x + (node.width ?? 0),
        top: node.position.y,
        bottom: node.position.y + (node.height ?? 0),
      }));
      expect(merged.document.nodes.filter((node) => node.type === 'generate')).toHaveLength(
        2 * shotsPerScene,
      );
      expect(merged.document.nodes.filter((node) => node.type === 'cast')).toHaveLength(2);
      const overlaps = boxes.flatMap((a, index) =>
        boxes
          .slice(index + 1)
          .filter(
            (b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom,
          )
          .map((b) => `${a.id} × ${b.id}`),
      );
      expect(overlaps).toEqual([]);
    },
  );

  it('places a scene added on re-sync below the cast nodes an earlier sync created', () => {
    const [first, second] = extractScenarioHandoffScenes(FOUNTAIN);
    const locks = [1, 2, 3].map((index) => ({
      id: `canon:character:${index}`,
      kind: 'character' as const,
      name: `Герой ${index}`,
    }));
    const planned = (scene: typeof first) => ({
      ...scene!,
      shotPlan: {
        version: SCENARIO_SHOT_PLAN_VERSION,
        sceneId: `scene:${scene!.ordinal}`,
        targetDurationSeconds: 4,
        shots: [
          {
            order: 1,
            title: 'Кадр',
            durationSec: 4,
            dramaticBeat: 'Бит.',
            promptDraft: 'Кадр сцены',
            requiredLocks: locks.map((lock) => lock.id),
            unresolvedAssets: [],
          },
        ],
      },
      locks,
    });
    const prefixed = (prefix: string) => {
      let next = 0;
      return () => `${prefix}-${++next}`;
    };
    const firstSync = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-resync',
      scriptRevision: 1,
      scenes: [planned(first)],
      fullSync: false,
      makeId: prefixed('first'),
    });
    expect(firstSync.document.nodes.filter((node) => node.type === 'cast')).toHaveLength(3);

    const resync = mergeScenarioScenesIntoBoard({
      document: firstSync.document,
      scriptId: 'script-resync',
      scriptRevision: 2,
      scenes: [planned(first), second!],
      fullSync: false,
      makeId: prefixed('resync'),
    });

    const boxes = resync.document.nodes.map((node) => ({
      id: node.id,
      left: node.position.x,
      right: node.position.x + (node.width ?? 0),
      top: node.position.y,
      bottom: node.position.y + (node.height ?? 0),
    }));
    const overlaps = boxes.flatMap((a, index) =>
      boxes
        .slice(index + 1)
        .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
        .map((b) => `${a.id} × ${b.id}`),
    );
    expect(resync.document.nodes.filter((node) => node.type === 'scene')).toHaveLength(2);
    expect(overlaps).toEqual([]);
  });

  it('materializes named planned shots and approved locks as ordinary nodes', () => {
    const [scene] = extractScenarioHandoffScenes(FOUNTAIN);
    const merged = mergeScenarioScenesIntoBoard({
      document: {},
      scriptId: 'script-planned',
      scriptRevision: 4,
      scenes: [
        {
          ...scene!,
          shotPlan: {
            version: SCENARIO_SHOT_PLAN_VERSION,
            sceneId: 'scene:1',
            targetDurationSeconds: 8,
            shots: [
              {
                order: 1,
                title: 'Письмо на столе',
                durationSec: 8,
                dramaticBeat: 'Находка меняет ход сцены.',
                promptDraft: 'Письмо на деревянном столе, утренний свет.',
                requiredLocks: ['canon:character:1', 'canon:location:1'],
                unresolvedAssets: [],
              },
            ],
          },
          locks: [
            {
              id: 'canon:character:1',
              kind: 'character',
              name: 'Алиса',
              description: 'В красном пальто.',
            },
            {
              id: 'canon:location:1',
              kind: 'location',
              name: 'Кухня',
              description: 'Тесная кухня с утренним светом.',
            },
          ],
        },
      ],
      fullSync: true,
      makeId: ids('scene-source', 'scene-node'),
    });

    const prompt = merged.document.nodes.find((node) => node.type === 'prompt');
    const generate = merged.document.nodes.find((node) => node.type === 'generate');
    const cast = merged.document.nodes.find(
      (node) => node.type === 'cast' && (node.data as { name?: string }).name === 'Алиса',
    );
    expect(prompt?.data).toMatchObject({ title: 'Письмо на столе' });
    expect(generate?.data).toMatchObject({
      title: 'Письмо на столе',
      durationSeconds: 8,
      requiredLocks: ['canon:character:1', 'canon:location:1'],
    });
    expect(cast?.data).toMatchObject({
      castKind: 'character',
      name: 'Алиса',
      scenarioLockId: 'canon:character:1',
    });
    expect(
      merged.document.nodes.some(
        (node) =>
          node.type === 'cast' && node.data.name === 'Кухня' && node.data.castKind === 'location',
      ),
    ).toBe(true);
    expect(
      merged.document.edges.some(
        (edge) =>
          edge.source === cast?.id &&
          edge.target === generate?.id &&
          edge.targetHandle === 'images[0]',
      ),
    ).toBe(true);
    expect(
      merged.document.edges.some(
        (edge) => edge.target === generate?.id && edge.targetHandle === 'images[1]',
      ),
    ).toBe(true);
  });

  it('sends the sheet, not the beats, once a short-form script has scene headings', () => {
    const sources = extractScenarioHandoffSources({
      format: 'ad',
      fountain: FOUNTAIN,
      outline: {
        version: 1,
        beats: [{ id: 'hook-1', kind: 'hook', title: 'Старый бит', summary: 'Не должен уйти.' }],
      },
    });

    expect(sources.map((scene) => scene.heading)).toEqual([
      'ИНТ. КУХНЯ — УТРО',
      'НАТ. ДВОР — ДЕНЬ',
    ]);
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
