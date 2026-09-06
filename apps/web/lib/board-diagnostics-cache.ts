import {
  boardGenerateCycleEdgeIndexes,
  type BoardModelLike,
  type BoardNode,
} from '@seed/shared/board-contract';
import {
  diagnoseBoardTarget,
  type BoardEdgeDiagnostic,
  type BoardGraphDiagnostic,
  type BoardGraphEdgeLike,
  type BoardGraphNodeLike,
  type BoardTargetDiagnostic,
  type BoardTargetInput,
} from '@seed/shared/board-diagnostics';

interface ConnectionIdentity {
  edge: BoardGraphEdgeLike;
  source: BoardGraphNodeLike | undefined;
}

interface CachedTarget {
  data: Record<string, unknown>;
  model: BoardModelLike | undefined;
  requireReady: boolean | undefined;
  connections: ConnectionIdentity[];
  diagnostic: BoardTargetDiagnostic;
}

function sameConnections(a: readonly ConnectionIdentity[], b: readonly ConnectionIdentity[]) {
  return (
    a.length === b.length &&
    a.every((connection, index) => {
      const candidate = b[index];
      return connection.edge === candidate?.edge && connection.source === candidate.source;
    })
  );
}

function cloneDiagnostic(diagnostic: BoardTargetDiagnostic): BoardTargetDiagnostic {
  return {
    ...diagnostic,
    edgeIssues: [...diagnostic.edgeIssues],
    settingIssues: [...diagnostic.settingIssues],
    generalIssues: [...diagnostic.generalIssues],
    roles: [...diagnostic.roles],
  };
}

/**
 * Incremental semantic diagnostics for interactive Boards. A connection edit
 * normally changes one target; unchanged targets retain their schema/model
 * validation result while cycle detection still runs across the full graph.
 */
export class BoardGraphDiagnosticsCache {
  private targets = new Map<string, CachedTarget>();

  update(input: {
    nodes: readonly BoardGraphNodeLike[];
    edges: readonly BoardGraphEdgeLike[];
    modelForNode: (node: BoardGraphNodeLike) => BoardModelLike | undefined;
    requireReady?: boolean;
  }): BoardGraphDiagnostic {
    const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
    const edgesByTarget = new Map<string, BoardGraphEdgeLike[]>();
    for (const edge of input.edges) {
      const current = edgesByTarget.get(edge.target);
      if (current) current.push(edge);
      else edgesByTarget.set(edge.target, [edge]);
    }

    const nextTargets = new Map<string, CachedTarget>();
    const diagnostics = new Map<string, BoardTargetDiagnostic>();
    for (const target of input.nodes) {
      if (target.type !== 'generate') continue;
      const model = input.modelForNode(target);
      const identities = (edgesByTarget.get(target.id) ?? []).map((edge) => ({
        edge,
        source: nodesById.get(edge.source),
      }));
      const previous = this.targets.get(target.id);
      let diagnostic: BoardTargetDiagnostic;
      if (
        previous?.data === target.data &&
        previous.model === model &&
        previous.requireReady === input.requireReady &&
        sameConnections(previous.connections, identities)
      ) {
        diagnostic = previous.diagnostic;
      } else {
        const missing: BoardEdgeDiagnostic[] = [];
        const connections: BoardTargetInput[] = [];
        for (const { edge, source } of identities) {
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
        diagnostic = diagnoseBoardTarget({
          nodeId: target.id,
          target: { type: target.type, data: target.data } as Pick<BoardNode, 'type' | 'data'>,
          targetModel: model,
          connections,
          ...(input.requireReady !== undefined ? { requireReady: input.requireReady } : {}),
        });
        if (missing.length > 0) {
          diagnostic = {
            ...diagnostic,
            executable: false,
            edgeIssues: [...missing, ...diagnostic.edgeIssues],
          };
        }
      }
      nextTargets.set(target.id, {
        data: target.data,
        model,
        requireReady: input.requireReady,
        connections: identities,
        diagnostic,
      });
      diagnostics.set(target.id, cloneDiagnostic(diagnostic));
    }
    this.targets = nextTargets;

    for (const index of boardGenerateCycleEdgeIndexes(input.nodes, input.edges)) {
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
}
