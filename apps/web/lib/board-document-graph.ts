import type { Edge, Node } from '@xyflow/react';

function sameDocumentNode(previous: Node | undefined, node: Node) {
  return (
    previous?.id === node.id &&
    previous.type === node.type &&
    previous.data === node.data &&
    previous.position.x === node.position.x &&
    previous.position.y === node.position.y &&
    previous.width === node.width &&
    previous.height === node.height &&
    previous.parentId === node.parentId &&
    previous.extent === node.extent &&
    previous.zIndex === node.zIndex
  );
}

function sameDocumentEdge(previous: Edge | undefined, edge: Edge) {
  return (
    previous?.id === edge.id &&
    previous.source === edge.source &&
    previous.target === edge.target &&
    previous.sourceHandle === edge.sourceHandle &&
    previous.targetHandle === edge.targetHandle &&
    previous.type === edge.type &&
    previous.animated === edge.animated &&
    previous.data === edge.data
  );
}

/**
 * Stable, persistence-owned projection of React Flow state. Selection,
 * dragging, and measurements are view state: they neither dirty the document
 * nor force semantic diagnostics to rerun.
 */
export class BoardDocumentGraphCache {
  private nodes: Node[] = [];
  private edges: Edge[] = [];

  update(nodes: readonly Node[], edges: readonly Edge[]) {
    const sameNodes =
      this.nodes.length === nodes.length &&
      nodes.every((node, index) => sameDocumentNode(this.nodes[index], node));
    if (!sameNodes) {
      const previousById = new Map(this.nodes.map((node) => [node.id, node]));
      this.nodes = nodes.map((node) => {
        const previous = previousById.get(node.id);
        if (sameDocumentNode(previous, node)) return previous!;
        const {
          selected: _selected,
          dragging: _dragging,
          measured: _measured,
          ...documentNode
        } = node;
        return documentNode as Node;
      });
    }

    const sameEdges =
      this.edges.length === edges.length &&
      edges.every((edge, index) => sameDocumentEdge(this.edges[index], edge));
    if (!sameEdges) {
      const previousById = new Map(this.edges.map((edge) => [edge.id, edge]));
      this.edges = edges.map((edge) => {
        const previous = previousById.get(edge.id);
        if (sameDocumentEdge(previous, edge)) return previous!;
        const { selected: _selected, ...documentEdge } = edge;
        return documentEdge as Edge;
      });
    }
    return { documentNodes: this.nodes, documentEdges: this.edges };
  }
}
