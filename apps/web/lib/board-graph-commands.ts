import type { Edge, Node } from '@xyflow/react';
import { BOARD_LIMITS, normalizeBoardNodeOrder } from '@seed/shared/board-contract';

export function isBoardTypingTarget(
  target: {
    tagName?: string;
    isContentEditable?: boolean;
  } | null,
): boolean {
  return Boolean(
    target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
  );
}

export function clearBoardSelection(nodes: readonly Node[]): Node[] {
  return applyBoardSelection(nodes, new Set());
}

export function selectAllBoardNodes(nodes: readonly Node[]): Node[] {
  return applyBoardSelection(nodes, new Set(nodes.map((node) => node.id)));
}

/** Read selection from the authoritative node array. */
export function selectedBoardNodeIds(nodes: Iterable<Pick<Node, 'id' | 'selected'>>): Set<string> {
  const selectedIds = new Set<string>();
  for (const node of nodes) {
    if (node.selected) selectedIds.add(node.id);
  }
  return selectedIds;
}

/** Materialize the current selection when React Flow's controlled nodes lag it. */
export function applyBoardSelection(
  nodes: readonly Node[],
  selectedIds: ReadonlySet<string>,
): Node[] {
  return nodes.map((node) => {
    const selected = selectedIds.has(node.id);
    if (!selected && !node.selected) return node;
    return node.selected === selected ? node : { ...node, selected };
  });
}

export function patchBoardNode(
  nodes: readonly Node[],
  nodeId: string,
  data: Record<string, unknown>,
): Node[] {
  return nodes.map((node) =>
    node.id === nodeId
      ? {
          ...node,
          data: Object.fromEntries(
            Object.entries({ ...node.data, ...data }).filter(([, value]) => value !== undefined),
          ),
        }
      : node,
  );
}

function withoutDeletedRelations(
  nodes: readonly Node[],
  deletedCastIds: ReadonlySet<string>,
  deletedSceneIds: ReadonlySet<string>,
): Node[] {
  if (deletedCastIds.size === 0 && deletedSceneIds.size === 0) return [...nodes];
  return nodes.map((node) => {
    const data = node.data as Record<string, unknown>;
    if (node.type === 'scene' && deletedCastIds.size > 0 && Array.isArray(data['objects'])) {
      let changed = false;
      const objects = data['objects'].map((object) => {
        if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
        const objectData = object as Record<string, unknown>;
        if (
          typeof objectData['castNodeId'] !== 'string' ||
          !deletedCastIds.has(objectData['castNodeId'])
        ) {
          return object;
        }
        changed = true;
        const { castNodeId: _castNodeId, ...unlinked } = objectData;
        return unlinked;
      });
      return changed ? { ...node, data: { ...data, objects } } : node;
    }
    if (
      (node.type === 'prompt' || node.type === 'aiprompt' || node.type === 'generate') &&
      typeof data['sourceSceneNodeId'] === 'string' &&
      deletedSceneIds.has(data['sourceSceneNodeId'])
    ) {
      const { sourceSceneNodeId: _sourceSceneNodeId, ...unlinked } = data;
      return { ...node, data: unlinked };
    }
    return node;
  });
}

export function removeBoardNode(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  tray: readonly string[];
  nodeId: string;
}) {
  const removed = input.nodes.find((node) => node.id === input.nodeId);
  const deletedCastIds = new Set(removed?.type === 'cast' ? [removed.id] : []);
  const deletedSceneIds = new Set(removed?.type === 'scene' ? [removed.id] : []);
  return {
    nodes: withoutDeletedRelations(
      input.nodes.filter((node) => node.id !== input.nodeId),
      deletedCastIds,
      deletedSceneIds,
    ),
    edges: input.edges.filter(
      (edge) => edge.source !== input.nodeId && edge.target !== input.nodeId,
    ),
    tray: input.tray.filter((nodeId) => nodeId !== input.nodeId),
  };
}

