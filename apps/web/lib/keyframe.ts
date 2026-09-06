/**
 * Consistency bridge (previz S4): turn a video shot's reference wiring into
 * a Seedream KEYFRAME stage — a multi-reference image node that renders the
 * shot's composition with the locked cast, then feeds the shot as its
 * first frame. Identity comes from the still, motion from the video model.
 *
 * Pure graph math: given the shot's incoming edges, produce the re-wiring
 * plan. The board applies it (spawn node, swap edges) in one snapshot.
 */

export interface EdgeLike {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null | undefined;
  targetHandle?: string | null | undefined;
}

export interface PlannedEdge {
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string;
}

export interface KeyframePlan {
  /** Image-slot edges into the shot that MOVE onto the keyframe node. */
  removeEdgeIds: string[];
  /** New edges: former ref sources → keyframe slots, prompt copies, and
   * keyframe.out → shot images[0]. */
  addEdges: PlannedEdge[];
}

function isImageSlot(h: string | null | undefined): boolean {
  return h === 'images' || /^images\[\d+\]$/.test(h ?? '');
}

/**
 * Plan the bridge for one shot.
 * - Every image-slot edge into the shot moves to the keyframe node (same
 *   order, re-slotted 0..n; Seedream takes up to 14 refs).
 * - Prompt edges are COPIED (a prompt node can feed many targets) so the
 *   keyframe renders the same scene text.
 * - The keyframe's output becomes the shot's only reference (images[0]) —
 *   first-frame semantics for Seedance.
 * Returns null when the shot has no reference wiring to bridge.
 */
export function planKeyframeBridge(
  shotId: string,
  keyframeId: string,
  edges: EdgeLike[],
): KeyframePlan | null {
  const refEdges = edges
    .filter((e) => e.target === shotId && isImageSlot(e.targetHandle))
    .sort((a, b) => {
      const ai = Number(/\[(\d+)\]/.exec(a.targetHandle ?? '')?.[1] ?? 0);
      const bi = Number(/\[(\d+)\]/.exec(b.targetHandle ?? '')?.[1] ?? 0);
      return ai - bi;
    });
  if (refEdges.length === 0) return null;

  const promptEdges = edges.filter((e) => e.target === shotId && e.targetHandle === 'prompt');

  const addEdges: PlannedEdge[] = refEdges.map((e, i) => ({
    source: e.source,
    target: keyframeId,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: `images[${i}]`,
  }));
  for (const p of promptEdges) {
    addEdges.push({
      source: p.source,
      target: keyframeId,
      sourceHandle: p.sourceHandle ?? null,
      targetHandle: 'prompt',
    });
  }
  addEdges.push({
    source: keyframeId,
    target: shotId,
    sourceHandle: 'out',
    targetHandle: 'images[0]',
  });

  return { removeEdgeIds: refEdges.map((e) => e.id), addEdges };
}
