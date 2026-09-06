import { describe, expect, it } from 'vitest';
import {
  boardRecoveryKey,
  boardRevision,
  classifyBoardSaveResponse,
  clearBoardRecovery,
  createBoardRecoverySnapshot,
  createBoardRecoverySnapshotFromDocument,
  getBoardRecoveryClientId,
  readBoardRecovery,
  sameBoardDocument,
  withoutBoardRevision,
  writeBoardRecovery,
  type BoardRecoveryStorage,
} from './board-recovery';

function memoryStorage(): BoardRecoveryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const state = {
  schemaVersion: 1,
  nodes: [
    { id: 'note', version: 1, type: 'note', position: { x: 1, y: 2 }, data: { text: 'local' } },
  ],
  edges: [],
  tray: [],
  __rev: 7,
};

describe('Board local recovery', () => {
  it('round-trips a validated snapshot without a client-owned __rev', () => {
    const storage = memoryStorage();
    const snapshot = createBoardRecoverySnapshot({
      boardId: 'board-1',
      clientId: 'tab-a',
      title: 'Recovered Board',
      expectedRev: 7,
      serverRev: 8,
      savedAt: 123,
      state,
    });

    expect(snapshot.state).not.toHaveProperty('__rev');
    expect(writeBoardRecovery(storage, snapshot)).toBe(true);
    expect(readBoardRecovery(storage, 'board-1', 'tab-a')).toEqual(snapshot);
    clearBoardRecovery(storage, 'board-1', 'tab-a');
    expect(storage.getItem(boardRecoveryKey('board-1'))).toBeNull();
  });

  it('writes an already-validated editor document without reparsing it', () => {
    const storage = memoryStorage();
    const snapshot = createBoardRecoverySnapshotFromDocument({
      boardId: 'board-1',
      clientId: 'tab-fast',
      title: 'Fast path',
      expectedRev: 7,
      savedAt: 124,
      state: withoutBoardRevision(state),
    });
    expect(writeBoardRecovery(storage, snapshot)).toBe(true);
    expect(readBoardRecovery(storage, 'board-1', 'tab-fast')).toEqual(snapshot);
  });

  it('rejects corrupt, foreign, and future recovery records', () => {
    const storage = memoryStorage();
    for (const value of [
      '{bad json',
      JSON.stringify({ formatVersion: 2, boardId: 'board-1' }),
      JSON.stringify({
        formatVersion: 1,
        boardId: 'board-1',
        snapshots: {
          wrong: {
            formatVersion: 1,
            boardId: 'another-board',
            clientId: 'wrong',
            title: 'Wrong',
            expectedRev: 0,
            savedAt: 1,
            state: {},
          },
        },
      }),
    ]) {
      storage.setItem(boardRecoveryKey('board-1'), value);
      expect(readBoardRecovery(storage, 'board-1')).toBeNull();
      expect(storage.getItem(boardRecoveryKey('board-1'))).toBeNull();
    }
  });

  it('keeps concurrent tabs isolated and clears only the successful writer', () => {
    const storage = memoryStorage();
    const left = createBoardRecoverySnapshot({
      boardId: 'board-1',
      clientId: 'tab-left',
      title: 'Left',
      expectedRev: 0,
      savedAt: 1,
      state,
    });
    const right = createBoardRecoverySnapshot({
      boardId: 'board-1',
      clientId: 'tab-right',
      title: 'Right',
      expectedRev: 0,
      savedAt: 2,
      state: { ...state, nodes: [{ ...state.nodes[0], data: { text: 'right' } }] },
    });
    expect(writeBoardRecovery(storage, left)).toBe(true);
    expect(writeBoardRecovery(storage, right)).toBe(true);
    clearBoardRecovery(storage, 'board-1', 'tab-left');
    expect(readBoardRecovery(storage, 'board-1', 'tab-right')).toEqual(right);
    expect(storage.getItem(boardRecoveryKey('board-1'))).not.toBeNull();

    const session = memoryStorage();
    expect(getBoardRecoveryClientId(session)).toBe(getBoardRecoveryClientId(session));
  });

  it('compares normalized user content while ignoring revision and key order', () => {
    const reordered = {
      __rev: 99,
      tray: [],
      edges: [],
      nodes: state.nodes,
      schemaVersion: 1,
    };
    expect(sameBoardDocument(state, reordered)).toBe(true);
    expect(
      sameBoardDocument(state, {
        ...reordered,
        nodes: [{ ...state.nodes[0], data: { text: 'server' } }],
      }),
    ).toBe(false);
    expect(withoutBoardRevision(state)).not.toHaveProperty('__rev');
    expect(boardRevision(state)).toBe(7);
    expect(boardRevision({ __rev: 0.5 })).toBe(0);
  });

  it('fails closed when browser storage is unavailable', () => {
    const broken: BoardRecoveryStorage = {
      getItem: () => {
        throw new Error('disabled');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('disabled');
      },
    };
    const snapshot = createBoardRecoverySnapshot({
      boardId: 'board-1',
      clientId: 'tab-a',
      title: 'Local',
      expectedRev: 0,
      state: {},
    });
    expect(writeBoardRecovery(broken, snapshot)).toBe(false);
    expect(readBoardRecovery(broken, 'board-1')).toBeNull();
  });
});

describe('Board save response contract', () => {
  it('accepts only a confirmed revision or a structured conflict', () => {
    expect(classifyBoardSaveResponse(200, { ok: true, rev: 4 })).toEqual({
      kind: 'saved',
      rev: 4,
    });
    expect(classifyBoardSaveResponse(409, { error: 'rev_conflict', rev: 5 })).toEqual({
      kind: 'conflict',
      rev: 5,
    });
    expect(classifyBoardSaveResponse(400, { error: 'state_too_large' })).toEqual({
      kind: 'failed',
      error: 'state_too_large',
    });
    expect(classifyBoardSaveResponse(429, { error: 'rate_limited', retryAfterSeconds: 3 })).toEqual(
      {
        kind: 'failed',
        error: 'rate_limited',
        retryAfterMs: 3_000,
      },
    );
    for (const [status, body] of [
      [200, { ok: true }],
      [200, { ok: true, skipped: true }],
      [409, { error: 'rev_conflict' }],
      [500, { rev: 5 }],
    ] as const) {
      expect(classifyBoardSaveResponse(status, body)).toEqual({ kind: 'failed' });
    }
  });
});
