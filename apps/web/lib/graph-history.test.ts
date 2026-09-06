import { describe, expect, it } from 'vitest';
import {
  SnapshotHistory,
  isVolatilePatch,
  mergeVolatile,
  patchNeedsStoreSync,
} from './graph-history';

type Snap = { nodes: unknown[]; edges: unknown[]; tray: string[] };
const snap = (tag: string): Snap => ({ nodes: [tag], edges: [], tray: [] });
const sameRefs = (a: Snap, b: Snap) =>
  a.nodes === b.nodes && a.edges === b.edges && a.tray === b.tray;

describe('SnapshotHistory', () => {
  it('undo restores the pre-action state; redo replays it', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const s0 = snap('s0');
    const s1 = snap('s1');
    h.snapshot(s0, undefined, 1000); // action happens, state becomes s1
    expect(h.undo(s1)).toBe(s0);
    expect(h.canUndo).toBe(false);
    expect(h.redo(s0)).toBe(s1);
    expect(h.canUndo).toBe(true);
    expect(h.canRedo).toBe(false);
  });

  it('a new snapshot clears the redo stack', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const s0 = snap('s0');
    const s1 = snap('s1');
    h.snapshot(s0, undefined, 1000);
    h.undo(s1);
    h.snapshot(s0, undefined, 2000); // diverge after undo
    expect(h.canRedo).toBe(false);
  });

  it('collapses a same-group burst within the window into one undo point', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const s0 = snap('s0');
    h.snapshot(s0, 'patch:n1:text', 1000);
    h.snapshot(snap('s1'), 'patch:n1:text', 1500); // keystroke 2
    h.snapshot(snap('s2'), 'patch:n1:text', 2000); // keystroke 3
    expect(h.depth).toBe(1);
    expect(h.undo(snap('s3'))).toBe(s0); // whole burst undone at once
  });

  it('keeps independent cast spawns and appends as one-step undo actions', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const initial = snap('initial');
    const afterSpawn = snap('spawn');
    const afterAppend = snap('append');
    h.snapshot(initial, 'cast:reference:cast-1:shot-1', 1000);
    h.snapshot(afterSpawn, 'cast:reference:cast-2:shot-2', 1050);
    expect(h.undo(afterAppend)).toEqual(afterSpawn);
    expect(h.undo(afterSpawn)).toEqual(initial);

    const appendHistory = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    appendHistory.snapshot(initial, 'cast:append:shot-1:take-1', 1000);
    appendHistory.snapshot(afterSpawn, 'cast:append:shot-2:take-2', 1050);
    expect(appendHistory.undo(afterAppend)).toEqual(afterSpawn);
    expect(appendHistory.undo(afterSpawn)).toEqual(initial);
  });

  it('restores a deleted origin cast with undo and removes it again with redo', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const withOrigin = {
      nodes: ['cast-1', 'reference-shot'],
      edges: ['cast-edge'],
      tray: [],
    };
    const withoutOrigin = { nodes: ['reference-shot'], edges: [], tray: [] };
    h.snapshot(withOrigin, 'remove:cast-1', 1000);
    expect(h.undo(withoutOrigin)).toEqual(withOrigin);
    expect(h.redo(withOrigin)).toEqual(withoutOrigin);
  });

  it('starts a new entry when the group window lapses or the key differs', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    h.snapshot(snap('s0'), 'patch:n1:text', 1000);
    h.snapshot(snap('s1'), 'patch:n1:text', 5000); // window lapsed
    h.snapshot(snap('s2'), 'patch:n2:text', 5100); // different node
    expect(h.depth).toBe(3);
  });

  it('dedupes no-op actions (drag that never moved)', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    const s0 = snap('s0');
    const s1 = { ...snap('s1') };
    h.snapshot(s0, undefined, 1000); // real action → state becomes s1
    h.snapshot(s1, undefined, 2000); // drag start
    h.snapshot(s1, undefined, 3000); // drag never moved: same refs
    expect(h.depth).toBe(2);
  });

  it('caps the stack at the limit, dropping the oldest', () => {
    const h = new SnapshotHistory<Snap>(3, 1200, sameRefs);
    for (let i = 0; i < 5; i++) h.snapshot(snap(`s${i}`), undefined, 1000 * (i + 1));
    expect(h.depth).toBe(3);
    h.undo(snap('cur'));
    h.undo(snap('s4'));
    expect(h.undo(snap('s3'))!.nodes[0]).toBe('s2'); // s0, s1 dropped
    expect(h.canUndo).toBe(false);
  });

  it('undo/redo on empty stacks is a safe null', () => {
    const h = new SnapshotHistory<Snap>(100, 1200, sameRefs);
    expect(h.undo(snap('cur'))).toBeNull();
    expect(h.redo(snap('cur'))).toBeNull();
  });
});

