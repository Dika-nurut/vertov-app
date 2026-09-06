export const STUDIO_RECOVERY_FORMAT = 1 as const;
export const STUDIO_PROJECT_MAX_BYTES = 262_144;

export type StudioRecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface StudioRecoverySnapshot {
  formatVersion: typeof STUDIO_RECOVERY_FORMAT;
  ownerId: string;
  studioProjectId: string;
  rev: number;
  savedAt: number;
  timeline: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validScopePart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function studioRecoveryKey(ownerId: string, studioProjectId: string): string {
  return `seed.studio.recovery.${encodeURIComponent(ownerId)}.${encodeURIComponent(studioProjectId)}`;
}

export function studioRevision(timeline: unknown): number {
  return isRecord(timeline) && isRevision(timeline.__rev) ? timeline.__rev : 0;
}

function withoutRevision(timeline: Record<string, unknown>): Record<string, unknown> {
  const { __rev: _ignored, ...content } = timeline;
  return content;
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

export function sameStudioTimeline(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  return (
    JSON.stringify(canonicalize(withoutRevision(left))) ===
    JSON.stringify(canonicalize(withoutRevision(right)))
  );
}

export function createStudioRecovery(input: {
  ownerId: string;
  studioProjectId: string;
  rev: number;
  timeline: unknown;
  savedAt?: number;
}): StudioRecoverySnapshot {
  if (
    !validScopePart(input.ownerId) ||
    !validScopePart(input.studioProjectId) ||
    !isRevision(input.rev) ||
    !isRecord(input.timeline)
  ) {
    throw new Error('invalid_studio_recovery');
  }
  const timeline = withoutRevision(input.timeline);
  if (JSON.stringify(timeline).length > STUDIO_PROJECT_MAX_BYTES) {
    throw new Error('invalid_studio_recovery');
  }
  return {
    formatVersion: STUDIO_RECOVERY_FORMAT,
    ownerId: input.ownerId,
    studioProjectId: input.studioProjectId,
    rev: input.rev,
    savedAt: input.savedAt ?? Date.now(),
    timeline,
  };
}

export function writeStudioRecovery(
  storage: StudioRecoveryStorage,
  snapshot: StudioRecoverySnapshot,
): boolean {
  try {
    storage.setItem(
      studioRecoveryKey(snapshot.ownerId, snapshot.studioProjectId),
      JSON.stringify(snapshot),
    );
    return true;
  } catch {
    return false;
  }
}

export function readStudioRecovery(
  storage: StudioRecoveryStorage,
  ownerId: string,
  studioProjectId: string,
): StudioRecoverySnapshot | null {
  const key = studioRecoveryKey(ownerId, studioProjectId);
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value.formatVersion !== STUDIO_RECOVERY_FORMAT ||
      value.ownerId !== ownerId ||
      (value.studioProjectId ?? value.projectId) !== studioProjectId ||
      !isRevision(value.rev) ||
      typeof value.savedAt !== 'number' ||
      !Number.isFinite(value.savedAt) ||
      !isRecord(value.timeline)
    ) {
      storage.removeItem(key);
      return null;
    }
    return createStudioRecovery({
      ownerId,
      studioProjectId,
      rev: value.rev,
      savedAt: value.savedAt,
      timeline: value.timeline,
    });
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Browser storage may be disabled; server persistence still works.
    }
    return null;
  }
}

/** Clear only the draft confirmed by the server, never a newer in-memory edit. */
export function clearStudioRecoveryThrough(
  storage: StudioRecoveryStorage,
  ownerId: string,
  studioProjectId: string,
  persistedRev: number,
): void {
  const snapshot = readStudioRecovery(storage, ownerId, studioProjectId);
  if (!snapshot || snapshot.rev > persistedRev) return;
  try {
    storage.removeItem(studioRecoveryKey(ownerId, studioProjectId));
  } catch {
    // A retained recovery record is safe; it is content-compared on the next load.
  }
}

export function chooseStudioTimeline(
  serverTimeline: unknown,
  recovery: StudioRecoverySnapshot | null,
): { timeline: Record<string, unknown> | null; rev: number; recovered: boolean } {
  const server = isRecord(serverTimeline) ? serverTimeline : null;
  const serverRev = studioRevision(server);
  if (
    recovery &&
    recovery.rev >= serverRev &&
    (!server || !sameStudioTimeline(server, recovery.timeline))
  ) {
    return { timeline: recovery.timeline, rev: recovery.rev, recovered: true };
  }
  return { timeline: server, rev: serverRev, recovered: false };
}
