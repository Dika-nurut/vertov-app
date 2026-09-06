/**
 * Expandable reference-input slots on the generate node («connect for
 * more slots», per the Runway Workflows playbook): one typed handle per
 * wired reference plus one empty slot, up to the model cap.
 */

/** Hard model limits: Seedance takes ≤2 input images, Seedream ≤14. */
export const REF_CAP = { video: 2, image: 14 } as const;

/** Slot index for an image-input handle id; null for other handles. */
export function imageHandleIndex(h: string | null | undefined): number | null {
  if (!h) return null;
  if (h === 'images') return 0; // legacy single-handle boards
  const m = /^images\[(\d+)\]$/.exec(h);
  return m ? Number(m[1]) : null;
}

/** Slot index for a reference-image handle kept separate from frame inputs. */
export function referenceImageHandleIndex(h: string | null | undefined): number | null {
  if (!h) return null;
  const m = /^referenceImages\[(\d+)\]$/.exec(h);
  return m ? Number(m[1]) : null;
}

/** How many slot handles to render: every occupied slot + one empty, ≥1, ≤cap. */
export function refSlotCount(occupied: number[], cap: number): number {
  const maxIdx = occupied.length ? Math.max(...occupied) : -1;
  return Math.max(1, Math.min(cap, maxIdx + 2));
}

/**
 * Boards saved before slot-ports wired every reference into one
 * `images` handle. Re-key those edges to sequential `images[i]` slots
 * so they keep rendering against the new per-slot handles.
 */
export function normalizeRefEdges<E extends { target: string; targetHandle?: string | null }>(
  edges: E[],
): E[] {
  const counters = new Map<string, number>();
  return edges.map((e) => {
    if (e.targetHandle !== 'images') return e;
    const i = counters.get(e.target) ?? 0;
    counters.set(e.target, i + 1);
    return { ...e, targetHandle: `images[${i}]` };
  });
}
