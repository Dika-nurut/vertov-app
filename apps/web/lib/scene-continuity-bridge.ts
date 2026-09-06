import {
  BOARD_LIMITS,
  boardNodeDefaultData,
  parseBoardDocument,
  resolveBoardModelContract,
  type BoardDocument,
  type BoardModelLike,
  type BoardNode,
  type BoardSceneData,
} from '@seed/shared/board-contract';
import { diagnoseBoardTarget } from '@seed/shared/board-diagnostics';
import { BOARD_NODE_H, BOARD_NODE_W } from './board-node-layout';
import { findFreePosition } from './spawn-position';

export interface SceneContinuityIds {
  promptId: string;
  shotId: string;
  promptEdgeId: string;
  castEdgeIds: readonly string[];
}

export interface SceneContinuityCast {
  id: string;
  node: BoardNode;
  name: string;
  description?: string;
}

export interface SceneContinuityOverflowItem {
  id: string;
  name: string;
  stillCount: number;
  /**
   * The pack's actual URLs. Two cards may share a still, so a sheet that sums
   * `stillCount` can refuse a selection the planner would accept; the union is
   * the only number that matches the real limit.
   */
  stillUrls: string[];
  selected: boolean;
  disabledReason?: string;
}

/** What the model can actually take, so the subset sheet can show a live total. */
export interface SceneContinuityLimits {
  slots: number;
  stills: number;
}

export type SceneContinuityPlan =
  | { ok: true; document: BoardDocument; promptId: string; shotId: string }
  | {
      ok: false;
      reason: string;
      overflow?: SceneContinuityOverflowItem[];
      limits?: SceneContinuityLimits;
    };

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function sceneContinuityPrompt(
  scene: BoardSceneData,
  casts: readonly SceneContinuityCast[],
) {
  const objectLines = casts.map((cast) => {
    const description = cast.description?.trim();
    return `- ${cast.name.trim()}${description ? `: ${description}` : ''}`;
  });
  return [
    scene.title.trim(),
    scene.synopsis.trim(),
    ...(objectLines.length ? [`Объекты:\n${objectLines.join('\n')}`] : []),
    'Кадр: опишите действие и композицию',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, BOARD_LIMITS.text);
}

function castImages(cast: SceneContinuityCast): string[] {
  const images = (cast.node.data as Record<string, unknown>)['imageUrls'];
  return Array.isArray(images)
    ? images.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];
}

