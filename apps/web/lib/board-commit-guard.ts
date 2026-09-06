import { BOARD_LIMITS, parseBoardDocument } from '@seed/shared/board-contract';

/**
 * The last gate before a local board mutation is committed.
 *
 * Autosave writes the parsed document; a command that skips this reports
 * success to the author and then fails silently in the background. The 64-byte
 * reserve is the server-owned `__rev` stamp, which is added after the client
 * has already measured.
 */
export function validateBoardCommit(
  candidate: unknown,
): { ok: true } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = parseBoardDocument(candidate);
  } catch {
    return { ok: false, reason: 'Изменение не прошло проверку борда.' };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (bytes + 64 > BOARD_LIMITS.stateBytes) {
    return { ok: false, reason: 'Борд достиг лимита 1 МиБ — освободите место и повторите.' };
  }
  return { ok: true };
}
