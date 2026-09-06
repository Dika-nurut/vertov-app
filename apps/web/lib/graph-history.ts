/**
 * Undo/redo backbone for the «Борд» node graph.
 *
 * Snapshot-BEFORE-action: every mutating action records the pre-action
 * state, so `undo()` restores the world as it was just before the last
 * action. Consecutive snapshots that share a `groupKey` within the group
 * window collapse into one entry — a typing burst in a prompt textarea
 * undoes as a single step, not per keystroke.
 */

interface HistoryEntry<T> {
  state: T;
  groupKey?: string | undefined;
  at: number;
}

export class SnapshotHistory<T> {
  private past: HistoryEntry<T>[] = [];
  private future: T[] = [];

  constructor(
    private limit = 100,
    private groupWindowMs = 1200,
    private isSame: (a: T, b: T) => boolean = Object.is,
  ) {}

  /** Record `current` (the PRE-action state) as an undo point. */
  snapshot(current: T, groupKey?: string, now = Date.now()): void {
    this.future = [];
    const last = this.past[this.past.length - 1];
    // burst grouping: keep the pre-burst state, just extend the window
    if (last && groupKey && last.groupKey === groupKey && now - last.at <= this.groupWindowMs) {
      last.at = now;
      return;
    }
    // no-op action (e.g. drag that never moved): nothing changed since the
    // last recorded undo point — don't stack a duplicate
    if (last && this.isSame(last.state, current)) {
      last.groupKey = groupKey;
      last.at = now;
      return;
    }
    this.past.push({ state: current, groupKey, at: now });
    if (this.past.length > this.limit) this.past.shift();
  }

  /** Step back. `current` is pushed onto the redo stack. */
  undo(current: T): T | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.future.push(current);
    return entry.state;
  }

  /** Step forward again. `current` is pushed back onto the undo stack. */
  redo(current: T, now = Date.now()): T | null {
    const state = this.future.pop();
    if (state === undefined) return null;
    this.past.push({ state: current, at: now });
    return state;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get depth(): number {
    return this.past.length;
  }
  clear(): void {
    this.past = [];
    this.future = [];
  }
}

/* ------------------------------------------------------------------ *
 * Generation lifecycle state must never time-travel: undoing a node
 * move while a job runs must not resurrect an older status (it would
 * orphan the running job), and redo must not re-mark a failed node as
 * done. These keys are owned by the run pipeline, not by history.
 * ------------------------------------------------------------------ */
// 'view' is the AI-промпт brief/result toggle — pure UI state owned by the node
// while it drafts, never an undo point.
const VOLATILE_KEYS = [
  'status',
  'jobId',
  'jobIds',
  'resultUrl',
  'resultKind',
  'takes',
  'lastFrameUrl',
  'failureMessage',
  'failureAction',
] as const;
const AI_PROMPT_VOLATILE_KEYS = ['status', 'view', 'idempotencyKey'] as const;

// These fields only drive generation lifecycle/UI chrome; no custom node
// renders one as a controlled input value. Unknown keys deliberately do not
// belong here, so a future controlled field takes the safe sync path by default.
const STORE_SYNC_EXEMPT_KEYS = [
  'status',
  'jobId',
  'jobIds',
  'resultUrl',
  'resultKind',
  'takes',
  'lastFrameUrl',
  'failureMessage',
  'failureAction',
  'view',
  'idempotencyKey',
] as const;

/** True when a data patch only touches run-pipeline state (no undo point). */
export function isVolatilePatch(patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  return (
    keys.length > 0 &&
    keys.every((key) =>
      ([...VOLATILE_KEYS, ...AI_PROMPT_VOLATILE_KEYS] as readonly string[]).includes(key),
    )
  );
}

/** True when React Flow's store must match the external graph before a controlled restore. */
export function patchNeedsStoreSync(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some(
    (key) => !(STORE_SYNC_EXEMPT_KEYS as readonly string[]).includes(key),
  );
}

interface NodeLike {
  id: string;
  type?: string | undefined;
  data: Record<string, unknown>;
}

/**
 * Restore `snapshotNodes`, but for generate nodes that still exist in the
 * present, keep the PRESENT volatile fields (status, job, results).
 * Nodes that only exist in the snapshot (undoing a deletion) come back
 * verbatim — including a 'running' status, which the poll loop resumes.
 */
export function mergeVolatile<N extends NodeLike>(snapshotNodes: N[], currentNodes: N[]): N[] {
  const present = new Map(currentNodes.map((n) => [n.id, n]));
  return snapshotNodes.map((n) => {
    if (n.type !== 'generate' && n.type !== 'aiprompt') return n;
    const cur = present.get(n.id);
    if (!cur) return n;
    const data: Record<string, unknown> = { ...n.data };
    const keys = n.type === 'generate' ? VOLATILE_KEYS : AI_PROMPT_VOLATILE_KEYS;
    for (const key of keys) {
      if (cur.data[key] === undefined) delete data[key];
      else data[key] = cur.data[key];
    }
    return { ...n, data };
  });
}
