import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import {
  clearBoardSelection,
  copyBoardSelection,
  duplicateBoardSelection,
  isBoardTypingTarget,
  pasteBoardClipboard,
  patchBoardNode,
  removeBoardNode,
  removeBoardFrame,
  removeBoardSelection,
  selectedBoardNodeIds,
  selectAllBoardNodes,
  wrapBoardSelectionInFrame,
} from './board-graph-commands';

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  data: { text: id },
  ...extra,
});
const edge: Edge = { id: 'edge', source: 'a', target: 'b' };

describe('Board graph commands', () => {
  it('recognizes text inputs as keyboard shortcut exclusions', () => {
    expect(isBoardTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isBoardTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isBoardTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isBoardTypingTarget({ tagName: 'BUTTON' })).toBe(false);
  });

  it('changes selection without mutating node content', () => {
    const nodes = [node('a', { selected: true }), node('b')];
    expect(clearBoardSelection(nodes).every((entry) => !entry.selected)).toBe(true);
    expect(selectAllBoardNodes(nodes).every((entry) => entry.selected)).toBe(true);
    expect(patchBoardNode(nodes, 'b', { text: 'changed' })[1]?.data).toEqual({ text: 'changed' });
  });

  it('removes the node, incident edges, and tray reference together', () => {
    expect(
      removeBoardNode({ nodes: [node('a'), node('b')], edges: [edge], tray: ['a'], nodeId: 'a' }),
    ).toEqual({ nodes: [node('b')], edges: [], tray: [] });
  });

  it('unlinks surviving scene chips when deleting one cast card', () => {
    const result = removeBoardNode({
      nodes: [
        node('cast', { type: 'cast', data: { name: 'Анна' } }),
        node('scene', {
          type: 'scene',
          data: {
            objects: [
              { kind: 'person', name: 'Анна', castNodeId: 'cast' },
              { kind: 'place', name: 'Кухня', castNodeId: 'other-cast' },
            ],
          },
        }),
      ],
      edges: [],
      tray: [],
      nodeId: 'cast',
    });

    expect(result.nodes).toEqual([
      node('scene', {
        type: 'scene',
        data: {
          objects: [
            { kind: 'person', name: 'Анна' },
            { kind: 'place', name: 'Кухня', castNodeId: 'other-cast' },
          ],
        },
      }),
    ]);
  });

  it('unlinks surviving prompt provenance when deleting one scene card', () => {
    const result = removeBoardNode({
      nodes: [
        node('scene', { type: 'scene' }),
        node('prompt', { type: 'prompt', data: { text: 'кадр', sourceSceneNodeId: 'scene' } }),
        node('ai', { type: 'aiprompt', data: { brief: 'кадр', sourceSceneNodeId: 'scene' } }),
        node('shot', {
          type: 'generate',
          data: { mode: 'image', sourceSceneNodeId: 'scene' },
        }),
        node('other', { type: 'prompt', data: { sourceSceneNodeId: 'another-scene' } }),
      ],
      edges: [],
      tray: [],
      nodeId: 'scene',
    });

    expect(result.nodes.map((entry) => entry.data)).toEqual([
      { text: 'кадр' },
      { brief: 'кадр' },
      { mode: 'image' },
      { sourceSceneNodeId: 'another-scene' },
    ]);
  });

  it('removes every selected card with its incident edges and tray references', () => {
    expect(
      removeBoardSelection({
        nodes: [node('a', { selected: true }), node('b'), node('c', { selected: true })],
        edges: [edge, { id: 'outside', source: 'b', target: 'c' }],
        tray: ['a', 'b', 'c'],
      }),
    ).toEqual({ nodes: [node('b')], edges: [], tray: ['b'], removed: true });
  });

  it('wraps selected nodes with a React Flow parent frame and remaps their positions', () => {
    const result = wrapBoardSelectionInFrame({
      nodes: [
        node('shot', { selected: true, position: { x: 100, y: 120 }, width: 240, height: 180 }),
        node('outside', { position: { x: 800, y: 800 } }),
      ],
      frameId: 'frame',
    });
    expect(result[0]).toMatchObject({ id: 'frame', type: 'frame', zIndex: -1 });
    expect(result[1]).toMatchObject({
      id: 'shot',
      parentId: 'frame',
      extent: 'parent',
      position: { x: 28, y: 28 },
    });
    expect(result[2]?.parentId).toBeUndefined();
  });

  it('wraps an existing child using absolute coordinates instead of its parent-relative position', () => {
    const result = wrapBoardSelectionInFrame({
      nodes: [
        node('old-frame', { type: 'frame', position: { x: 100, y: 200 } }),
        node('child', {
          type: 'text',
          selected: true,
          parentId: 'old-frame',
          extent: 'parent',
          position: { x: 40, y: 50 },
        }),
      ],
      frameId: 'new-frame',
      framePosition: { x: 0, y: 0 },
    });
    expect(result.find((entry) => entry.id === 'child')).toMatchObject({
      parentId: 'new-frame',
      position: { x: 140, y: 250 },
    });
  });

  it('caps a wrapped frame at the contract dimension maximum', () => {
    const result = wrapBoardSelectionInFrame({
      nodes: [
        node('wide', { selected: true, position: { x: 0, y: 0 }, width: 8_000, height: 8_000 }),
      ],
      frameId: 'frame',
    });
    expect(result[0]).toMatchObject({ id: 'frame', width: 4_000, height: 4_000 });
  });

  it('detaches frame children into absolute canvas coordinates or removes them together', () => {
    const frame = node('frame', {
      type: 'frame',
      position: { x: 100, y: 200 },
      width: 520,
      height: 320,
    });
    const child = node('child', {
      parentId: 'frame',
      extent: 'parent',
      position: { x: 20, y: 30 },
    });
    const detached = removeBoardFrame({
      nodes: [frame, child],
      edges: [],
      tray: [],
      frameId: 'frame',
      includeChildren: false,
    });
    expect(detached.nodes).toEqual([node('child', { position: { x: 120, y: 230 } })]);
    const removed = removeBoardFrame({
      nodes: [frame, child],
      edges: [],
      tray: [],
      frameId: 'frame',
      includeChildren: true,
    });
    expect(removed.nodes).toEqual([]);
  });

  it('keeps parent/child relationships when copying a selected frame', () => {
    const result = duplicateBoardSelection({
      nodes: [
        node('child', { type: 'text', selected: true, parentId: 'frame', extent: 'parent' }),
        node('frame', { type: 'frame', selected: true }),
      ],
      edges: [],
      makeId: (() => {
        let i = 0;
        return () => `copy-${++i}`;
      })(),
    });
    expect(result.nodes.slice(2).find((entry) => entry.type === 'text')).toMatchObject({
      parentId: 'copy-2',
    });
  });

  it('keeps copied child coordinates relative to a copied frame', () => {
    const result = duplicateBoardSelection({
      nodes: [
        node('frame', { type: 'frame', selected: true, position: { x: 100, y: 200 } }),
        node('child', {
          type: 'text',
          selected: true,
          parentId: 'frame',
          extent: 'parent',
          position: { x: 40, y: 50 },
        }),
      ],
      edges: [],
      makeId: (() => {
        let i = 0;
        return () => `copy-${++i}`;
      })(),
      offset: 36,
    });
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'copy-1', type: 'frame', position: { x: 136, y: 236 } }),
        expect.objectContaining({
          id: 'copy-2',
          parentId: 'copy-1',
          position: { x: 40, y: 50 },
        }),
      ]),
    );
  });

  it('unlinks every relation to selected cast and scene cards in the same selection deletion', () => {
    const result = removeBoardSelection({
      nodes: [
        node('cast-a', { type: 'cast', selected: true }),
        node('cast-b', { type: 'cast', selected: true }),
        node('scene-a', { type: 'scene', selected: true }),
        node('scene-b', {
          type: 'scene',
          data: {
            objects: [
              { kind: 'person', name: 'А', castNodeId: 'cast-a' },
              { kind: 'person', name: 'Б', castNodeId: 'cast-b' },
              { kind: 'place', name: 'В', castNodeId: 'cast-c' },
            ],
          },
        }),
        node('prompt', { type: 'prompt', data: { sourceSceneNodeId: 'scene-a' } }),
      ],
      edges: [],
      tray: [],
    });

    expect(result).toMatchObject({
      removed: true,
      nodes: [
        {
          id: 'scene-b',
          data: {
            objects: [
              { kind: 'person', name: 'А' },
              { kind: 'person', name: 'Б' },
              { kind: 'place', name: 'В', castNodeId: 'cast-c' },
            ],
          },
        },
        { id: 'prompt', data: {} },
      ],
    });
  });

  it('copies and removes the same current selection when controlled nodes are stale', () => {
    const nodes = [node('a'), node('b')];
    const selectedIds = new Set(['a', 'b']);

    expect(
      copyBoardSelection({ nodes, edges: [edge], selectedIds })?.nodes.map((entry) => entry.id),
    ).toEqual(['a', 'b']);
    expect(removeBoardSelection({ nodes, edges: [edge], tray: ['a', 'b'], selectedIds })).toEqual({
      nodes: [],
      edges: [],
      tray: [],
      removed: true,
    });
  });

  it('uses the controlled selection when React Flow lookup still has one card', () => {
    const controlledNodes = [node('a', { selected: true }), node('b', { selected: true })];
    const laggingNodeLookup = [node('a', { selected: true }), node('b')];
    const selectedIds = selectedBoardNodeIds(controlledNodes);

    expect(selectedBoardNodeIds(laggingNodeLookup)).toEqual(new Set(['a']));
    expect(selectedIds).toEqual(new Set(['a', 'b']));
    expect(
      copyBoardSelection({ nodes: controlledNodes, edges: [edge], selectedIds })?.nodes.map(
        (entry) => entry.id,
      ),
    ).toEqual(['a', 'b']);
    expect(
      removeBoardSelection({
        nodes: controlledNodes,
        edges: [edge],
        tray: ['a', 'b'],
        selectedIds,
      }),
    ).toMatchObject({ nodes: [], edges: [], tray: [], removed: true });
  });

  it('uses a replacement selection instead of stale node flags', () => {
    const nodes = [node('a', { selected: true }), node('b')];
    const selectedIds = new Set(['b']);

    expect(
      copyBoardSelection({ nodes, edges: [edge], selectedIds })?.nodes.map((entry) => entry.id),
    ).toEqual(['b']);
    expect(removeBoardSelection({ nodes, edges: [edge], tray: ['a', 'b'], selectedIds })).toEqual({
      nodes: [node('a', { selected: false })],
      edges: [],
      tray: ['a'],
      removed: true,
    });
  });

  it('duplicates selected subgraphs and resets generated results', () => {
    let next = 0;
    const result = duplicateBoardSelection({
      nodes: [
        node('a', { selected: true }),
        node('b', {
          type: 'generate',
          selected: true,
          data: { status: 'done', resultUrl: 'result.png', resultKind: 'image' },
        }),
      ],
      edges: [edge],
      makeId: () => `new-${++next}`,
    });
    expect(result.duplicated).toBe(true);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes[3]?.data).toMatchObject({ status: 'idle' });
    expect(result.nodes[3]?.data['resultUrl']).toBeUndefined();
    expect(result.edges[1]).toMatchObject({ source: 'new-1', target: 'new-2' });
  });

  it('copies nothing when the selection is empty', () => {
    expect(copyBoardSelection({ nodes: [node('a'), node('b')], edges: [edge] })).toBeNull();
  });

  it('copies a multi-card subgraph and pastes it with fresh ids at an offset', () => {
    const clipboard = copyBoardSelection({
      nodes: [
        node('a', { selected: true, position: { x: 100, y: 100 } }),
        node('b', { selected: true, position: { x: 180, y: 140 } }),
        node('c', { position: { x: 900, y: 900 } }),
      ],
      edges: [edge, { id: 'outside', source: 'b', target: 'c' }],
    });
    expect(clipboard?.nodes.map((entry) => entry.id)).toEqual(['a', 'b']);
    // the edge leaving the selection is not carried along
    expect(clipboard?.edges.map((entry) => entry.id)).toEqual(['edge']);

    let next = 0;
    const result = pasteBoardClipboard({
      nodes: [node('c', { position: { x: 900, y: 900 } })],
      edges: [],
      clipboard,
      makeId: () => `new-${++next}`,
      anchor: { x: 0, y: 0 },
    });
    expect(result.pasted).toBe(true);
    expect(result.nodes.map((entry) => entry.position)).toEqual([
      { x: 900, y: 900 },
      { x: 0, y: 0 },
      { x: 80, y: 40 },
    ]);
    expect(result.nodes.slice(1).every((entry) => entry.selected)).toBe(true);
    expect(result.nodes.slice(1).map((entry) => entry.id)).toEqual(['new-1', 'new-2']);
    expect(result.edges).toEqual([
      { id: 'new-3', source: 'new-1', target: 'new-2', selected: false },
    ]);
  });

  it('pasting a shot card gives a fresh, untaken shot', () => {
    const clipboard = copyBoardSelection({
      nodes: [
        node('g', {
          type: 'generate',
          selected: true,
          data: {
            prompt: 'кадр',
            status: 'done',
            resultUrl: 'a.png',
            resultKind: 'image',
            takes: ['a.png', 'b.png'],
          },
        }),
      ],
      edges: [],
    });
    const result = pasteBoardClipboard({
      nodes: [],
      edges: [],
      clipboard,
      makeId: () => 'new-1',
      anchor: { x: 10, y: 10 },
    });
    expect(result.nodes[0]?.data).toMatchObject({ prompt: 'кадр', status: 'idle' });
    expect(result.nodes[0]?.data['resultUrl']).toBeUndefined();
    expect(result.nodes[0]?.data['takes']).toBeUndefined();
  });

  it('clears cast provenance when duplicating or pasting a reference shot', () => {
    const source = node('g', {
      type: 'generate',
      selected: true,
      data: { status: 'idle', originCastNodeId: 'cast-1' },
    });
    const duplicated = duplicateBoardSelection({
      nodes: [source],
      edges: [],
      makeId: () => 'copy',
    });
    expect(duplicated.nodes[1]?.data).not.toHaveProperty('originCastNodeId');
    const clipboard = copyBoardSelection({ nodes: [source], edges: [] });
    const pasted = pasteBoardClipboard({
      nodes: [],
      edges: [],
      clipboard,
      makeId: () => 'paste',
      anchor: { x: 0, y: 0 },
    });
    expect(pasted.nodes[0]?.data).not.toHaveProperty('originCastNodeId');
  });

  it('turns copied workflow cards into local, unlinked cards', () => {
    const source = [
      node('scene', {
        type: 'scene',
        selected: true,
        data: {
          title: 'Сцена',
          sourceScriptId: 'script',
          sourceScriptRevision: 3,
          sourceSceneId: 'source-scene',
          sourceSceneRevision: 3,
          sourceHash: 'hash',
          sourceOrdinal: 4,
          sourceStatus: 'changed',
          objectsSourceHash: 'objects-hash',
          objects: [{ kind: 'person', name: 'Анна', description: 'пальто', castNodeId: 'cast-a' }],
        },
      }),
      node('prompt', {
        type: 'prompt',
        selected: true,
        data: { text: 'кадр', sourceSceneNodeId: 'scene' },
      }),
      node('ai', {
        type: 'aiprompt',
        selected: true,
        data: { brief: 'кадр', sourceSceneNodeId: 'scene', idempotencyKey: 'claim-key' },
      }),
      node('shot', {
        type: 'generate',
        selected: true,
        data: {
          mode: 'image',
          modelId: 'seedream',
          sourceSceneNodeId: 'scene',
          originCastNodeId: 'cast-a',
          status: 'done',
          jobId: 'job',
          jobIds: ['job'],
          resultUrl: 'result.png',
          resultKind: 'image',
          assetId: 'asset',
          lastFrameUrl: 'last.png',
          takes: ['result.png'],
          drifted: true,
          failureMessage: 'old',
          failureAction: 'retry',
        },
      }),
    ];
    const assertSanitized = (entries: readonly Node[]) => {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const scene = [...byId.values()].find((entry) => entry.type === 'scene')!;
      const prompt = [...byId.values()].find((entry) => entry.type === 'prompt')!;
      const ai = [...byId.values()].find((entry) => entry.type === 'aiprompt')!;
      const shot = [...byId.values()].find((entry) => entry.type === 'generate')!;
      for (const key of [
        'sourceScriptId',
        'sourceScriptRevision',
        'sourceSceneId',
        'sourceSceneRevision',
        'sourceHash',
        'sourceOrdinal',
        'sourceStatus',
        'objectsSourceHash',
      ]) {
        expect(scene.data).not.toHaveProperty(key);
      }
      expect(scene.data).toMatchObject({
        title: 'Сцена',
        objects: [{ kind: 'person', name: 'Анна', description: 'пальто' }],
      });
      expect((scene.data['objects'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
        'castNodeId',
      );
      expect(prompt.data).not.toHaveProperty('sourceSceneNodeId');
      expect(ai.data).not.toHaveProperty('sourceSceneNodeId');
      expect(ai.data).not.toHaveProperty('idempotencyKey');
      expect(shot.data).toMatchObject({ mode: 'image', modelId: 'seedream', status: 'idle' });
      for (const key of [
        'sourceSceneNodeId',
        'originCastNodeId',
        'jobId',
        'jobIds',
        'resultUrl',
        'resultKind',
        'assetId',
        'lastFrameUrl',
        'takes',
        'drifted',
        'failureMessage',
        'failureAction',
      ]) {
        expect(shot.data).not.toHaveProperty(key);
      }
    };

    let next = 0;
    const duplicated = duplicateBoardSelection({
      nodes: source,
      edges: [],
      makeId: () => `copy-${++next}`,
    });
    assertSanitized(duplicated.nodes.slice(source.length));

    const pasted = pasteBoardClipboard({
      nodes: [],
      edges: [],
      clipboard: copyBoardSelection({ nodes: source, edges: [] }),
      makeId: () => `paste-${++next}`,
      anchor: { x: 0, y: 0 },
    });
    assertSanitized(pasted.nodes);
  });

  it('pastes nothing when the clipboard is empty', () => {
    const result = pasteBoardClipboard({
      nodes: [node('a')],
      edges: [],
      clipboard: null,
      makeId: () => 'new-1',
      anchor: { x: 0, y: 0 },
    });
    expect(result.pasted).toBe(false);
    expect(result.nodes).toHaveLength(1);
  });
});
