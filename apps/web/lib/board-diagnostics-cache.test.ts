import { describe, expect, it } from 'vitest';
import { diagnoseBoardGraph, type BoardGraphNodeLike } from '@seed/shared/board-diagnostics';
import type { BoardModelLike } from '@seed/shared/board-contract';
import { BoardGraphDiagnosticsCache } from './board-diagnostics-cache';

const model: BoardModelLike = {
  id: 'image-model',
  kind: 'image',
  capabilities: { multi_image: true, reference: true },
};
const media = (id: string): BoardGraphNodeLike => ({
  id,
  type: 'media',
  data: { url: `https://example.test/${id}.png`, mediaKind: 'image' },
});
const shot = (id: string): BoardGraphNodeLike => ({
  id,
  type: 'generate',
  data: {
    mode: 'image',
    modelId: model.id,
    prompt: 'shot',
    imageAspect: '1:1',
    imageQuality: '1K',
    count: 1,
    status: 'idle',
  },
});
const modelForNode = () => model;

describe('BoardGraphDiagnosticsCache', () => {
  it('matches the canonical full-graph diagnostic across add/remove/source changes', () => {
    const cache = new BoardGraphDiagnosticsCache();
    const a = media('a');
    const b = media('b');
    const g1 = shot('g1');
    const g2 = shot('g2');
    const states = [
      { nodes: [a, b, g1, g2], edges: [] },
      {
        nodes: [a, b, g1, g2],
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'g1',
            sourceHandle: 'out',
            targetHandle: 'images[0]',
          },
        ],
      },
      {
        nodes: [a, b, g1, g2],
        edges: [
          {
            id: 'e1',
            source: 'a',
            target: 'g1',
            sourceHandle: 'out',
            targetHandle: 'images[0]',
          },
          {
            id: 'e2',
            source: 'b',
            target: 'g2',
            sourceHandle: 'out',
            targetHandle: 'images[0]',
          },
        ],
      },
      {
        nodes: [a, g1, g2],
        edges: [
          {
            id: 'e2',
            source: 'b',
            target: 'g2',
            sourceHandle: 'out',
            targetHandle: 'images[0]',
          },
        ],
      },
    ];

    for (const state of states) {
      expect(cache.update({ ...state, modelForNode, requireReady: true })).toEqual(
        diagnoseBoardGraph({ ...state, modelForNode, requireReady: true }),
      );
    }
  });

  it('does not retain cycle errors after the cycle is removed', () => {
    const cache = new BoardGraphDiagnosticsCache();
    const g1 = shot('g1');
    const g2 = shot('g2');
    const cycle = [
      {
        id: 'e1',
        source: 'g1',
        target: 'g2',
        sourceHandle: 'out',
        targetHandle: 'images[0]',
      },
      {
        id: 'e2',
        source: 'g2',
        target: 'g1',
        sourceHandle: 'out',
        targetHandle: 'images[0]',
      },
    ];
    expect(
      cache.update({ nodes: [g1, g2], edges: cycle, modelForNode, requireReady: true }).executable,
    ).toBe(false);
    const acyclic = cache.update({
      nodes: [g1, g2],
      edges: cycle.slice(0, 1),
      modelForNode,
      requireReady: true,
    });
    expect(acyclic).toEqual(
      diagnoseBoardGraph({
        nodes: [g1, g2],
        edges: cycle.slice(0, 1),
        modelForNode,
        requireReady: true,
      }),
    );
  });
});
