import {
  parseBoardDocument,
  safeParseBoardDocument,
  type BoardDocument,
} from '@seed/shared/board-contract';

export const BOARD_RECOVERY_FORMAT = 1 as const;
const MAX_BOARD_REV = Number.MAX_SAFE_INTEGER - 1;
const RECOVERY_CLIENT_KEY = 'seed.board.recovery.client';

export type BoardRecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface BoardRecoverySnapshot {
  formatVersion: typeof BOARD_RECOVERY_FORMAT;
  boardId: string;
  clientId: string;
  title: string;
  expectedRev: number;
  serverRev?: number;
  savedAt: number;
  state: BoardDocument;
}

export type BoardSaveOutcome =
  | { kind: 'saved'; rev: number }
  | { kind: 'conflict'; rev: number }
  | {
      kind: 'failed';
      error?: 'state_too_large' | 'rate_limited';
      retryAfterMs?: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBoardRevision(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_BOARD_REV
  );
}

export function boardRevision(state: unknown): number {
  if (!isRecord(state)) return 0;
  return isBoardRevision(state.__rev) ? state.__rev : 0;
}

/** A recovery payload never gets to choose the persisted revision. */
export function withoutBoardRevision(state: unknown): BoardDocument {
  const parsed = parseBoardDocument(state);
  const { __rev: _ignored, ...document } = parsed;
  return document;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

/** Compare user content while deliberately ignoring the server-owned revision. */
export function sameBoardDocument(left: unknown, right: unknown): boolean {
  try {
    return (
      JSON.stringify(canonicalize(withoutBoardRevision(left))) ===
      JSON.stringify(canonicalize(withoutBoardRevision(right)))
    );
  } catch {
    return false;
  }
}

export function boardRecoveryKey(boardId: string): string {
  return `seed.board.recovery.${boardId}`;
}

function isClientId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

/** Stable for a tab (sessionStorage), distinct across concurrent tabs. */
export function getBoardRecoveryClientId(storage: BoardRecoveryStorage): string {
  try {
    const existing = storage.getItem(RECOVERY_CLIENT_KEY);
    if (isClientId(existing)) return existing;
  } catch {
    // Fall through to an in-memory id when session storage is disabled.
  }
  const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    storage.setItem(RECOVERY_CLIENT_KEY, generated);
  } catch {
    // The caller still keeps this id for the lifetime of the mounted editor.
  }
  return generated;
}

export function createBoardRecoverySnapshot(input: {
  boardId: string;
  clientId: string;
  title: string;
  expectedRev: number;
  serverRev?: number;
  savedAt?: number;
  state: unknown;
}): BoardRecoverySnapshot {
  if (!input.boardId || !isClientId(input.clientId) || !isBoardRevision(input.expectedRev)) {
    throw new Error('invalid_board_recovery');
  }
  if (input.serverRev !== undefined && !isBoardRevision(input.serverRev)) {
    throw new Error('invalid_board_recovery');
  }
  return {
    formatVersion: BOARD_RECOVERY_FORMAT,
    boardId: input.boardId,
    clientId: input.clientId,
    title: input.title,
    expectedRev: input.expectedRev,
    ...(input.serverRev !== undefined ? { serverRev: input.serverRev } : {}),
    savedAt: input.savedAt ?? Date.now(),
    state: withoutBoardRevision(input.state),
  };
}

/**
 * Fast path for the editor's already-validated in-memory BoardDocument. Reads
 * still validate every stored snapshot; this avoids reparsing the full graph on
 * every pointer edit before writing the durable recovery envelope.
 */
export function createBoardRecoverySnapshotFromDocument(input: {
  boardId: string;
  clientId: string;
  title: string;
  expectedRev: number;
  serverRev?: number;
  savedAt?: number;
  state: BoardDocument;
}): BoardRecoverySnapshot {
  if (!input.boardId || !isClientId(input.clientId) || !isBoardRevision(input.expectedRev)) {
    throw new Error('invalid_board_recovery');
  }
  if (input.serverRev !== undefined && !isBoardRevision(input.serverRev)) {
    throw new Error('invalid_board_recovery');
  }
  const { __rev: _ignored, ...state } = input.state;
  return {
    formatVersion: BOARD_RECOVERY_FORMAT,
    boardId: input.boardId,
    clientId: input.clientId,
    title: input.title,
    expectedRev: input.expectedRev,
    ...(input.serverRev !== undefined ? { serverRev: input.serverRev } : {}),
    savedAt: input.savedAt ?? Date.now(),
    state,
  };
}

function recoverySnapshotsForWrite(raw: string | null, boardId: string): Record<string, unknown> {
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.formatVersion !== BOARD_RECOVERY_FORMAT ||
    value.boardId !== boardId ||
    !isRecord(value.snapshots)
  ) {
    return {};
  }
  // Do not perform a second full graph validation just to merge this tab's
  // record. readBoardRecovery remains the strict trust boundary.
  return value.snapshots;
}

