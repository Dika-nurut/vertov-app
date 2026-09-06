import {
  BOARD_LIMITS,
  boardNodeDefaultData,
  validateBoardConnections,
  type BoardModelLike,
  type BoardNode,
  type BoardNodeType,
} from '@seed/shared/board-contract';
import { CAST_KIND_LABEL, CAST_KIND_LABEL_GENITIVE, type CastKind } from './cast';
import { findFreePosition, type Pt } from './spawn-position';
import { BOARD_NODE_H, BOARD_NODE_W } from './board-node-layout';

export interface CastReferenceNodeLike {
  id: string;
  type?: string | null | undefined;
  data: Record<string, unknown>;
  position?: Pt | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface CastReferenceEdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export interface CastReferencePlan {
  nodes: [CastReferenceNodeLike, CastReferenceNodeLike];
  edges: [CastReferenceEdgeLike];
}

/** The persisted document shape used for the byte preflight. */
/**
 * Only ever measured, never read field-by-field: this is the persisted document
 * as autosave serializes it, so the byte preflight sizes the thing that is
 * actually saved rather than a shape invented here. Its nodes and edges are
 * deliberately `unknown` — narrowing them to the local NodeLike types made this
 * incompatible with the Zod-inferred board document and bought nothing, because
 * the only operation performed on them is JSON serialization.
 */
export interface CastReferenceDocumentLike {
  schemaVersion?: unknown;
  nodes?: readonly unknown[];
  edges?: readonly unknown[];
  [key: string]: unknown;
}

function truncateAtWordBoundary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const contentLimit = Math.max(0, limit - 1);
  let content = '';
  for (const character of value) {
    if (content.length + character.length > contentLimit) break;
    content += character;
  }
  const boundary = content.search(/\s[^\s]*$/u);
  return `${(boundary > 0 ? content.slice(0, boundary) : content).trimEnd()}…`;
}

