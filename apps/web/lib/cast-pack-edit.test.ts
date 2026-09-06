import { describe, expect, it } from 'vitest';
import { planCastStillAdd, planCastStillRemove } from './cast-pack-edit';

const IMAGE_MODEL = {
  id: 'seedream-4-5',
  kind: 'image' as const,
  capabilities: { maxRefs: 14 },
};

function board(castImages: string[], edges: { id: string; source: string; target: string }[] = []) {
  return {
    nodes: [
      {
        id: 'cast-1',
        type: 'cast',
        data: { castKind: 'character', name: 'Анна', imageUrls: castImages },
      },
      {
        id: 'shot-1',
        type: 'generate',
        data: { mode: 'image', modelId: 'seedream-4-5', status: 'idle' },
      },
    ],
    edges: edges.map((edge) => ({ ...edge, sourceHandle: 'out', targetHandle: 'images[0]' })),
  };
}

describe('cast reference pack edits', () => {
  it('detaches every consuming shot when the last still is removed', () => {
    const { nodes, edges } = board(
      ['a.png'],
      [{ id: 'edge-1', source: 'cast-1', target: 'shot-1' }],
    );

    const plan = planCastStillRemove({ nodes, edges, castId: 'cast-1', index: 0 });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.detachedShotIds).toEqual(['shot-1']);
    expect(plan.edges).toHaveLength(0);
    expect(plan.nodes.find((node) => node.id === 'cast-1')?.data['imageUrls']).toEqual([]);
  });

  it('cuts every wire out of the emptied card, not only the ones landing on a shot', () => {
    const { nodes, edges } = board(
      ['a.png'],
      [{ id: 'edge-1', source: 'cast-1', target: 'shot-1' }],
    );
    const withExtra = {
      nodes: [...nodes, { id: 'note-1', type: 'note', data: { text: '' } }],
      edges: [
        ...edges,
        {
          id: 'edge-2',
          source: 'cast-1',
          target: 'note-1',
          sourceHandle: 'out',
          targetHandle: 'in',
        },
      ],
    };

    const plan = planCastStillRemove({ ...withExtra, castId: 'cast-1', index: 0 });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edges).toHaveLength(0);
    // Only the shot is worth naming in the confirmation.
    expect(plan.detachedShotIds).toEqual(['shot-1']);
  });

  it('keeps the shot connected while any still survives', () => {
    const { nodes, edges } = board(
      ['a.png', 'b.png'],
      [{ id: 'edge-1', source: 'cast-1', target: 'shot-1' }],
    );

    const plan = planCastStillRemove({ nodes, edges, castId: 'cast-1', index: 0 });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.detachedShotIds).toEqual([]);
    expect(plan.edges).toHaveLength(1);
    expect(plan.nodes.find((node) => node.id === 'cast-1')?.data['imageUrls']).toEqual(['b.png']);
  });

  it('refuses a fifth still rather than silently dropping it', () => {
    const { nodes, edges } = board(['a.png', 'b.png', 'c.png', 'd.png']);

    const plan = planCastStillAdd({
      nodes,
      edges,
      castId: 'cast-1',
      url: 'e.png',
      modelForNode: () => IMAGE_MODEL,
    });

    expect(plan).toEqual({ ok: false, reason: 'В объекте уже четыре референса.' });
  });

  it('adds a still when every consuming shot still fits', () => {
    const { nodes, edges } = board(
      ['a.png'],
      [{ id: 'edge-1', source: 'cast-1', target: 'shot-1' }],
    );

    const plan = planCastStillAdd({
      nodes,
      edges,
      castId: 'cast-1',
      url: 'b.png',
      modelForNode: () => IMAGE_MODEL,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.nodes.find((node) => node.id === 'cast-1')?.data['imageUrls']).toEqual([
      'a.png',
      'b.png',
    ]);
  });
});