describe('isVolatilePatch', () => {
  it('run-pipeline patches are volatile (no undo point)', () => {
    expect(isVolatilePatch({ status: 'running', jobId: 'j1' })).toBe(true);
    expect(isVolatilePatch({ status: 'done', resultUrl: 'u', resultKind: 'video' })).toBe(true);
    expect(isVolatilePatch({ idempotencyKey: 'claim-key' })).toBe(true);
    expect(
      isVolatilePatch({
        status: 'failed',
        failureMessage: 'Провайдер не отвечает.',
        failureAction: 'retry',
      }),
    ).toBe(true);
  });
  it('treats completed takes as lifecycle state too', () => {
    expect(
      isVolatilePatch({
        status: 'done',
        resultUrl: 'u',
        resultKind: 'video',
        takes: ['u', 'alt'],
        failureMessage: undefined,
        failureAction: undefined,
      }),
    ).toBe(true);
  });
  it('user edits are not volatile', () => {
    expect(isVolatilePatch({ text: 'hi' })).toBe(false);
    expect(isVolatilePatch({ mode: 'image' })).toBe(false);
    expect(isVolatilePatch({ shot: { size: 'cu' } })).toBe(false);
    expect(isVolatilePatch({})).toBe(false);
  });
});

describe('patchNeedsStoreSync', () => {
  it('skips the bridge for a completed generation payload', () => {
    expect(
      patchNeedsStoreSync({
        status: 'done',
        resultUrl: 'u',
        resultKind: 'video',
        takes: ['u', 'alt'],
        failureMessage: undefined,
        failureAction: undefined,
      }),
    ).toBe(false);
  });

  it('bridges a mixed lifecycle and controlled-field patch', () => {
    expect(patchNeedsStoreSync({ status: 'done', name: 'Алиса' })).toBe(true);
  });

  it('skips the bridge for a status-only tick', () => {
    expect(patchNeedsStoreSync({ status: 'running' })).toBe(false);
    expect(patchNeedsStoreSync({ idempotencyKey: 'claim-key' })).toBe(false);
  });

  it('bridges unknown keys by default', () => {
    expect(patchNeedsStoreSync({ futureControlledField: 'value' })).toBe(true);
  });
});

describe('mergeVolatile', () => {
  const gen = (id: string, data: Record<string, unknown>) => ({ id, type: 'generate', data });
  const aiPrompt = (id: string, data: Record<string, unknown>) => ({
    id,
    type: 'aiprompt',
    data,
  });

  it('keeps PRESENT run state when undoing a structural change', () => {
    const snapshot = [gen('g1', { prompt: 'a', status: 'idle' })];
    const current = [gen('g1', { prompt: 'b', status: 'running', jobId: 'j9' })];
    const out = mergeVolatile(snapshot, current);
    expect(out[0]!.data).toEqual({ prompt: 'a', status: 'running', jobId: 'j9' });
  });

  it('clears stale results when the present node has none', () => {
    const snapshot = [gen('g1', { prompt: 'a', status: 'done', resultUrl: 'old.mp4' })];
    const current = [gen('g1', { prompt: 'a', status: 'idle' })];
    const out = mergeVolatile(snapshot, current);
    expect(out[0]!.data.status).toBe('idle');
    expect(out[0]!.data.resultUrl).toBeUndefined();
  });

  it('does not inject absent or AI-prompt-only fields into generate nodes', () => {
    const snapshot = [gen('g1', { prompt: 'a', status: 'idle' })];
    const current = [gen('g1', { prompt: 'b', status: 'idle' })];
    const out = mergeVolatile(snapshot, current);
    expect(out[0]!.data).toEqual({ prompt: 'a', status: 'idle' });
    expect(out[0]!.data).not.toHaveProperty('view');
    expect(out[0]!.data).not.toHaveProperty('jobId');
  });

  it('keeps PRESENT drafting state for AI-prompt nodes', () => {
    const snapshot = [aiPrompt('a1', { brief: 'old', status: 'idle', view: 'brief' })];
    const current = [aiPrompt('a1', { brief: 'new', status: 'running', view: 'result' })];
    const out = mergeVolatile(snapshot, current);
    expect(out[0]!.data).toEqual({ brief: 'old', status: 'running', view: 'result' });
  });

  it('restores deleted nodes verbatim (poll loop resumes a running job)', () => {
    const snapshot = [gen('g1', { prompt: 'a', status: 'running', jobId: 'j1' })];
    const out = mergeVolatile(snapshot, []);
    expect(out[0]!.data).toEqual({ prompt: 'a', status: 'running', jobId: 'j1' });
  });

  it('leaves nodes without lifecycle state untouched', () => {
    const snapshot = [{ id: 'p1', type: 'prompt', data: { text: 'old' } }];
    const current = [{ id: 'p1', type: 'prompt', data: { text: 'new' } }];
    expect(mergeVolatile(snapshot, current)[0]!.data.text).toBe('old');
  });
});
