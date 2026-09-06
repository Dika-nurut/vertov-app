import { createHash } from 'node:crypto';
import { parseFountain, sceneList } from '@seed/screenplay';
import {
  BOARD_LIMITS,
  BOARD_NODE_VERSION,
  parseBoardDocument,
  type BoardDocument,
  type BoardNode,
  type BoardSceneData,
} from '@seed/shared/board-contract';
import type { ScenarioFormat, ScenarioOutlineV1 } from '@seed/shared';
import type { ScenarioShotPlan } from '@seed/shared/scenario-shot-plan';

export interface ScenarioHandoffScene {
  sourceId?: string;
  ordinal: number;
  heading: string;
  synopsis: string;
  sourceText: string;
  sourceHash: string;
  /** Optional normalized M3 plan; absent keeps the legacy scene-only handoff. */
  shotPlan?: ScenarioShotPlan;
}

export function extractScenarioHandoffSources(input: {
  format: ScenarioFormat;
  outline: ScenarioOutlineV1;
  fountain: string;
}): ScenarioHandoffScene[] {
  if (input.format === 'film' || input.outline.beats.length === 0) {
    return extractScenarioHandoffScenes(input.fountain);
  }
  return input.outline.beats.map((beat, index) => {
    const sourceText = [
      beat.title,
      beat.summary,
      beat.visual ? `Визуал: ${beat.visual}` : '',
      beat.spokenText ? `Текст: ${beat.spokenText}` : '',
      beat.onScreenText ? `На экране: ${beat.onScreenText}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      sourceId: beat.id,
      ordinal: index + 1,
      heading: beat.title,
      synopsis: beat.summary.slice(0, 500),
      sourceText,
      sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    };
  });
}

export interface ScenarioBoardMergeResult {
  document: BoardDocument;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  materializedShots: number;
  materializedCastNodes: number;
}

export class ScenarioBoardMaterializationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioBoardMaterializationLimitError';
  }
}

const normalizeHeading = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function extractScenarioHandoffScenes(fountain: string): ScenarioHandoffScene[] {
  return sceneList(fountain).map((scene) => {
    const sourceText = fountain.slice(scene.from, scene.to).trimEnd();
    const parsed = parseFountain(sourceText);
    const synopsisElement = parsed.elements.find((element) => element.type === 'synopsis');
    const firstAction = parsed.elements.find(
      (element) => element.type === 'action' && element.text.trim().length > 0,
    );
    const synopsis = (synopsisElement?.text ?? firstAction?.text ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    return {
      ordinal: scene.index,
      heading: scene.heading,
      synopsis,
      sourceText,
      sourceHash: createHash('sha256').update(sourceText).digest('hex'),
    };
  });
}

function sceneData(node: BoardNode): BoardSceneData | null {
  return node.type === 'scene' ? (node.data as BoardSceneData) : null;
}

type SceneReuseResult =
  | { kind: 'matched'; node: BoardNode }
  | { kind: 'ambiguous'; candidates: BoardNode[] }
  | { kind: 'new' };

/**
 * Match a source scene without guessing. Outline beats carry a stable upstream
 * id; Fountain scenes do not, so their fallbacks must identify exactly one
 * still-unused Board scene. A duplicate signal is deliberately not resolved by
 * a later, weaker signal: changing the wrong source node is worse than leaving
 * an author-visible partial re-sync.
 */
function findReusableSceneNode(
  candidates: BoardNode[],
  used: Set<string>,
  scene: ScenarioHandoffScene,
): SceneReuseResult {
  const available = candidates.filter((node) => !used.has(node.id));
  const tryUnique = (matches: BoardNode[]): SceneReuseResult | null => {
    if (matches.length === 1) return { kind: 'matched', node: matches[0]! };
    if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
    return null;
  };

  if (scene.sourceId) {
    const bySourceId = tryUnique(
      available.filter((node) => sceneData(node)?.sourceSceneId === scene.sourceId),
    );
    if (bySourceId) return bySourceId;
  }

  const byHash = tryUnique(
    available.filter((node) => sceneData(node)?.sourceHash === scene.sourceHash),
  );
  if (byHash) return byHash;

  const heading = normalizeHeading(scene.heading);
  const byHeading = tryUnique(
    available.filter((node) => normalizeHeading(sceneData(node)?.title ?? '') === heading),
  );
  if (byHeading) return byHeading;

  const byOrdinal = tryUnique(
    available.filter((node) => sceneData(node)?.sourceOrdinal === scene.ordinal),
  );
  if (byOrdinal) return byOrdinal;

  return { kind: 'new' };
}

export function mergeScenarioScenesIntoBoard(input: {
  document: unknown;
  scriptId: string;
  scriptRevision: number;
  scenes: readonly ScenarioHandoffScene[];
  fullSync: boolean;
  makeId: () => string;
}): ScenarioBoardMergeResult {
  const document = parseBoardDocument(input.document);
  const linked = document.nodes.filter(
    (node) => node.type === 'scene' && sceneData(node)?.sourceScriptId === input.scriptId,
  );
  const used = new Set<string>();
  const protectedFromRemoval = new Set<string>();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const edges = [...document.edges];
  const edgeIds = new Set(edges.map((edge) => edge.id));
  const maxSceneY = linked.reduce((max, node) => Math.max(max, node.position.y), -280);
  let materializedShots = 0;
  let materializedCastNodes = 0;

  input.scenes.forEach((scene, index) => {
    const reuse = findReusableSceneNode(linked, used, scene);
    if (reuse.kind === 'ambiguous') {
      skipped += 1;
      for (const candidate of reuse.candidates) protectedFromRemoval.add(candidate.id);
      return;
    }
    const existing = reuse.kind === 'matched' ? reuse.node : undefined;
    if (existing) used.add(existing.id);
    const existingData = existing ? sceneData(existing) : null;
    const sourceSceneId = scene.sourceId ?? existingData?.sourceSceneId ?? input.makeId();
    // Start from the persisted record and overwrite only the source-owned
    // fields. Rebuilding `data` from a whitelist silently drops every
    // local-owned optional the schema gains later: that is how a re-sync lost
    // `objectsSourceHash` and made the stale-objects banner unreachable.
    const data: BoardSceneData = {
      ...(existingData ?? {}),
      title: scene.heading,
      synopsis: scene.synopsis,
      sourceText: scene.sourceText,
      sourceScriptId: input.scriptId,
      sourceScriptRevision: input.scriptRevision,
      sourceSceneId,
      sourceSceneRevision: input.scriptRevision,
      sourceOrdinal: scene.ordinal,
      sourceHash: scene.sourceHash,
      sourceStatus: 'current',
      collapsed: existingData?.collapsed ?? true,
    };
    // An empty array is never written: absence is the persisted shape.
    if (!data.objects?.length) delete data.objects;
    const sceneNodeId = existing?.id ?? input.makeId();
    if (existing) {
      byId.set(existing.id, { ...existing, data });
      updated += 1;
    } else {
      byId.set(sceneNodeId, {
        id: sceneNodeId,
        type: 'scene',
        version: BOARD_NODE_VERSION,
        position: { x: 80, y: maxSceneY + 360 * (index + 1) },
        width: 360,
        height: 280,
        data,
      });
      added += 1;
    }

    if (scene.shotPlan) {
      const materialized = materializeScenarioShotPlan({
        byId,
        edges,
        edgeIds,
        scriptId: input.scriptId,
        sourceSceneId,
        sceneNodeId,
        sceneY: (byId.get(sceneNodeId) as BoardNode).position.y,
        plan: scene.shotPlan,
        makeId: input.makeId,
      });
      materializedShots += materialized.shots;
      materializedCastNodes += materialized.castNodes;
    }
  });

  let removed = 0;
  if (input.fullSync) {
    for (const node of linked) {
      if (used.has(node.id) || protectedFromRemoval.has(node.id)) continue;
      const data = sceneData(node)!;
      if (data.sourceStatus === 'removed') continue;
      byId.set(node.id, { ...node, data: { ...data, sourceStatus: 'removed' } });
      removed += 1;
    }
  }

  assertBoardCapacity(byId.size, edges.length);
  return {
    document: parseBoardDocument({ ...document, nodes: [...byId.values()], edges }),
    added,
    updated,
    removed,
    skipped,
    materializedShots,
    materializedCastNodes,
  };
}

function idForMaterialization(scriptId: string, sourceSceneId: string, kind: string, extra = '') {
  const digest = createHash('sha256')
    .update(`${scriptId}\u0000${sourceSceneId}\u0000${kind}\u0000${extra}`)
    .digest('hex')
    .slice(0, 40);
  return `scenario-${kind}-${digest}`;
}

function ensureEdge(input: {
  edges: BoardDocument['edges'];
  edgeIds: Set<string>;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  makeId: () => string;
}) {
  const exists = input.edges.some(
    (edge) =>
      edge.source === input.source &&
      edge.sourceHandle === input.sourceHandle &&
      edge.target === input.target &&
      edge.targetHandle === input.targetHandle,
  );
  if (exists) return;
  let id = idForMaterialization(
    input.source,
    input.target,
    'edge',
    `${input.sourceHandle}:${input.targetHandle}`,
  );
  while (input.edgeIds.has(id)) id = input.makeId();
  input.edgeIds.add(id);
  input.edges.push({
    id,
    source: input.source,
    sourceHandle: input.sourceHandle,
    target: input.target,
    targetHandle: input.targetHandle,
  });
}

function materializeScenarioShotPlan(input: {
  byId: Map<string, BoardNode>;
  edges: BoardDocument['edges'];
  edgeIds: Set<string>;
  scriptId: string;
  sourceSceneId: string;
  sceneNodeId: string;
  sceneY: number;
  plan: ScenarioShotPlan;
  makeId: () => string;
}): { shots: number; castNodes: number } {
  const newCastIds = new Set<string>();
  for (const shot of input.plan.shots) {
    const promptId = idForMaterialization(
      input.scriptId,
      input.sourceSceneId,
      'prompt',
      String(shot.order),
    );
    const generateId = idForMaterialization(
      input.scriptId,
      input.sourceSceneId,
      'generate',
      String(shot.order),
    );
    const y = input.sceneY + 320 + (shot.order - 1) * 300;
    const previousPrompt = input.byId.get(promptId);
    if (previousPrompt?.type === 'prompt') {
      input.byId.set(promptId, {
        ...previousPrompt,
        data: {
          ...previousPrompt.data,
          text: shot.promptDraft,
          sourceSceneNodeId: input.sceneNodeId,
        },
      });
    } else if (!previousPrompt) {
      input.byId.set(promptId, {
        id: promptId,
        type: 'prompt',
        version: BOARD_NODE_VERSION,
        position: { x: 520, y },
        width: 360,
        height: 220,
        data: { text: shot.promptDraft, sourceSceneNodeId: input.sceneNodeId },
      });
    }

    const previousGenerate = input.byId.get(generateId);
    const previousGenerateStatus =
      previousGenerate?.type === 'generate' ? previousGenerate.data.status : undefined;
    const generateData = {
      mode: 'video' as const,
      prompt: '',
      ...(shot.shotGrammar ? { shot: shot.shotGrammar } : {}),
      durationSeconds: shot.durationSec,
      count: 1 as const,
      status:
        previousGenerateStatus === 'done' || previousGenerateStatus === 'running'
          ? previousGenerateStatus
          : ('idle' as const),
      sourceSceneNodeId: input.sceneNodeId,
      ...(previousGenerateStatus === 'done' ? { drifted: true } : {}),
    };
    if (previousGenerate?.type === 'generate') {
      input.byId.set(generateId, {
        ...previousGenerate,
        data: { ...previousGenerate.data, ...generateData },
      });
    } else if (!previousGenerate) {
      input.byId.set(generateId, {
        id: generateId,
        type: 'generate',
        version: BOARD_NODE_VERSION,
        position: { x: 940, y },
        width: 380,
        height: 300,
        data: generateData,
      });
    }
    ensureEdge({
      edges: input.edges,
      edgeIds: input.edgeIds,
      source: promptId,
      sourceHandle: 'text',
      target: generateId,
      targetHandle: 'prompt',
      makeId: input.makeId,
    });

    shot.unresolvedAssets.forEach((asset, index) => {
      const castId = idForMaterialization(input.scriptId, input.sourceSceneId, 'cast', asset);
      const previousCast = input.byId.get(castId);
      if (previousCast?.type === 'cast') {
        input.byId.set(castId, {
          ...previousCast,
          data: { ...previousCast.data, name: asset, castKind: 'character' },
        });
      } else if (!previousCast) {
        input.byId.set(castId, {
          id: castId,
          type: 'cast',
          version: BOARD_NODE_VERSION,
          position: { x: 120, y: input.sceneY + 320 + newCastIds.size * 180 },
          width: 300,
          height: 180,
          data: { castKind: 'character', name: asset, imageUrls: [] },
        });
        newCastIds.add(castId);
      }
      ensureEdge({
        edges: input.edges,
        edgeIds: input.edgeIds,
        source: castId,
        sourceHandle: 'out',
        target: generateId,
        targetHandle: `images[${index}]`,
        makeId: input.makeId,
      });
    });
  }

  assertBoardCapacity(input.byId.size, input.edges.length);
  return { shots: input.plan.shots.length, castNodes: newCastIds.size };
}

function assertBoardCapacity(nodeCount: number, edgeCount: number): void {
  if (nodeCount > BOARD_LIMITS.nodes) {
    throw new ScenarioBoardMaterializationLimitError(
      'board node limit exceeded: ' + nodeCount + '/' + BOARD_LIMITS.nodes,
    );
  }
  if (edgeCount > BOARD_LIMITS.edges) {
    throw new ScenarioBoardMaterializationLimitError(
      'board edge limit exceeded: ' + edgeCount + '/' + BOARD_LIMITS.edges,
    );
  }
}

export function boardLinksToScript(document: unknown, scriptId: string): boolean {
  const parsed = parseBoardDocument(document);
  return parsed.nodes.some(
    (node) => node.type === 'scene' && sceneData(node)?.sourceScriptId === scriptId,
  );
}
