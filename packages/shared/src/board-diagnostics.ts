import {
  boardGenerateCycleEdgeIndexes,
  boardGenerateDataSchema,
  boardGenerateSettingIssues,
  boardGenerateSettingsPatch,
  validateBoardConnection,
  validateBoardConnections,
  type BoardGenerateData,
  type BoardGenerateSettingIssue,
  type BoardModelLike,
  type BoardNode,
  type BoardNodeType,
  type BoardResolvedModelContract,
  type BoardSemanticPayload,
} from './board-contract';

export const BOARD_SEMANTIC_PAYLOAD_LABELS: Readonly<Record<BoardSemanticPayload, string>> = {
  'text.prompt': 'промпт',
  'image.reference': 'референс',
  'image.generated': 'готовый кадр',
  'image.frame.first': 'первый кадр',
  'image.frame.last': 'последний кадр',
  'video.motionReference': 'видео-референс',
  'video.generated': 'готовое видео',
  'cast.identityPack': 'объект',
  'cast.locationPack': 'место',
  'scene.context': 'сцена',
};

export interface BoardTargetInput {
  edgeId: string;
  sourceNodeId: string;
  source: Pick<BoardNode, 'type' | 'data'>;
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
}

export interface BoardEdgeDiagnostic {
  edgeId: string;
  targetNodeId: string;
  targetHandle: string | null;
  reason: string;
}

export interface BoardConnectionRole {
  edgeId: string;
  payload: BoardSemanticPayload;
  label: string;
}

export interface BoardGeneralDiagnostic {
  field: 'data' | 'content';
  reason: string;
}

export interface BoardTargetDiagnostic {
  nodeId: string;
  executable: boolean;
  edgeIssues: BoardEdgeDiagnostic[];
  settingIssues: BoardGenerateSettingIssue[];
  generalIssues: BoardGeneralDiagnostic[];
  roles: BoardConnectionRole[];
}

function targetPayload(
  payload: BoardSemanticPayload,
  model: BoardResolvedModelContract,
  targetHandle: string | null | undefined,
): BoardSemanticPayload {
  if (
    model.imageInput.role !== 'frame' ||
    !payload.startsWith('image.') ||
    payload === 'image.frame.first' ||
    payload === 'image.frame.last'
  ) {
    return payload;
  }
  const match = /^images\[(\d+)\]$/.exec(targetHandle ?? '');
  const slot = targetHandle === 'images' ? 0 : match ? Number(match[1]) : -1;
  const role = slot >= 0 ? model.imageInput.frameRoles[slot] : undefined;
  if (role === 'first') return 'image.frame.first';
  if (role === 'last') return 'image.frame.last';
  return payload;
}

export function diagnoseBoardTarget(input: {
  nodeId: string;
  target: Pick<BoardNode, 'type' | 'data'>;
  targetModel: BoardModelLike | undefined;
  connections: readonly BoardTargetInput[];
  requireReady?: boolean;
}): BoardTargetDiagnostic {
  const parsed = boardGenerateDataSchema.safeParse(input.target.data);
  if (input.target.type !== 'generate' || !parsed.success) {
    return {
      nodeId: input.nodeId,
      executable: false,
      edgeIssues: [],
      settingIssues: [],
      generalIssues: [{ field: 'data', reason: 'Данные узла не соответствуют схеме генерации.' }],
      roles: [],
    };
  }

  const target = {
    type: 'generate' as const,
    data: parsed.data,
  } as Pick<BoardNode, 'type' | 'data'>;
  const settingIssues = boardGenerateSettingIssues(parsed.data, input.targetModel);
  const edgeIssues: BoardEdgeDiagnostic[] = [];
  const roles: BoardConnectionRole[] = [];
  const accepted: BoardTargetInput[] = [];

  if (!settingIssues.some((issue) => issue.field === 'modelId')) {
    for (const connection of input.connections) {
      const single = validateBoardConnection({
        source: connection.source,
        sourceHandle: connection.sourceHandle,
        target,
        targetHandle: connection.targetHandle,
        targetModel: input.targetModel,
      });
      if (!single.ok) {
        edgeIssues.push({
          edgeId: connection.edgeId,
          targetNodeId: input.nodeId,
          targetHandle: connection.targetHandle ?? null,
          reason: single.reason,
        });
        continue;
      }

      const aggregate = validateBoardConnections({
        target,
        targetModel: input.targetModel,
        connections: [...accepted, connection],
        ...(input.requireReady !== undefined ? { requireReady: input.requireReady } : {}),
      });
      if (!aggregate.ok) {
        edgeIssues.push({
          edgeId: connection.edgeId,
          targetNodeId: input.nodeId,
          targetHandle: connection.targetHandle ?? null,
          reason: aggregate.reason,
        });
        continue;
      }
      accepted.push(connection);
      const payload = targetPayload(single.payload, single.model!, connection.targetHandle);
      roles.push({
        edgeId: connection.edgeId,
        payload,
        label: BOARD_SEMANTIC_PAYLOAD_LABELS[payload],
      });
    }
  }

  const generalIssues: BoardGeneralDiagnostic[] = [];
  if (input.requireReady && settingIssues.length === 0) {
    const hasInlinePrompt = parsed.data.prompt.trim().length > 0;
    const hasWiredPrompt = accepted.some(
      (connection) =>
        connection.targetHandle === 'prompt' &&
        typeof (connection.source.data as Record<string, unknown>).text === 'string' &&
        ((connection.source.data as Record<string, unknown>).text as string).trim().length > 0,
    );
    const hasImageInput = roles.some(
      (role) => role.payload !== 'text.prompt' && role.payload !== 'video.motionReference',
    );
    if (!hasInlinePrompt && !hasWiredPrompt && !hasImageInput) {
      generalIssues.push({
        field: 'content',
        reason: 'Нужен непустой промпт или готовое изображение на входе.',
      });
    }
  }

  return {
    nodeId: input.nodeId,
    executable: edgeIssues.length === 0 && settingIssues.length === 0 && generalIssues.length === 0,
    edgeIssues,
    settingIssues,
    generalIssues,
    roles,
  };
}

