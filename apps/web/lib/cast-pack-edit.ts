import { BOARD_LIMITS, type BoardModelLike } from '@seed/shared/board-contract';
import {
  validateCastPackConsumers,
  type CastReferenceEdgeLike,
  type CastReferenceNodeLike,
} from './cast-reference';

export type CastPackEditPlan =
  | {
      ok: true;
      nodes: CastReferenceNodeLike[];
      edges: CastReferenceEdgeLike[];
      /** Shots that lose their link because the pack ran empty. */
      detachedShotIds: string[];
    }
  | { ok: false; reason: string };

function castImages(node: CastReferenceNodeLike): string[] {
  const value = node.data['imageUrls'];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function withImages(node: CastReferenceNodeLike, imageUrls: string[]): CastReferenceNodeLike {
  return { ...node, data: { ...node.data, imageUrls } };
}

/**
 * Adding a still is refused atomically when any shot the card already feeds
 * would overflow its model. The author edits the pack on the card; the damage
 * would otherwise appear on a shot elsewhere on the canvas.
 */
export function planCastStillAdd(input: {
  nodes: readonly CastReferenceNodeLike[];
  edges: readonly CastReferenceEdgeLike[];
  castId: string;
  url: string;
  modelForNode: (node: CastReferenceNodeLike) => BoardModelLike | undefined;
}): CastPackEditPlan {
  const cast = input.nodes.find((node) => node.id === input.castId);
  if (!cast || cast.type !== 'cast') return { ok: false, reason: 'Объект не найден.' };
  const images = castImages(cast);
  if (images.length >= BOARD_LIMITS.castImages) {
    return { ok: false, reason: 'В объекте уже четыре референса.' };
  }
  if (images.includes(input.url)) {
    return { ok: false, reason: 'Этот референс уже добавлен в объект.' };
  }
  const grown = withImages(cast, [...images, input.url]);
  const consumers = validateCastPackConsumers({
    nodes: input.nodes,
    edges: input.edges,
    castId: input.castId,
    changedCast: grown,
    modelForNode: input.modelForNode,
    verb: 'добавить референс',
  });
  if (!consumers.ok) return consumers;

  // Size is deliberately NOT checked here: the caller runs the shared commit
  // guard on the exact parsed document, and a second, hybrid measurement of
  // React Flow nodes only produced a different — wrong — answer near the limit.
  const nodes = input.nodes.map((node) => (node.id === input.castId ? grown : node));
  return { ok: true, nodes, edges: [...input.edges], detachedShotIds: [] };
}

/**
 * Removing the last still detaches the card from every shot it feeds, in the
 * same snapshot. A persisted edge from an empty pack is the state this exists
 * to make unreachable; the caller confirms with the author first.
 */
export function planCastStillRemove(input: {
  nodes: readonly CastReferenceNodeLike[];
  edges: readonly CastReferenceEdgeLike[];
  castId: string;
  index: number;
}): CastPackEditPlan {
  const cast = input.nodes.find((node) => node.id === input.castId);
  if (!cast || cast.type !== 'cast') return { ok: false, reason: 'Объект не найден.' };
  const images = castImages(cast);
  if (input.index < 0 || input.index >= images.length) {
    return { ok: false, reason: 'Этого референса больше нет.' };
  }
  const remaining = images.filter((_, index) => index !== input.index);
  const shrunk = withImages(cast, remaining);
  const nodes = input.nodes.map((node) => (node.id === input.castId ? shrunk : node));
  if (remaining.length > 0) {
    return { ok: true, nodes, edges: [...input.edges], detachedShotIds: [] };
  }
  // An empty pack invalidates EVERY consumer, so every edge out of this card
  // goes — not just the ones that happen to land on a `generate`. Filtering by
  // target type would leave an edge feeding an empty pack to anything else.
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const edges = input.edges.filter((edge) => edge.source !== input.castId);
  const detachedShotIds = [
    ...new Set(
      input.edges
        .filter(
          (edge) => edge.source === input.castId && nodesById.get(edge.target)?.type === 'generate',
        )
        .map((edge) => edge.target),
    ),
  ];
  return { ok: true, nodes, edges, detachedShotIds };
}
