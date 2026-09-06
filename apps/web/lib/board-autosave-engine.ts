// The board autosave state machine, lifted out of GraphBoard's Inner().
//
// It lived as 6 mutable refs and a backoff loop inside a 3137-line component,
// tangled up with node dragging, run scheduling and the whole ReactFlow tree.
// Nothing about it was reachable from a test: the only way to ask "does a 429
// hold the in-flight save instead of piling a second request on top" was to
// drive a browser.
//
// Deliberately a plain factory, not a React hook — apps/web runs vitest in the
// `node` environment with no jsdom and no @testing-library/react, so a hook
// would have been untestable here. Same shape as createAutosaveScheduler in
// ./autosave, which is tested the same way.
//
// The invariants it owns, every one of which used to be implicit:
//   1. one save in flight at a time; edits during a save only set `dirty`
//   2. a conflict freezes all saving until the caller resolves it
//   3. local state is mirrored to recovery storage BEFORE the network call
//   4. `rev` only ever advances, and only from a server-confirmed save
//   5. after a confirmed save with nothing dirty, recovery storage is cleared
import type { BoardDocument } from '@seed/shared';
import type { BoardSaveOutcome } from './board-recovery';

export interface BoardAutosaveConflict<Snapshot> {
  snapshot: Snapshot;
  serverRev: number;
  source: 'conflict' | 'recovery';
}

export interface BoardAutosaveDeps<Snapshot> {
  /** Serialise the CURRENT board. Called at save time, never cached. */
  getDocument: () => BoardDocument;
  /** Persist to the server. */
  put: (state: BoardDocument, expectedRev: number) => Promise<BoardSaveOutcome>;
  /** Mirror to local recovery storage; null when storage is unavailable. */
  preserveRecovery: (
    state: BoardDocument,
    expectedRev: number,
    serverRev?: number,
  ) => Snapshot | null;
  /** Drop the local recovery copy after a clean save. */
  clearRecovery: () => void;
  /** Wraps one attempt so the UI can show «Сохранение…» / «Не сохранено». */
  runSave: (attempt: () => Promise<boolean>) => void;
  onConflict: (conflict: BoardAutosaveConflict<Snapshot>) => void;
  onTooLarge: () => void;
  /** 429 is recoverable; surface a non-blocking notice and keep the edit dirty. */
  onRateLimited?: (retryAfterMs?: number) => void;
  /** Cancel any pending debounced save (the scheduler owns the timers). */
  cancelScheduled: () => void;
  initialRev: number;
  initiallyDirty: boolean;
}

export interface BoardAutosaveEngine {
  save(): void;
  /** Local edits exist that have not reached the server yet. */
  isDirty(): boolean;
  isSaving(): boolean;
  isBlocked(): boolean;
  rev(): number;
  /** Adopt a revision loaded from elsewhere (scenario import, conflict resolve). */
  adoptRev(rev: number): void;
  /** Mark locally dirty without saving (the caller schedules). */
  markDirty(): void;
  block(): void;
  unblock(): void;
  /** True once everything pending has landed; false if a conflict blocks it. */
  waitForIdle(opts: {
    timeoutMs: number;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  }): Promise<boolean>;
}

export function createBoardAutosaveEngine<Snapshot>(
  deps: BoardAutosaveDeps<Snapshot>,
): BoardAutosaveEngine {
  let saving = false;
  let dirty = false;
  let localDirty = deps.initiallyDirty;
  let rev = deps.initialRev;
  let blocked = false;

  const save = (): void => {
    // Invariant 2: a conflict freezes saving entirely.
    if (blocked) return;
    // Invariant 1: never a second in-flight request. Backoff happens inside the
    // attempt, so a server telling us to slow down is not answered with more.
    if (saving) {
      dirty = true;
      return;
    }
    const state = deps.getDocument();
    const expectedRev = rev;
    localDirty = true;
    // Invariant 3: durable local copy before the network, so a crash mid-save
    // still leaves the edit recoverable.
    deps.preserveRecovery(state, expectedRev);
    saving = true;
    deps.runSave(async () => {
      const result = await deps.put(state, expectedRev);
      saving = false;
      if (result.kind === 'saved') {
        rev = result.rev; // invariant 4
        if (dirty) {
          dirty = false;
          save();
        } else {
          localDirty = false;
          deps.clearRecovery(); // invariant 5
        }
        return true;
      }
      if (result.kind === 'conflict') {
        dirty = false;
        deps.cancelScheduled();
        // Prefer the freshest document; fall back to the one we tried to send.
        const snapshot =
          deps.preserveRecovery(deps.getDocument(), expectedRev, result.rev) ??
          deps.preserveRecovery(state, expectedRev, result.rev);
        if (snapshot) {
          blocked = true;
          deps.onConflict({ snapshot, serverRev: result.rev, source: 'conflict' });
        }
        return false;
      }
      if (result.error === 'state_too_large') deps.onTooLarge();
      const rateLimited = result.error === 'rate_limited';
      if (rateLimited) deps.onRateLimited?.(result.retryAfterMs);
      // A 429 must not synchronously start another attempt, including when an
      // edit arrived during the rejected request. The caller schedules the
      // retry using Retry-After/backoff and the dirty flag remains set.
      if (dirty && !rateLimited) {
        dirty = false;
        save();
      }
      return false;
    });
  };

  return {
    save,
    isDirty: () => localDirty,
    isSaving: () => saving,
    isBlocked: () => blocked,
    rev: () => rev,
    adoptRev(next) {
      rev = next;
      localDirty = false;
      dirty = false;
    },
    markDirty() {
      localDirty = true;
    },
    block() {
      blocked = true;
    },
    unblock() {
      blocked = false;
    },
    async waitForIdle({ timeoutMs, now, sleep }) {
      if (blocked) return false;
      deps.cancelScheduled();
      if (localDirty && !saving) save();
      const deadline = now() + timeoutMs;
      while ((saving || dirty || localDirty) && now() < deadline) {
        await sleep(50);
        if (blocked) return false;
      }
      return !saving && !dirty && !localDirty;
    },
  };
}
