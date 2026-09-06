import { describe, expect, it, vi } from 'vitest';
import { BOARD_LIMITS, type BoardDocument } from '@seed/shared/board-contract';
import { putBoardDocument, type BoardFetch } from './board-persistence';

const state: BoardDocument = {
  schemaVersion: 1,
  nodes: [],
  edges: [],
  tray: [],
  viewport: { x: 0, y: 0, zoom: 1 },
};

function response(status: number, body: unknown, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('putBoardDocument', () => {
  it('sends the expected base and accepts only the confirmed server revision', async () => {
    const fetchImpl = vi.fn<BoardFetch>().mockResolvedValue(response(200, { ok: true, rev: 8 }));
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state,
        expectedRev: 7,
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: 'saved', rev: 8 });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).toEqual({ state, rev: 7 });
  });

  it('retries the identical snapshot after a transient response', async () => {
    const fetchImpl = vi
      .fn<BoardFetch>()
      .mockResolvedValueOnce(response(503, { error: 'busy' }))
      .mockResolvedValueOnce(response(200, { ok: true, rev: 3 }));
    const wait = vi.fn(async () => undefined);
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state,
        expectedRev: 2,
        fetchImpl,
        wait,
      }),
    ).resolves.toEqual({ kind: 'saved', rev: 3 });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1].body).toBe(fetchImpl.mock.calls[1]![1].body);
  });

  it('returns a revision conflict without retrying', async () => {
    const fetchImpl = vi
      .fn<BoardFetch>()
      .mockResolvedValue(response(409, { error: 'rev_conflict', rev: 11 }));
    const wait = vi.fn(async () => undefined);
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state,
        expectedRev: 9,
        fetchImpl,
        wait,
      }),
    ).resolves.toEqual({ kind: 'conflict', rev: 11 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('returns a rate limit immediately so the autosave engine can own the backoff', async () => {
    const fetchImpl = vi
      .fn<BoardFetch>()
      .mockResolvedValue(
        response(429, { error: 'rate_limited', retryAfterSeconds: 4 }, { 'retry-after': '4' }),
      );
    const wait = vi.fn(async () => undefined);
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state,
        expectedRev: 9,
        fetchImpl,
        wait,
      }),
    ).resolves.toEqual({ kind: 'failed', error: 'rate_limited', retryAfterMs: 4_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('bounds network retries and reports an honest failure', async () => {
    const fetchImpl = vi.fn<BoardFetch>().mockRejectedValue(new Error('offline'));
    const wait = vi.fn(async () => undefined);
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state,
        expectedRev: 0,
        fetchImpl,
        wait,
        maxRetries: 2,
      }),
    ).resolves.toEqual({ kind: 'failed' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized snapshot locally without issuing a request', async () => {
    const fetchImpl = vi.fn<BoardFetch>();
    const oversizedState = {
      ...state,
      nodes: [
        {
          id: 'oversized-note',
          type: 'note',
          version: 1,
          position: { x: 0, y: 0 },
          data: { text: 'x'.repeat(BOARD_LIMITS.stateBytes) },
        },
      ],
    } as BoardDocument;
    await expect(
      putBoardDocument({
        apiUrl: 'http://api',
        boardId: 'board',
        state: oversizedState,
        expectedRev: 0,
        fetchImpl,
      }),
    ).resolves.toEqual({ kind: 'failed', error: 'state_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
