/**
 * Plan a board-level «Снять всё» run: which shots execute, in what order,
 * and which shots require a server quote BEFORE anything runs so the user can
 * see the bill (per the canvas-parity goal: never auto-run upstream without
 * showing it). Generate nodes wired to each other (image references) must run
 * upstream-first; already-rendered shots are reused, not re-billed.
 */
export interface PlanNode {
  id: string;
  type?: string | undefined;
  mode?: 'video' | 'image' | undefined;
  count?: number | undefined;
  status?: string | undefined;
  jobId?: string | undefined;
  originCastNodeId?: string | undefined;
}
export interface PlanEdge {
  source: string;
  target: string;
  targetHandle?: string | null | undefined;
}
export interface PlanItem {
  id: string;
  mode: 'video' | 'image';
  count?: number | undefined;
}
export interface RunPlan {
  order: string[]; // generate-node ids to run, upstream-first
  tasks: { id: string; dependencies: string[] }[]; // new + persisted in-flight DAG
  items: PlanItem[]; // new shots that each require a server quote
  total: number | null; // populated only by the UI once every server quote lands
  reused: string[]; // already-done shots whose output is reused (free)
  inFlight: string[]; // already-submitted jobs to wait/reconcile (not re-billed)
}

function isImageSlot(h: string | null | undefined): boolean {
  return h === 'images' || /^images\[\d+\]$/.test(h ?? '');
}

export function planRunAll(nodes: PlanNode[], edges: PlanEdge[]): RunPlan {
  const gens = nodes.filter((n) => n.type === 'generate');
  const genIds = new Set(gens.map((n) => n.id));
  const byId = new Map(gens.map((n) => [n.id, n]));

  // dependency edges among generate nodes: an image-wire means the source
  // shot must finish before the target shot can run.
  const adj = new Map<string, string[]>();
  const deps = new Map<string, string[]>(gens.map((n) => [n.id, []]));
  const indeg = new Map<string, number>(gens.map((n) => [n.id, 0]));
  const seen = new Set<string>();
  for (const e of edges) {
    if (!isImageSlot(e.targetHandle)) continue;
    if (!genIds.has(e.source) || !genIds.has(e.target) || e.source === e.target) continue;
    const key = `${e.source}>${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    deps.set(e.target, [...(deps.get(e.target) ?? []), e.source]);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }

  // Kahn topological sort, preserving input order for stability
  const queue = gens.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const nb of adj.get(id) ?? []) {
      indeg.set(nb, (indeg.get(nb) ?? 0) - 1);
      if ((indeg.get(nb) ?? 0) === 0) queue.push(nb);
    }
  }
  // any node left in a cycle: append in input order so it still runs
  for (const n of gens) if (!topo.includes(n.id)) topo.push(n.id);

  const order: string[] = [];
  const items: PlanItem[] = [];
  const reused: string[] = [];
  const inFlight: string[] = [];
  for (const id of topo) {
    const n = byId.get(id)!;
    if (n.status === 'done') {
      reused.push(id);
      continue;
    }
    order.push(id);
    if (n.status === 'running' && n.jobId) {
      inFlight.push(id);
    } else {
      const mode: 'video' | 'image' = n.mode === 'image' ? 'image' : 'video';
      items.push({ id, mode, ...(n.count !== undefined ? { count: n.count } : {}) });
    }
  }
  const pending = new Set(order);
  const tasks = order.map((id) => ({
    id,
    dependencies: (deps.get(id) ?? []).filter((dependency) => pending.has(dependency)),
  }));
  return { order, tasks, items, total: null, reused, inFlight };
}