/** Delete a frame while keeping React Flow's parent coordinates valid. */
export function removeBoardFrame(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  tray: readonly string[];
  frameId: string;
  includeChildren: boolean;
}) {
  const frame = input.nodes.find((node) => node.id === input.frameId);
  if (!frame || frame.type !== 'frame') {
    return { nodes: input.nodes, edges: input.edges, tray: input.tray, removed: false };
  }
  const childIds = new Set(
    input.nodes.filter((node) => node.parentId === input.frameId).map((node) => node.id),
  );
  const removedIds = input.includeChildren
    ? new Set([input.frameId, ...childIds])
    : new Set([input.frameId]);
  const nodes = input.nodes
    .filter((node) => !removedIds.has(node.id))
    .map((node) => {
      if (input.includeChildren || !childIds.has(node.id)) return node;
      const { parentId: _parentId, extent: _extent, ...detached } = node;
      return {
        ...detached,
        position: { x: node.position.x + frame.position.x, y: node.position.y + frame.position.y },
      };
    });
  return {
    nodes: normalizeBoardNodeOrder(nodes),
    edges: input.edges.filter(
      (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
    ),
    tray: input.tray.filter((nodeId) => !removedIds.has(nodeId)),
    removed: true,
  };
}

/** Place a new frame around the selected nodes using React Flow grouping. */
export function wrapBoardSelectionInFrame(input: {
  nodes: readonly Node[];
  frameId: string;
  framePosition?: { x: number; y: number };
  frameWidth?: number;
  frameHeight?: number;
}) {
  const selected = input.nodes.filter((node) => node.selected && node.type !== 'frame');
  if (selected.length === 0) return [...input.nodes];
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const absolutePosition = (node: Node): { x: number; y: number } => {
    const parent = node.parentId ? nodesById.get(node.parentId) : undefined;
    if (!parent) return node.position;
    const parentPosition = absolutePosition(parent);
    return {
      x: parentPosition.x + node.position.x,
      y: parentPosition.y + node.position.y,
    };
  };
  const selectedAbsolute = selected.map((node) => ({ node, position: absolutePosition(node) }));
  const padding = 28;
  const minX = Math.min(...selectedAbsolute.map(({ position }) => position.x));
  const minY = Math.min(...selectedAbsolute.map(({ position }) => position.y));
  const maxX = Math.max(
    ...selectedAbsolute.map(({ node, position }) => position.x + (node.width ?? 240)),
  );
  const maxY = Math.max(
    ...selectedAbsolute.map(({ node, position }) => position.y + (node.height ?? 180)),
  );
  const position = input.framePosition ?? { x: minX - padding, y: minY - padding };
  const frame: Node = {
    id: input.frameId,
    type: 'frame',
    position,
    width: Math.min(
      BOARD_LIMITS.frameDimensionMax,
      Math.max(input.frameWidth ?? 520, maxX - position.x + padding),
    ),
    height: Math.min(
      BOARD_LIMITS.frameDimensionMax,
      Math.max(input.frameHeight ?? 320, maxY - position.y + padding),
    ),
    selected: false,
    zIndex: -1,
    data: { title: 'Рамка' },
  };
  const selectedIds = new Set(selected.map((node) => node.id));
  const nodes = input.nodes.map((node) =>
    selectedIds.has(node.id)
      ? {
          ...node,
          position: (() => {
            const absolute = absolutePosition(node);
            return { x: absolute.x - position.x, y: absolute.y - position.y };
          })(),
          parentId: input.frameId,
          extent: 'parent' as const,
          selected: true,
        }
      : node,
  );
  return normalizeBoardNodeOrder([frame, ...nodes.filter((node) => node.id !== frame.id)]);
}

export function removeBoardSelection(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  tray: readonly string[];
  selectedIds?: ReadonlySet<string>;
}) {
  const selectedIds =
    input.selectedIds ??
    new Set(input.nodes.filter((node) => node.selected).map((node) => node.id));
  const nodes = applyBoardSelection(input.nodes, selectedIds);
  if (selectedIds.size === 0) {
    return { nodes, edges: input.edges, tray: input.tray, removed: false };
  }
  const selected = nodes.filter((node) => selectedIds.has(node.id));
  const deletedCastIds = new Set(
    selected.filter((node) => node.type === 'cast').map((node) => node.id),
  );
  const deletedSceneIds = new Set(
    selected.filter((node) => node.type === 'scene').map((node) => node.id),
  );
  return {
    nodes: withoutDeletedRelations(
      nodes.filter((node) => !selectedIds.has(node.id)),
      deletedCastIds,
      deletedSceneIds,
    ),
    edges: input.edges.filter(
      (edge) => !selectedIds.has(edge.source) && !selectedIds.has(edge.target),
    ),
    tray: input.tray.filter((nodeId) => !selectedIds.has(nodeId)),
    removed: true,
  };
}