export function castReferencePrompt(
  castKind: CastKind,
  name: string,
  sceneContext = '',
  description = '',
): string {
  const label = CAST_KIND_LABEL[castKind];
  const genitive = CAST_KIND_LABEL_GENITIVE[castKind];
  const identity = `Объект: ${label} «${name.trim()}».${description.trim() ? ` Описание: ${description.trim()}.` : ''} Референс ${genitive} — нейтральный вид для дальнейшей генерации.`;
  return truncateAtWordBoundary(
    sceneContext.trim() ? `${identity} Контекст сцены: ${sceneContext.trim()}` : identity,
    BOARD_LIMITS.text,
  );
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function nodePosition(node: CastReferenceNodeLike): Pt {
  return node.position ?? { x: 0, y: 0 };
}

const BOARD_COORDINATE_MIN = -10_000_000;
const BOARD_COORDINATE_MAX = 10_000_000;

function clampPosition(position: Pt): Pt {
  return {
    x: Math.min(BOARD_COORDINATE_MAX, Math.max(BOARD_COORDINATE_MIN, position.x)),
    y: Math.min(BOARD_COORDINATE_MAX, Math.max(BOARD_COORDINATE_MIN, position.y)),
  };
}

function hasIdleReferenceShot(nodes: readonly CastReferenceNodeLike[], castId: string): boolean {
  return nodes.some(
    (node) =>
      node.type === 'generate' &&
      node.data['originCastNodeId'] === castId &&
      node.data['status'] === 'idle',
  );
}

export function isCastReferenceSceneSeedable(
  scene: { sourceStatus?: unknown } | undefined,
): boolean {
  return scene?.sourceStatus !== 'removed';
}

/** Purely plan the two-card reference workflow; it never mutates the board. */
export function planCastReference(input: {
  cast: { id: string; data: Record<string, unknown> };
  promptId: string;
  shotId: string;
  edgeId: string;
  modelId: string | undefined;
  sceneContext: string;
  existing: readonly CastReferenceNodeLike[];
  edges: readonly CastReferenceEdgeLike[];
  /** The exact persisted projection used by autosave, including metadata and viewport. */
  currentDocument: CastReferenceDocumentLike;
}): CastReferencePlan | null {
  const { cast, promptId, shotId, edgeId, existing, edges } = input;
  const imageUrls = Array.isArray(cast.data['imageUrls']) ? cast.data['imageUrls'] : [];
  if (imageUrls.length >= BOARD_LIMITS.castImages) return null;
  if (hasIdleReferenceShot(existing, cast.id)) return null;
  if (existing.length + 2 > BOARD_LIMITS.nodes || edges.length + 1 > BOARD_LIMITS.edges)
    return null;
  if (promptId === shotId || existing.some((node) => node.id === promptId || node.id === shotId)) {
    return null;
  }
  if (edges.some((edge) => edge.id === edgeId)) return null;

  const castNode = existing.find((node) => node.id === cast.id);
  const castPosition = nodePosition(castNode ?? { id: cast.id, data: cast.data });
  const taken = existing.map(nodePosition);
  const promptPosition = clampPosition(
    findFreePosition({ x: castPosition.x + BOARD_NODE_W + 100, y: castPosition.y }, taken),
  );
  const shotPosition = clampPosition(
    findFreePosition({ x: promptPosition.x + BOARD_NODE_W + 100, y: promptPosition.y }, [
      ...taken,
      promptPosition,
    ]),
  );
  const promptNode: CastReferenceNodeLike = {
    id: promptId,
    type: 'prompt',
    width: BOARD_NODE_W,
    height: BOARD_NODE_H,
    position: promptPosition,
    data: boardNodeDefaultData('prompt', {
      text: castReferencePrompt(
        (cast.data['castKind'] as CastKind | undefined) ?? 'character',
        typeof cast.data['name'] === 'string' ? cast.data['name'] : '',
        input.sceneContext,
        typeof cast.data['description'] === 'string' ? cast.data['description'] : '',
      ),
    }),
  };
  const shotData = boardNodeDefaultData('generate', {
    mode: 'image',
    ...(input.modelId ? { modelId: input.modelId } : {}),
    originCastNodeId: cast.id,
  });
  const shotNode: CastReferenceNodeLike = {
    id: shotId,
    type: 'generate',
    width: BOARD_NODE_W,
    height: BOARD_NODE_H,
    position: shotPosition,
    data: shotData,
  };
  const plan: CastReferencePlan = {
    nodes: [promptNode, shotNode],
    edges: [
      {
        id: edgeId,
        source: promptId,
        sourceHandle: 'text',
        target: shotId,
        targetHandle: 'prompt',
      },
    ],
  };
  if (
    byteLength({
      ...input.currentDocument,
      nodes: [...(input.currentDocument.nodes ?? []), ...plan.nodes],
      edges: [...(input.currentDocument.edges ?? []), ...plan.edges],
    }) > BOARD_LIMITS.stateBytes
  ) {
    return null;
  }
  return plan;
}

export type CastReferenceAppendResult =
  | { ok: false; reason: string }
  | { ok: true; nodes: CastReferenceNodeLike[]; edges: CastReferenceEdgeLike[] };

function shotLabel(node: CastReferenceNodeLike): string {
  const prompt = typeof node.data['prompt'] === 'string' ? node.data['prompt'].trim() : '';
  return prompt ? `«${prompt.slice(0, 48)}»` : `«${node.id}»`;
}

/**
 * Validate and append one selected image take. Call this from a functional
 * graph mutation so a second action cannot validate against a stale snapshot.
 */
/**
 * Every shot already fed by this cast card must still be legal after its pack
 * changes. A reference pack is edited on the card, far away from the shots that
 * consume it, so without this the author silently poisons a route he cannot see.
 */
export function validateCastPackConsumers(input: {
  nodes: readonly CastReferenceNodeLike[];
  edges: readonly CastReferenceEdgeLike[];
  castId: string;
  changedCast: CastReferenceNodeLike;
  modelForNode: (node: CastReferenceNodeLike) => BoardModelLike | undefined;
  /** Names the attempted action in the refusal, e.g. «добавить референс». */
  verb: string;
}): { ok: true } | { ok: false; reason: string } {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  for (const edge of input.edges) {
    if (edge.source !== input.castId) continue;
    const target = nodesById.get(edge.target);
    if (!target || target.type !== 'generate') continue;
    const connections = input.edges
      .filter((candidate) => candidate.target === target.id)
      .map((candidate) => {
        const source = nodesById.get(candidate.source);
        return source
          ? {
              source: {
                type: (source.type ?? '') as BoardNodeType,
                data: source.id === input.castId ? input.changedCast.data : source.data,
              } as Pick<BoardNode, 'type' | 'data'>,
              sourceHandle: candidate.sourceHandle,
              targetHandle: candidate.targetHandle,
            }
          : null;
      });
    if (connections.some((connection) => connection === null)) {
      return {
        ok: false,
        reason: `Нельзя обновить кадр ${shotLabel(target)}: источник связи исчез.`,
      };
    }
    const semantic = validateBoardConnections({
      target: {
        type: 'generate',
        data: target.data,
      } as Pick<BoardNode, 'type' | 'data'>,
      targetModel: input.modelForNode(target),
      connections: connections as {
        source: Pick<BoardNode, 'type' | 'data'>;
        sourceHandle: string | null | undefined;
        targetHandle: string | null | undefined;
      }[],
    });
    if (!semantic.ok) {
      return {
        ok: false,
        reason: `Нельзя ${input.verb}: это нарушит кадр ${shotLabel(target)}: ${semantic.reason}`,
      };
    }
  }
  return { ok: true };
}

export function appendCastReference(input: {
  nodes: readonly CastReferenceNodeLike[];
  edges: readonly CastReferenceEdgeLike[];
  shotId: string;
  modelForNode: (node: CastReferenceNodeLike) => BoardModelLike | undefined;
  /** The exact persisted projection used by autosave, including metadata and viewport. */
  currentDocument: CastReferenceDocumentLike;
}): CastReferenceAppendResult {
  const shot = input.nodes.find((node) => node.id === input.shotId);
  if (!shot || shot.type !== 'generate')
    return { ok: false, reason: 'Референс доступен только для кадра.' };
  const originId = shot.data['originCastNodeId'];
  if (typeof originId !== 'string' || originId.length === 0) {
    return { ok: false, reason: 'У кадра нет объекта-источника.' };
  }
  if (shot.data['mode'] !== 'image' || shot.data['resultKind'] === 'video') {
    return { ok: false, reason: 'В объект можно добавить только готовую картинку.' };
  }
  if (
    shot.data['status'] !== 'done' ||
    typeof shot.data['resultUrl'] !== 'string' ||
    !shot.data['resultUrl']
  ) {
    return { ok: false, reason: 'Сначала завершите кадр и выберите нужный дубль.' };
  }
  const cast = input.nodes.find((node) => node.id === originId);
  if (!cast || cast.type !== 'cast')
    return { ok: false, reason: 'Объект-источник больше не существует.' };
  const currentImages = Array.isArray(cast.data['imageUrls']) ? cast.data['imageUrls'] : [];
  if (currentImages.length >= BOARD_LIMITS.castImages) {
    return { ok: false, reason: 'В объекте уже четыре референса.' };
  }
  const url = shot.data['resultUrl'];
  if (currentImages.includes(url))
    return { ok: false, reason: 'Этот референс уже добавлен в объект.' };

  const grownCast: CastReferenceNodeLike = {
    ...cast,
    data: { ...cast.data, imageUrls: [...currentImages, url] },
  };
  const consumers = validateCastPackConsumers({
    nodes: input.nodes,
    edges: input.edges,
    castId: originId,
    changedCast: grownCast,
    modelForNode: input.modelForNode,
    verb: 'добавить референс',
  });
  if (!consumers.ok) return consumers;

  const nodes = input.nodes.map((node) => (node.id === originId ? grownCast : node));
  if (
    byteLength({
      ...input.currentDocument,
      // The persisted document's nodes stay `unknown` (see CastReferenceDocumentLike);
      // identity is the only field read here, so narrow just that.
      nodes: (input.currentDocument.nodes ?? []).map((node) =>
        (node as { id?: unknown }).id === originId ? grownCast : node,
      ),
      edges: input.currentDocument.edges ?? [],
    }) > BOARD_LIMITS.stateBytes
  ) {
    return { ok: false, reason: 'Борд слишком большой для автосохранения.' };
  }
  return { ok: true, nodes, edges: [...input.edges] };
}