function castVideo(cast: SceneContinuityCast): string | undefined {
  const value = (cast.node.data as Record<string, unknown>)['videoUrl'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A pack is never sliced, so an unusable motion clip disables the whole card. */
function videoRefusal(cast: SceneContinuityCast): string {
  return (cast.node.data as Record<string, unknown>)['castKind'] === 'location'
    ? 'Модель не поддерживает видео движения локации.'
    : 'Модель не поддерживает видеореференс этого объекта.';
}

export function planSceneContinuityShot(input: {
  document: unknown;
  sceneNodeId: string;
  casts: readonly SceneContinuityCast[];
  selectedCastIds?: readonly string[];
  model: BoardModelLike | undefined;
  ids: SceneContinuityIds;
}): SceneContinuityPlan {
  let document: BoardDocument;
  try {
    document = parseBoardDocument(input.document);
  } catch {
    return { ok: false, reason: 'Борд содержит некорректные данные.' };
  }
  const scene = document.nodes.find((node) => node.id === input.sceneNodeId);
  if (scene?.type !== 'scene') return { ok: false, reason: 'Сцена не найдена.' };
  const sceneData = scene.data as BoardSceneData;
  if (sceneData.sourceStatus === 'removed') {
    return { ok: false, reason: 'Сцена удалена из сценария — сначала обновите источник.' };
  }
  if (!input.model) return { ok: false, reason: 'Нет доступной модели изображения.' };

  const selected = new Set(input.selectedCastIds ?? input.casts.map((cast) => cast.id));
  const contract = resolveBoardModelContract(input.model);
  const limits: SceneContinuityLimits = {
    slots: contract?.imageInput.max ?? 0,
    stills:
      contract?.imageInput.role === 'reference'
        ? contract.imageInput.max
        : (contract?.referenceImageMax ?? 0),
  };
  const compatible = input.casts.filter((cast) => selected.has(cast.id) && castImages(cast).length);
  const overflow = input.casts.map((cast) => {
    const video = castVideo(cast);
    const stillUrls = castImages(cast);
    return {
      id: cast.id,
      name: cast.name,
      stillCount: stillUrls.length,
      stillUrls,
      selected: selected.has(cast.id),
      ...(video && (contract?.videoReferenceMax ?? 0) === 0
        ? { disabledReason: videoRefusal(cast) }
        : {}),
    };
  });
  const connectable = compatible.filter(
    (cast) => !(castVideo(cast) && (contract?.videoReferenceMax ?? 0) === 0),
  );
  const selectedIncompatible = overflow.filter((item) => item.selected && item.disabledReason);
  if (selectedIncompatible.length) {
    return {
      ok: false,
      reason: selectedIncompatible[0]!.disabledReason!,
      overflow,
      limits,
    };
  }
  const uniqueStillCount = new Set(connectable.flatMap(castImages)).size;
  const slotLimit = limits.slots;
  const stillLimit = limits.stills;
  if (connectable.length > slotLimit || uniqueStillCount > stillLimit) {
    // Report the limit that actually broke: quoting the URL total while the
    // slot count is what overflowed shows the author a number that fits.
    return {
      ok: false,
      reason:
        connectable.length > slotLimit
          ? `Слишком много объектов в кадре: ${connectable.length} из ${slotLimit}.`
          : `Слишком много референсов: ${uniqueStillCount} из ${stillLimit}.`,
      overflow,
      limits,
    };
  }
  const usedIds = [
    input.ids.promptId,
    input.ids.shotId,
    input.ids.promptEdgeId,
    ...input.ids.castEdgeIds.slice(0, connectable.length),
  ];
  const idSet = new Set(usedIds);
  if (
    idSet.size !== usedIds.length ||
    document.nodes.some((node) => idSet.has(node.id)) ||
    document.edges.some((edge) => idSet.has(edge.id))
  ) {
    return { ok: false, reason: 'Не удалось выделить уникальные идентификаторы.' };
  }
  if (input.ids.castEdgeIds.length < connectable.length) {
    return { ok: false, reason: 'Не удалось подготовить связи референсов.' };
  }
  if (
    document.nodes.length + 2 > BOARD_LIMITS.nodes ||
    document.edges.length + 1 + connectable.length > BOARD_LIMITS.edges
  ) {
    return { ok: false, reason: 'На борде не хватает места для нового кадра.' };
  }

  const occupied = document.nodes.map((node) => node.position);
  const promptPosition = findFreePosition(
    { x: scene.position.x + (scene.width ?? BOARD_NODE_W) + 100, y: scene.position.y },
    occupied,
  );
  const shotPosition = findFreePosition(
    { x: promptPosition.x + BOARD_NODE_W + 100, y: promptPosition.y },
    [...occupied, promptPosition],
  );
  const promptNode: BoardNode = {
    id: input.ids.promptId,
    type: 'prompt',
    version: 1,
    width: BOARD_NODE_W,
    height: BOARD_NODE_H,
    position: promptPosition,
    data: boardNodeDefaultData('prompt', {
      text: sceneContinuityPrompt(sceneData, connectable),
      sourceSceneNodeId: scene.id,
    }),
  };
  const shotNode: BoardNode = {
    id: input.ids.shotId,
    type: 'generate',
    version: 1,
    width: BOARD_NODE_W,
    height: BOARD_NODE_H,
    position: shotPosition,
    data: boardNodeDefaultData('generate', {
      mode: 'image',
      modelId: input.model.id,
      sourceSceneNodeId: scene.id,
    }),
  };
  const edges = [
    {
      id: input.ids.promptEdgeId,
      source: promptNode.id,
      sourceHandle: 'text',
      target: shotNode.id,
      targetHandle: 'prompt',
      type: 'typed',
    },
    ...connectable.map((cast, index) => ({
      id: input.ids.castEdgeIds[index]!,
      source: cast.id,
      sourceHandle: 'out',
      target: shotNode.id,
      targetHandle: `images[${index}]`,
      type: 'typed',
    })),
  ];
  const connections = edges.map((edge) => ({
    edgeId: edge.id,
    sourceNodeId: edge.source,
    source:
      edge.source === promptNode.id
        ? promptNode
        : connectable.find((c) => c.id === edge.source)!.node,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  }));
  const diagnostic = diagnoseBoardTarget({
    nodeId: shotNode.id,
    target: shotNode,
    targetModel: input.model,
    connections,
    requireReady: true,
  });
  if (!diagnostic.executable) {
    const reason =
      diagnostic.edgeIssues[0]?.reason ??
      diagnostic.settingIssues[0]?.reason ??
      diagnostic.generalIssues[0]?.reason ??
      'Кадр нельзя подготовить.';
    return { ok: false, reason, overflow };
  }
  try {
    const candidate = parseBoardDocument({
      ...document,
      nodes: [...document.nodes, promptNode, shotNode],
      edges: [...document.edges, ...edges],
    });
    if (utf8Bytes(candidate) + 64 > BOARD_LIMITS.stateBytes) {
      return { ok: false, reason: 'Борд достиг лимита 1 МиБ.' };
    }
    return { ok: true, document: candidate, promptId: promptNode.id, shotId: shotNode.id };
  } catch {
    return { ok: false, reason: 'Новый кадр не прошёл проверку борда.' };
  }
}
