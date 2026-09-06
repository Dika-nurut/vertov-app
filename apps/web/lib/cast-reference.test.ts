import { describe, expect, it } from 'vitest';
import { BOARD_LIMITS, parseBoardDocument } from '@seed/shared/board-contract';
import {
  appendCastReference,
  isCastReferenceSceneSeedable,
  planCastReference,
  type CastReferenceDocumentLike,
  type CastReferenceEdgeLike,
  type CastReferenceNodeLike,
} from './cast-reference';

const cast = (id = 'cast-1', extra: Record<string, unknown> = {}) => ({
  id,
  type: 'cast',
  position: { x: 0, y: 0 },
  data: { castKind: 'character', name: 'Анна', imageUrls: [], ...extra },
});

const documentFor = (
  nodes: readonly CastReferenceNodeLike[],
  edges: readonly Pick<CastReferenceEdgeLike, 'id' | 'source' | 'target'>[] = [],
  extra: Record<string, unknown> = {},
): CastReferenceDocumentLike => ({
  ...extra,
  schemaVersion: 1,
  nodes,
  edges: edges.map((edge, index) => ({ ...edge, id: edge.id ?? `document-edge-${index}` })),
  viewport: { x: 0, y: 0, zoom: 1 },
  tray: [],
});

const makeInput = (overrides: Record<string, unknown> = {}) => {
  const input = {
    cast: { id: 'cast-1', data: cast().data },
    promptId: 'prompt-1',
    shotId: 'shot-1',
    edgeId: 'edge-1',
    modelId: undefined,
    sceneContext: 'Кафе · вечер',
    existing: [cast()],
    edges: [],
    ...overrides,
  } as {
    cast: { id: string; data: Record<string, unknown> };
    promptId: string;
    shotId: string;
    edgeId: string;
    modelId: string | undefined;
    sceneContext: string;
    existing: readonly CastReferenceNodeLike[];
    edges: readonly CastReferenceEdgeLike[];
    currentDocument?: CastReferenceDocumentLike;
  };
  return {
    ...input,
    currentDocument: input.currentDocument ?? documentFor(input.existing, input.edges),
  };
};