export interface BoardGraphNodeLike {
  id: string;
  type: BoardNodeType;
  data: Record<string, unknown>;
}

export interface BoardGraphEdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export interface BoardGraphDiagnostic {
  executable: boolean;
  nodes: BoardTargetDiagnostic[];
  invalidEdgeIds: string[];
  roles: BoardConnectionRole[];
}

export function diagnoseBoardGraph(input: {
  nodes: readonly BoardGraphNodeLike[];
  edges: readonly BoardGraphEdgeLike[];
  modelForNode: (node: BoardGraphNodeLike) => BoardModelLike | undefined;
  requireReady?: boolean;
}): BoardGraphDiagnostic {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const edgesByTarget = new Map<string, BoardGraphEdgeLike[]>();
  for (const edge of input.edges) {
    const targetEdges = edgesByTarget.get(edge.target);
    if (targetEdges) targetEdges.push(edge);
    else edgesByTarget.set(edge.target, [edge]);
  }
  const diagnostics = new Map<string, BoardTargetDiagnostic>();
  for (const target of input.nodes) {
    if (target.type !== 'generate') continue;
    const missing: BoardEdgeDiagnostic[] = [];
    const connections: BoardTargetInput[] = [];
    for (const edge of edgesByTarget.get(target.id) ?? []) {
      const source = nodesById.get(edge.source);
      if (!source) {
        missing.push({
          edgeId: edge.id,
          targetNodeId: target.id,
          targetHandle: edge.targetHandle ?? null,
          reason: 'Исходный узел связи не существует.',
        });
        continue;
      }
      connections.push({
        edgeId: edge.id,
        sourceNodeId: source.id,
        source: { type: source.type, data: source.data } as Pick<BoardNode, 'type' | 'data'>,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
      });
    }
    const diagnostic = diagnoseBoardTarget({
      nodeId: target.id,
      target: { type: target.type, data: target.data } as Pick<BoardNode, 'type' | 'data'>,
      targetModel: input.modelForNode(target),
      connections,
      ...(input.requireReady !== undefined ? { requireReady: input.requireReady } : {}),
    });
    diagnostic.edgeIssues.unshift(...missing);
    diagnostic.executable = diagnostic.executable && missing.length === 0;
    diagnostics.set(target.id, diagnostic);
  }

  const cycleIndexes = boardGenerateCycleEdgeIndexes(input.nodes, input.edges);
  for (const index of cycleIndexes) {
    const edge = input.edges[index]!;
    const target = diagnostics.get(edge.target);
    if (!target) continue;
    target.edgeIssues.push({
      edgeId: edge.id,
      targetNodeId: edge.target,
      targetHandle: edge.targetHandle ?? null,
      reason: 'Связь замыкает цикл между кадрами.',
    });
    target.executable = false;
  }

  const nodes = [...diagnostics.values()];
  return {
    executable: nodes.every((node) => node.executable),
    nodes,
    invalidEdgeIds: [
      ...new Set(nodes.flatMap((node) => node.edgeIssues.map((issue) => issue.edgeId))),
    ],
    roles: nodes.flatMap((node) => node.roles),
  };
}

export interface BoardModelChangeImpact {
  nextData: BoardGenerateData;
  canApplyWithoutChanges: boolean;
  edgeIssues: BoardEdgeDiagnostic[];
  settingIssues: BoardGenerateSettingIssue[];
  settingsPatch: Partial<BoardGenerateData>;
  roles: BoardConnectionRole[];
}

export function analyzeBoardModelChange(input: {
  nodeId: string;
  data: BoardGenerateData;
  nextModel: BoardModelLike;
  connections: readonly BoardTargetInput[];
}): BoardModelChangeImpact {
  const nextData = boardGenerateDataSchema.parse({ ...input.data, modelId: input.nextModel.id });
  const diagnostic = diagnoseBoardTarget({
    nodeId: input.nodeId,
    target: { type: 'generate', data: nextData } as Pick<BoardNode, 'type' | 'data'>,
    targetModel: input.nextModel,
    connections: input.connections,
    requireReady: false,
  });
  return {
    nextData,
    canApplyWithoutChanges:
      diagnostic.edgeIssues.length === 0 && diagnostic.settingIssues.length === 0,
    edgeIssues: diagnostic.edgeIssues,
    settingIssues: diagnostic.settingIssues,
    settingsPatch: boardGenerateSettingsPatch(diagnostic.settingIssues),
    roles: diagnostic.roles,
  };
}