export function writeBoardRecovery(
  storage: BoardRecoveryStorage,
  snapshot: BoardRecoverySnapshot,
): boolean {
  try {
    const key = boardRecoveryKey(snapshot.boardId);
    const existing = recoverySnapshotsForWrite(storage.getItem(key), snapshot.boardId);
    storage.setItem(
      key,
      JSON.stringify({
        formatVersion: BOARD_RECOVERY_FORMAT,
        boardId: snapshot.boardId,
        snapshots: { ...existing, [snapshot.clientId]: snapshot },
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearBoardRecovery(
  storage: BoardRecoveryStorage,
  boardId: string,
  clientId?: string,
): void {
  try {
    const key = boardRecoveryKey(boardId);
    if (!clientId) {
      storage.removeItem(key);
      return;
    }
    const snapshots = decodeRecoveryEnvelope(storage.getItem(key), boardId);
    delete snapshots[clientId];
    if (Object.keys(snapshots).length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(
        key,
        JSON.stringify({ formatVersion: BOARD_RECOVERY_FORMAT, boardId, snapshots }),
      );
    }
  } catch {
    // Saving to the server remains valid even when browser storage is unavailable.
  }
}

function parseRecoverySnapshot(value: unknown, boardId: string): BoardRecoverySnapshot | null {
  if (
    !isRecord(value) ||
    value.formatVersion !== BOARD_RECOVERY_FORMAT ||
    value.boardId !== boardId ||
    !isClientId(value.clientId) ||
    typeof value.title !== 'string' ||
    !isBoardRevision(value.expectedRev) ||
    (value.serverRev !== undefined && !isBoardRevision(value.serverRev)) ||
    typeof value.savedAt !== 'number' ||
    !Number.isFinite(value.savedAt)
  ) {
    return null;
  }
  const state = safeParseBoardDocument(value.state);
  if (!state.success) return null;
  return createBoardRecoverySnapshot({
    boardId,
    clientId: value.clientId,
    title: value.title,
    expectedRev: value.expectedRev,
    ...(value.serverRev !== undefined ? { serverRev: value.serverRev } : {}),
    savedAt: value.savedAt,
    state: state.data,
  });
}

function decodeRecoveryEnvelope(
  raw: string | null,
  boardId: string,
): Record<string, BoardRecoverySnapshot> {
  if (!raw) return {};
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.formatVersion !== BOARD_RECOVERY_FORMAT ||
    value.boardId !== boardId ||
    !isRecord(value.snapshots)
  ) {
    return {};
  }
  const snapshots: Record<string, BoardRecoverySnapshot> = {};
  for (const candidate of Object.values(value.snapshots)) {
    const parsed = parseRecoverySnapshot(candidate, boardId);
    if (parsed) snapshots[parsed.clientId] = parsed;
  }
  return snapshots;
}

export function readBoardRecovery(
  storage: BoardRecoveryStorage,
  boardId: string,
  preferredClientId?: string,
): BoardRecoverySnapshot | null {
  try {
    const key = boardRecoveryKey(boardId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const snapshots = decodeRecoveryEnvelope(raw, boardId);
    const candidates = Object.values(snapshots);
    if (candidates.length === 0) {
      clearBoardRecovery(storage, boardId);
      return null;
    }
    if (preferredClientId && snapshots[preferredClientId]) return snapshots[preferredClientId];
    return candidates.sort((left, right) => right.savedAt - left.savedAt)[0] ?? null;
  } catch {
    clearBoardRecovery(storage, boardId);
    return null;
  }
}

/** Strictly classify the API response: a vague 2xx is not proof of persistence. */
export function classifyBoardSaveResponse(status: number, body: unknown): BoardSaveOutcome {
  if (!isRecord(body)) return { kind: 'failed' };
  if (status === 400 && body.error === 'state_too_large') {
    return { kind: 'failed', error: 'state_too_large' };
  }
  if (status === 429 && body.error === 'rate_limited') {
    const retryAfterSeconds =
      typeof body.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)
        ? Math.max(1, body.retryAfterSeconds)
        : undefined;
    return {
      kind: 'failed',
      error: 'rate_limited',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterMs: retryAfterSeconds * 1_000 }),
    };
  }
  if (status === 409 && body.error === 'rev_conflict' && isBoardRevision(body.rev)) {
    return { kind: 'conflict', rev: body.rev };
  }
  if (status >= 200 && status < 300 && body.ok === true && isBoardRevision(body.rev)) {
    return { kind: 'saved', rev: body.rev };
  }
  return { kind: 'failed' };
}
