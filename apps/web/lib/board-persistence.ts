import { BOARD_LIMITS, type BoardDocument } from '@seed/shared/board-contract';
import { computeBackoffMs } from './autosave';
import { classifyBoardSaveResponse, type BoardSaveOutcome } from './board-recovery';

export type BoardFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface PutBoardDocumentInput {
  apiUrl: string;
  boardId: string;
  state: BoardDocument;
  expectedRev: number;
  fetchImpl?: BoardFetch;
  wait?: (milliseconds: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * One serialized optimistic-concurrency save. Every retry carries the exact
 * same document and expected base; only transient/network failures retry.
 * Conflicts and malformed success responses return immediately for the caller's
 * explicit recovery UI.
 */
export async function putBoardDocument({
  apiUrl,
  boardId,
  state,
  expectedRev,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxRetries = 4,
}: PutBoardDocumentInput): Promise<BoardSaveOutcome> {
  const serializedState = JSON.stringify(state);
  if (new TextEncoder().encode(serializedState).byteLength > BOARD_LIMITS.stateBytes) {
    return { kind: 'failed', error: 'state_too_large' };
  }
  const requestBody = JSON.stringify({ state, rev: expectedRev });
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(`${apiUrl}/v1/boards/${boardId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      // The board autosave engine owns the 429 backoff and user notice. Return
      // the structured response immediately so a rate-limited request cannot
      // hide four retries inside one debounce cycle; only opaque server errors
      // are retried here.
      if (response.status >= 500 && attempt < maxRetries) {
        await wait(computeBackoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }
      const body: unknown = await response.json().catch(() => null);
      return classifyBoardSaveResponse(response.status, body);
    } catch {
      if (attempt < maxRetries) {
        await wait(computeBackoffMs(attempt, null));
        continue;
      }
      return { kind: 'failed' };
    }
  }
}