/**
 * A clone is a new local workflow: it never points back into its source scene,
 * cast card, or a previous generation run.
 */
function freshCloneData(node: Node): Record<string, unknown> {
  const data = node.data as Record<string, unknown>;
  if (node.type === 'scene') {
    const {
      sourceScriptId: _sourceScriptId,
      sourceScriptRevision: _sourceScriptRevision,
      sourceSceneId: _sourceSceneId,
      sourceSceneRevision: _sourceSceneRevision,
      sourceHash: _sourceHash,
      sourceOrdinal: _sourceOrdinal,
      sourceStatus: _sourceStatus,
      objectsSourceHash: _objectsSourceHash,
      objects,
      ...localData
    } = data;
    return {
      ...localData,
      ...(Array.isArray(objects)
        ? {
            objects: objects.map((object) => {
              if (!object || typeof object !== 'object' || Array.isArray(object)) return object;
              const { castNodeId: _castNodeId, ...unlinked } = object as Record<string, unknown>;
              return unlinked;
            }),
          }
        : {}),
    };
  }
  if (node.type === 'prompt' || node.type === 'aiprompt') {
    const {
      sourceSceneNodeId: _sourceSceneNodeId,
      // A duplicate is a new paid workflow. Never let it inherit the source
      // node's claim key and replay another node's draft.
      idempotencyKey: _idempotencyKey,
      ...localData
    } = data;
    return localData;
  }
  if (node.type !== 'generate') return { ...data };
  const {
    sourceSceneNodeId: _sourceSceneNodeId,
    originCastNodeId: _originCastNodeId,
    jobId: _jobId,
    jobIds: _jobIds,
    resultUrl: _resultUrl,
    resultKind: _resultKind,
    assetId: _assetId,
    lastFrameUrl: _lastFrameUrl,
    takes: _takes,
    drifted: _drifted,
    failureMessage: _failureMessage,
    failureAction: _failureAction,
    status: _status,
    ...dataWithoutRun
  } = data;
  return { ...dataWithoutRun, status: 'idle' };
}

/** Clone a node set + the edges wholly inside it, remapping ids. */
function cloneBoardNodes(input: {
  source: readonly Node[];
  edges: readonly Edge[];
  makeId: () => string;
  positionFor: (node: Node) => { x: number; y: number };
}) {
  const idMap = new Map(input.source.map((node) => [node.id, input.makeId()] as const));
  const sourceById = new Map(input.source.map((node) => [node.id, node]));
  const absolutePosition = (node: Node): { x: number; y: number } => {
    const parent = node.parentId ? sourceById.get(node.parentId) : undefined;
    if (!parent) return node.position;
    const parentPosition = absolutePosition(parent);
    return {
      x: parentPosition.x + node.position.x,
      y: parentPosition.y + node.position.y,
    };
  };
  const clones = input.source.map((node) => {
    const id = idMap.get(node.id)!;
    const parentIsCopied = Boolean(node.parentId && idMap.has(node.parentId));
    const sourcePosition = parentIsCopied ? node.position : absolutePosition(node);
    const clone: Node = {
      ...node,
      id,
      position: input.positionFor({ ...node, position: sourcePosition }),
      selected: true,
      data: freshCloneData(node),
    };
    if (node.parentId && idMap.has(node.parentId)) {
      const parentId = idMap.get(node.parentId);
      if (parentId) clone.parentId = parentId;
      clone.extent = 'parent';
    } else {
      delete clone.parentId;
      delete clone.extent;
    }
    if (node.type === 'frame') clone.zIndex = -1;
    delete clone.dragHandle;
    return clone;
  });
  const sourceIds = new Set(input.source.map((node) => node.id));
  const clonedEdges = input.edges
    .filter((edge) => sourceIds.has(edge.source) && sourceIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      id: input.makeId(),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
      selected: false,
    }));
  return { clones: normalizeBoardNodeOrder(clones), clonedEdges };
}

