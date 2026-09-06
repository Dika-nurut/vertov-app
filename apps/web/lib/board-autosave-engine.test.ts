import { describe, expect, it } from 'vitest';
import { createBoardAutosaveEngine, type BoardAutosaveDeps } from './board-autosave-engine';
import type { BoardSaveOutcome } from './board-recovery';
import type { BoardDocument } from '@seed/shared';

// A board document is opaque to the engine — it only ever passes it through.
const doc = (marker: string) => ({ marker }) as unknown as BoardDocument;

function harness(overrides: Partial<BoardAutosaveDeps<{ id: string }>> = {}) {
  const puts: Array<{ state: BoardDocument; expectedRev: number }> = [];
  const preserved: Array<{ expectedRev: number; serverRev: number | undefined }> = [];
  const conflicts: Array<{ serverRev: number }> = [];
  let pending: Array<(outcome: BoardSaveOutcome) => void> = [];
  let cleared = 0;
  let tooLarge = 0;
  let rateLimited = 0;
  let cancelled = 0;
  let docMarker = 'a';

  const deps: BoardAutosaveDeps<{ id: string }> = {
    getDocument: () => doc(docMarker),
    put: (state, expectedRev) => {
      puts.push({ state, expectedRev });
      return new Promise<BoardSaveOutcome>((resolve) => pending.push(resolve));
    },
    preserveRecovery: (_state, expectedRev, serverRev) => {
      preserved.push({ expectedRev, serverRev });
      return { id: `snap-${preserved.length}` };
    },
    clearRecovery: () => {
      cleared += 1;
    },
    runSave: (attempt) => {
      void attempt();
    },
    onConflict: (c) => {
      conflicts.push({ serverRev: c.serverRev });
    },
    onTooLarge: () => {
      tooLarge += 1;
    },
    onRateLimited: () => {
      rateLimited += 1;
    },
    cancelScheduled: () => {
      cancelled += 1;
    },
    initialRev: 7,
    initiallyDirty: false,
    ...overrides,
  };

  const engine = createBoardAutosaveEngine(deps);
  const settle = async (outcome: BoardSaveOutcome) => {
    const resolvers = pending;
    pending = [];
    resolvers.forEach((r) => r(outcome));
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    engine,
    settle,
    puts,
    preserved,
    conflicts,
    setDoc: (m: string) => {
      docMarker = m;
    },
    counts: () => ({ cleared, tooLarge, rateLimited, cancelled }),
  };
}

describe('board autosave engine', () => {
  it('sends the board at the revision it was loaded at', async () => {
    const h = harness();
    h.engine.save();
    expect(h.puts).toEqual([{ state: doc('a'), expectedRev: 7 }]);
    await h.settle({ kind: 'saved', rev: 8 });
    expect(h.engine.rev()).toBe(8);
    expect(h.engine.isDirty()).toBe(false);
    expect(h.counts().cleared).toBe(1);
  });

  it('never puts a second request in flight — an edit mid-save queues instead', async () => {
    const h = harness();
    h.engine.save();
    h.engine.save();
    h.engine.save();
    expect(h.puts).toHaveLength(1);

    // The queued edit flushes exactly once when the first save lands.
    h.setDoc('b');
    await h.settle({ kind: 'saved', rev: 8 });
    expect(h.puts).toHaveLength(2);
    expect(h.puts[1]).toEqual({ state: doc('b'), expectedRev: 8 });
  });

  it('mirrors to recovery storage BEFORE the network call', () => {
    const h = harness();
    h.engine.save();
    // preserveRecovery ran, and it ran against the same revision we sent.
    expect(h.preserved).toEqual([{ expectedRev: 7, serverRev: undefined }]);
    expect(h.puts[0]!.expectedRev).toBe(7);
  });

  it('freezes every subsequent save once the server reports a conflict', async () => {
    const h = harness();
    h.engine.save();
    await h.settle({ kind: 'conflict', rev: 99 });

    expect(h.conflicts).toEqual([{ serverRev: 99 }]);
    expect(h.engine.isBlocked()).toBe(true);
    expect(h.counts().cancelled).toBe(1);

    h.engine.save();
    h.engine.save();
    expect(h.puts).toHaveLength(1); // still only the original attempt
  });

  it('keeps the revision unchanged when a save fails', async () => {
    const h = harness();
    h.engine.save();
    await h.settle({ kind: 'failed' });
    expect(h.engine.rev()).toBe(7);
    expect(h.engine.isDirty()).toBe(true);
    expect(h.counts().cleared).toBe(0); // recovery copy survives a failure
  });

  it('reports a too-large board without clearing the local copy', async () => {
    const h = harness();
    h.engine.save();
    await h.settle({ kind: 'failed', error: 'state_too_large' });
    expect(h.counts().tooLarge).toBe(1);
    expect(h.counts().cleared).toBe(0);
    expect(h.engine.isDirty()).toBe(true);
  });

  it('backs off after a 429 without starting a second save immediately', async () => {
    const h = harness();
    h.engine.save();
    h.engine.markDirty();
    await h.settle({ kind: 'failed', error: 'rate_limited' });
    expect(h.counts().rateLimited).toBe(1);
    expect(h.puts).toHaveLength(1);
    expect(h.engine.isDirty()).toBe(true);
  });

  it('waitForIdle resolves true once the pending save lands', async () => {
    const h = harness({ initiallyDirty: true });
    let clock = 0;
    const idle = h.engine.waitForIdle({
      timeoutMs: 1000,
      now: () => clock,
      sleep: async () => {
        clock += 50;
        if (clock === 100) await h.settle({ kind: 'saved', rev: 8 });
      },
    });
    expect(await idle).toBe(true);
    expect(h.engine.rev()).toBe(8);
  });

  it('waitForIdle gives up at the deadline rather than hanging', async () => {
    const h = harness({ initiallyDirty: true });
    let clock = 0;
    const ok = await h.engine.waitForIdle({
      timeoutMs: 200,
      now: () => clock,
      sleep: async () => {
        clock += 50;
      },
    });
    expect(ok).toBe(false);
    expect(h.engine.isDirty()).toBe(true);
  });

  it('waitForIdle refuses immediately while a conflict is unresolved', async () => {
    const h = harness();
    h.engine.block();
    const ok = await h.engine.waitForIdle({
      timeoutMs: 1000,
      now: () => 0,
      sleep: async () => {},
    });
    expect(ok).toBe(false);
    expect(h.puts).toHaveLength(0);
  });

  it('adoptRev takes an externally loaded revision and drops local dirt', () => {
    const h = harness({ initiallyDirty: true });
    expect(h.engine.isDirty()).toBe(true);
    h.engine.adoptRev(42);
    expect(h.engine.rev()).toBe(42);
    expect(h.engine.isDirty()).toBe(false);
  });
});
