import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { BoardDocumentGraphCache } from './board-document-graph';

const NODE_DATA = { text: 'hello' };
const node = (extra: Partial<Node> = {}): Node => ({
  id: 'node',
  type: 'note',
  position: { x: 1, y: 2 },
  data: NODE_DATA,
  ...extra,
});
const edge = (extra: Partial<Edge> = {}): Edge => ({
  id: 'edge',
  source: 'source',
  target: 'node',
  selected: false,
  ...extra,
});

describe('BoardDocumentGraphCache', () => {
  it('strips UI-only state and keeps the persisted projection stable on selection', () => {
    const cache = new BoardDocumentGraphCache();
    const first = cache.update(
      [node({ selected: false, dragging: false, measured: { width: 240, height: 180 } })],
      [edge()],
    );
    expect(first.documentNodes[0]).not.toHaveProperty('selected');
    expect(first.documentNodes[0]).not.toHaveProperty('dragging');
    expect(first.documentNodes[0]).not.toHaveProperty('measured');
    expect(first.documentEdges[0]).not.toHaveProperty('selected');

    const selected = cache.update([node({ selected: true })], [edge({ selected: true })]);
    expect(selected.documentNodes).toBe(first.documentNodes);
    expect(selected.documentEdges).toBe(first.documentEdges);
  });

  it('creates a new document projection for content, position, and connection changes', () => {
    const cache = new BoardDocumentGraphCache();
    const first = cache.update([node()], [edge()]);
    const moved = cache.update([node({ position: { x: 3, y: 4 } })], [edge()]);
    expect(moved.documentNodes).not.toBe(first.documentNodes);
    expect(moved.documentEdges).toBe(first.documentEdges);

    const rewired = cache.update(
      [node({ position: { x: 3, y: 4 } })],
      [edge({ targetHandle: 'images[0]' })],
    );
    expect(rewired.documentEdges).not.toBe(moved.documentEdges);
  });

  it('preserves unchanged node and edge identities inside a changed document', () => {
    const cache = new BoardDocumentGraphCache();
    const first = cache.update(
      [node({ id: 'a' }), node({ id: 'b' })],
      [edge({ id: 'a-b' }), edge({ id: 'b-a', source: 'node', target: 'source' })],
    );
    const changed = cache.update(
      [node({ id: 'a' }), node({ id: 'b', position: { x: 9, y: 9 } })],
      [
        edge({ id: 'a-b' }),
        edge({ id: 'b-a', source: 'node', target: 'source', targetHandle: 'images[0]' }),
      ],
    );

    expect(changed.documentNodes).not.toBe(first.documentNodes);
    expect(changed.documentNodes[0]).toBe(first.documentNodes[0]);
    expect(changed.documentNodes[1]).not.toBe(first.documentNodes[1]);
    expect(changed.documentEdges).not.toBe(first.documentEdges);
    expect(changed.documentEdges[0]).toBe(first.documentEdges[0]);
    expect(changed.documentEdges[1]).not.toBe(first.documentEdges[1]);
  });
});