export function duplicateBoardSelection(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  makeId: () => string;
  offset?: number;
  selectedIds?: ReadonlySet<string>;
}) {
  const selectedIds =
    input.selectedIds ??
    new Set(input.nodes.filter((node) => node.selected).map((node) => node.id));
  const nodes = applyBoardSelection(input.nodes, selectedIds);
  const selected = nodes.filter((node) => node.selected);
  if (selected.length === 0) return { nodes: input.nodes, edges: input.edges, duplicated: false };
  const offset = input.offset ?? 36;
  const { clones, clonedEdges } = cloneBoardNodes({
    source: selected,
    edges: input.edges,
    makeId: input.makeId,
    positionFor: (node) =>
      node.parentId && selectedIds.has(node.parentId)
        ? node.position
        : { x: node.position.x + offset, y: node.position.y + offset },
  });
  return {
    nodes: [...clearBoardSelection(nodes), ...clones],
    edges: [...input.edges, ...clonedEdges],
    duplicated: true,
  };
}

export interface BoardClipboard {
  nodes: Node[];
  edges: Edge[];
}

/** Snapshot the selection for a later paste. Detached from the live graph. */
export function copyBoardSelection(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  selectedIds?: ReadonlySet<string>;
}): BoardClipboard | null {
  const selectedIds =
    input.selectedIds ??
    new Set(input.nodes.filter((node) => node.selected).map((node) => node.id));
  const selected = input.nodes.filter((node) => selectedIds.has(node.id));
  if (selected.length === 0) return null;
  const ids = new Set(selected.map((node) => node.id));
  return {
    nodes: selected.map((node) => ({ ...node, selected: false, data: { ...node.data } })),
    edges: input.edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ ...edge })),
  };
}

/**
 * Paste a clipboard, keeping the copied cards' relative layout. `anchor` is
 * where the group's top-left lands (the caller passes the viewport centre, the
 * same place `+` drops a new card); `place` gets the last word so the paste
 * never lands on top of an existing node.
 */
export function pasteBoardClipboard(input: {
  nodes: readonly Node[];
  edges: readonly Edge[];
  clipboard: BoardClipboard | null;
  makeId: () => string;
  anchor: { x: number; y: number };
  place?: (desired: { x: number; y: number }) => { x: number; y: number };
  selectedIds?: ReadonlySet<string>;
}) {
  const copied = input.clipboard?.nodes ?? [];
  if (copied.length === 0) return { nodes: input.nodes, edges: input.edges, pasted: false };
  const copiedIds = new Set(copied.map((node) => node.id));
  const topLevel = copied.filter((node) => !node.parentId || !copiedIds.has(node.parentId));
  const originX = Math.min(...topLevel.map((node) => node.position.x));
  const originY = Math.min(...topLevel.map((node) => node.position.y));
  const place = input.place ?? ((desired) => desired);
  const nodes = input.selectedIds
    ? applyBoardSelection(input.nodes, input.selectedIds)
    : (input.nodes as Node[]);
  const { clones, clonedEdges } = cloneBoardNodes({
    source: copied,
    edges: input.clipboard!.edges,
    makeId: input.makeId,
    positionFor: (node) =>
      node.parentId && copiedIds.has(node.parentId)
        ? node.position
        : place({
            x: input.anchor.x + (node.position.x - originX),
            y: input.anchor.y + (node.position.y - originY),
          }),
  });
  return {
    nodes: [...clearBoardSelection(nodes), ...clones],
    edges: [...input.edges, ...clonedEdges],
    pasted: true,
  };
}