describe('planCastReference', () => {
  it('refuses to seed from a removed scene source', () => {
    expect(isCastReferenceSceneSeedable({ sourceStatus: 'removed' })).toBe(false);
    expect(isCastReferenceSceneSeedable({ sourceStatus: 'ready' })).toBe(true);
  });

  it('plans an editable prompt and image shot with one prompt edge only', () => {
    const input = makeInput();
    const plan = planCastReference(input);
    expect(plan).not.toBeNull();
    expect(plan?.nodes).toHaveLength(2);
    expect(plan?.nodes.map((node) => node.type)).toEqual(['prompt', 'generate']);
    expect(plan?.nodes[0]?.data['text']).toContain('Контекст сцены: Кафе · вечер');
    expect(plan?.nodes[1]?.data).not.toHaveProperty('modelId');
    expect(plan?.nodes[1]?.data).toHaveProperty('originCastNodeId', 'cast-1');
    expect(plan?.edges).toEqual([
      expect.objectContaining({
        source: 'prompt-1',
        sourceHandle: 'text',
        target: 'shot-1',
        targetHandle: 'prompt',
      }),
    ]);
    expect(plan?.edges.some((edge) => edge.target === 'cast-1')).toBe(false);
    expect(
      parseBoardDocument({
        schemaVersion: 1,
        nodes: [...input.existing, ...(plan?.nodes ?? [])],
        edges: plan?.edges ?? [],
        tray: [],
      }),
    ).toBeTruthy();
  });

  it('persists a caller-resolved image model when one is available', () => {
    const plan = planCastReference(makeInput({ modelId: 'seedream-4-5' }));
    expect(plan?.nodes[1]?.data).toHaveProperty('modelId', 'seedream-4-5');
  });

  it('clamps spawned cards to the board coordinate schema', () => {
    const edgeCast = {
      ...cast(),
      position: { x: 10_000_000, y: -10_000_000 },
    };
    const plan = planCastReference(
      makeInput({ cast: { id: 'cast-1', data: edgeCast.data }, existing: [edgeCast] }),
    );
    expect(
      plan?.nodes.every((node) =>
        [node.position?.x, node.position?.y].every(
          (coordinate) => coordinate! >= -10_000_000 && coordinate! <= 10_000_000,
        ),
      ),
    ).toBe(true);
  });

  it('refuses full cards, idle references, colliding ids, and capacity limits', () => {
    expect(
      planCastReference(
        makeInput({
          cast: { id: 'cast-1', data: cast('cast-1', { imageUrls: ['1', '2', '3', '4'] }).data },
          existing: [cast('cast-1', { imageUrls: ['1', '2', '3', '4'] })],
        }),
      ),
    ).toBeNull();
    expect(
      planCastReference(
        makeInput({
          existing: [
            cast(),
            {
              id: 'old-shot',
              type: 'generate',
              data: { originCastNodeId: 'cast-1', status: 'idle' },
            },
          ],
        }),
      ),
    ).toBeNull();
    expect(planCastReference(makeInput({ promptId: 'cast-1' }))).toBeNull();
    expect(
      planCastReference(
        makeInput({
          existing: Array.from({ length: BOARD_LIMITS.nodes - 1 }, (_, i) => cast(`n-${i}`)),
        }),
      ),
    ).toBeNull();
    expect(
      planCastReference(
        makeInput({
          edges: Array.from({ length: BOARD_LIMITS.edges }, (_, i) => ({
            id: `e-${i}`,
            source: 'x',
            target: 'y',
          })),
        }),
      ),
    ).toBeNull();
    expect(
      planCastReference(
        makeInput({
          existing: [
            {
              ...cast(),
              data: { ...cast().data, huge: 'x'.repeat(BOARD_LIMITS.stateBytes) },
            },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe('appendCastReference', () => {
  const model = {
    id: 'edit',
    kind: 'image-edit' as const,
    capabilities: { maxRefs: 1 },
  };
  const shot = (resultUrl = 'take.png') => ({
    id: 'shot',
    type: 'generate',
    position: { x: 0, y: 0 },
    data: {
      mode: 'image',
      status: 'done',
      resultKind: 'image',
      resultUrl,
      originCastNodeId: 'cast-1',
    },
  });

  it('appends the selected result and refuses duplicate/full/video/originless shots', () => {
    const result = appendCastReference({
      nodes: [cast(), shot()],
      edges: [],
      shotId: 'shot',
      modelForNode: () => model,
      currentDocument: documentFor([cast(), shot()]),
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.nodes[0]?.data['imageUrls']).toEqual(['take.png']);
    expect(
      appendCastReference({
        nodes: [cast('cast-1', { imageUrls: ['take.png'] }), shot()],
        edges: [],
        shotId: 'shot',
        modelForNode: () => model,
        currentDocument: documentFor([cast('cast-1', { imageUrls: ['take.png'] }), shot()]),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('уже добавлен') });
    expect(
      appendCastReference({
        nodes: [cast('cast-1', { imageUrls: ['1', '2', '3', '4'] }), shot()],
        edges: [],
        shotId: 'shot',
        modelForNode: () => model,
        currentDocument: documentFor([cast('cast-1', { imageUrls: ['1', '2', '3', '4'] }), shot()]),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('четыре') });
    expect(
      appendCastReference({
        nodes: [
          cast(),
          { ...shot(), data: { ...shot().data, mode: 'video', resultKind: 'video' } },
        ],
        edges: [],
        shotId: 'shot',
        modelForNode: () => model,
        currentDocument: documentFor([
          cast(),
          { ...shot(), data: { ...shot().data, mode: 'video', resultKind: 'video' } },
        ]),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('картинку') });
    expect(
      appendCastReference({
        nodes: [cast(), { ...shot(), data: { ...shot().data, originCastNodeId: undefined } }],
        edges: [],
        shotId: 'shot',
        modelForNode: () => model,
        currentDocument: documentFor([cast(), shot()]),
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('источника') });
  });

  it('checks every consuming shot against the grown pack before committing', () => {
    const consumer = {
      id: 'consumer',
      type: 'generate',
      position: { x: 0, y: 0 },
      data: { mode: 'image', status: 'idle', prompt: 'consumer' },
    };
    const result = appendCastReference({
      nodes: [cast('cast-1', { imageUrls: ['existing.png'] }), shot(), consumer],
      edges: [
        {
          id: 'cast-edge',
          source: 'cast-1',
          target: 'consumer',
          sourceHandle: 'out',
          targetHandle: 'images[0]',
        },
      ],
      shotId: 'shot',
      modelForNode: () => model,
      currentDocument: documentFor(
        [cast('cast-1', { imageUrls: ['existing.png'] }), shot(), consumer],
        [{ id: 'cast-edge', source: 'cast-1', target: 'consumer' }],
      ),
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('consumer') });
  });

  it('accepts two functional callbacks derived from the same starting state', () => {
    const startingNodes = [cast(), shot()];
    const startingEdges: { id: string; source: string; target: string }[] = [];
    const callback = () =>
      appendCastReference({
        nodes: startingNodes,
        edges: startingEdges,
        shotId: 'shot',
        modelForNode: () => model,
        currentDocument: documentFor(startingNodes, startingEdges),
      });

    const first = callback();
    const second = callback();
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    // The caller must merge each callback's result with the current React state;
    // feeding the first result into the second would hide a stale-snapshot bug.
  });

  it('appends the currently selected take and leaves a rerunnable shot intact', () => {
    const currentShot = shot('take-2.png');
    const result = appendCastReference({
      nodes: [cast(), currentShot],
      edges: [],
      shotId: 'shot',
      modelForNode: () => model,
      currentDocument: documentFor([cast(), currentShot]),
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.nodes.find((node) => node.id === 'cast-1')?.data['imageUrls']).toEqual([
        'take-2.png',
      ]);
      expect(result.nodes.find((node) => node.id === 'shot')?.data['status']).toBe('done');
    }
  });
});
