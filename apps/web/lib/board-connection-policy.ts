import {
  BOARD_NODE_REGISTRY,
  boardGenerateGraphHasCycle,
  validateBoardConnectionShape,
  validateBoardConnections,
  type BoardModelLike,
  type BoardNode,
  type BoardNodeType,
} from '@seed/shared/board-contract';

export interface BoardConnectionNodeLike {
  id: string;
  type?: string | null | undefined;
  data: Record<string, unknown>;
}

export interface BoardConnectionEdgeLike {
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export interface BoardConnectionCandidateLike extends BoardConnectionEdgeLike {
  sourceHandle: string | null | undefined;
  targetHandle: string | null | undefined;
}

export type BoardConnectionPolicyResult = { ok: true } | { ok: false; reason: string };

export interface BoardConnectionPolicyInput {
  nodes: readonly BoardConnectionNodeLike[];
  edges: readonly BoardConnectionEdgeLike[];
  modelForNode: (node: BoardConnectionNodeLike) => BoardModelLike | undefined;
}

export function isBoardConnectionTargetOccupied(
  connections: readonly Pick<BoardConnectionEdgeLike, 'targetHandle'>[],
  targetHandle: string | null | undefined,
): boolean {
  return connections.some((connection) => connection.targetHandle === targetHandle);
}

function connectionKey(connection: BoardConnectionCandidateLike) {
  return [
    connection.source,
    connection.sourceHandle ?? '',
    connection.target,
    connection.targetHandle ?? '',
  ].join('\u0000');
}

/**
 * Compile the stable graph work once. React Flow can ask the same validity
 * question many times during one pointer drag, so rebuilding indexes and
 * rerunning whole-graph cycle detection per pointer sample creates avoidable
 * main-thread work on large boards.
 */
export function createBoardConnectionPolicy(input: BoardConnectionPolicyInput) {
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const connectionsByTarget = new Map<
    string,
    {
      source: Pick<BoardNode, 'type' | 'data'>;
      sourceHandle: string | null | undefined;
      targetHandle: string | null | undefined;
    }[]
  >();
  for (const edge of input.edges) {
    const existingSource = nodesById.get(edge.source);
    if (!existingSource?.type || !(existingSource.type in BOARD_NODE_REGISTRY)) continue;
    const connection = {
      source: {
        type: existingSource.type as BoardNodeType,
        data: existingSource.data,
      } as Pick<BoardNode, 'type' | 'data'>,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    };
    const targetConnections = connectionsByTarget.get(edge.target);
    if (targetConnections) targetConnections.push(connection);
    else connectionsByTarget.set(edge.target, [connection]);
  }

  const targetModels = new Map<string, BoardModelLike | undefined>();
  for (const node of input.nodes) {
    if (node.type === 'generate') targetModels.set(node.id, input.modelForNode(node));
  }
  const baseGraphHasCycle = boardGenerateGraphHasCycle(input.nodes, input.edges);
  const resultCache = new Map<string, BoardConnectionPolicyResult>();

  const validate = (candidate: BoardConnectionCandidateLike): BoardConnectionPolicyResult => {
    const key = connectionKey(candidate);
    const cached = resultCache.get(key);
    if (cached) return cached;

    const source = nodesById.get(candidate.source);
    const target = nodesById.get(candidate.target);
    let result: BoardConnectionPolicyResult;
    if (!source || !target) {
      result = { ok: false, reason: 'Один из узлов связи не существует.' };
    } else if (
      !source.type ||
      !(source.type in BOARD_NODE_REGISTRY) ||
      typeof target.type !== 'string' ||
      !(target.type in BOARD_NODE_REGISTRY)
    ) {
      result = { ok: false, reason: 'Неизвестный тип узла.' };
    } else if (
      target.type === 'aiprompt' ||
      (target.type === 'cast' && candidate.targetHandle === 'scene')
    ) {
      const shape = validateBoardConnectionShape({
        source: {
          type: source.type as BoardNodeType,
          data: source.data,
        } as Pick<BoardNode, 'type' | 'data'>,
        sourceHandle: candidate.sourceHandle,
        target: { type: target.type, data: target.data } as Pick<BoardNode, 'type' | 'data'>,
        targetHandle: candidate.targetHandle,
      });
      if (!shape.ok) {
        result = shape;
      } else if (
        candidate.targetHandle === 'scene' &&
        isBoardConnectionTargetOccupied(connectionsByTarget.get(target.id) ?? [], 'scene')
      ) {
        result = { ok: false, reason: 'Вход «scene» уже занят.' };
      } else {
        result = { ok: true };
      }
    } else if (target.type !== 'generate') {
      result = { ok: false, reason: 'Этот узел не принимает входящие связи.' };
    } else {
      const semantic = validateBoardConnections({
        target: {
          type: 'generate',
          data: target.data,
        } as Pick<BoardNode, 'type' | 'data'>,
        targetModel: targetModels.get(target.id),
        connections: [
          ...(connectionsByTarget.get(target.id) ?? []),
          {
            source: {
              type: source.type as BoardNodeType,
              data: source.data,
            } as Pick<BoardNode, 'type' | 'data'>,
            sourceHandle: candidate.sourceHandle,
            targetHandle: candidate.targetHandle,
          },
        ],
      });

      if (!semantic.ok) {
        result = semantic;
        // aiprompt is not part of the generate DAG, so this cycle branch is not
        // relevant for scene → AI-промпт and intentionally never runs there.
      } else if (
        baseGraphHasCycle ||
        (source.type === 'generate' &&
          /^(?:images|referenceImages)(?:\[\d+\])?$/.test(candidate.targetHandle ?? '') &&
          boardGenerateGraphHasCycle(input.nodes, [
            ...input.edges,
            {
              source: candidate.source,
              target: candidate.target,
              targetHandle: candidate.targetHandle,
            },
          ]))
      ) {
        result = { ok: false, reason: 'Эта связь замкнёт цикл между кадрами.' };
      } else {
        result = { ok: true };
      }
    }

    resultCache.set(key, result);
    return result;
  };

  return { validate };
}

/** One-shot convenience for non-interactive callers and focused unit tests. */
export function validateBoardConnectionCandidate(
  input: BoardConnectionPolicyInput & { connection: BoardConnectionCandidateLike },
): BoardConnectionPolicyResult {
  return createBoardConnectionPolicy(input).validate(input.connection);
}
