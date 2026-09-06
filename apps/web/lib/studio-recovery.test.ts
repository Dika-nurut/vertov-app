import { describe, expect, it } from 'vitest';
import {
  chooseStudioTimeline,
  clearStudioRecoveryThrough,
  createStudioRecovery,
  readStudioRecovery,
  sameStudioTimeline,
  studioRecoveryKey,
  writeStudioRecovery,
  type StudioRecoveryStorage,
} from './studio-recovery';

function memoryStorage(): StudioRecoveryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

const timeline = {
  schemaVersion: 2,
  tracks: [{ id: 'base', kind: 'video', clips: [{ uid: 'clip-1', url: '/one.mp4' }] }],
  texts: [],
  __rev: 4,
};

describe('Studio local recovery', () => {
  it('round-trips a user/project-scoped draft without trusting its embedded revision', () => {
    const storage = memoryStorage();
    const snapshot = createStudioRecovery({
      ownerId: 'user-a',
      studioProjectId: 'scratch',
      rev: 5,
      savedAt: 123,
      timeline,
    });
    expect(snapshot.timeline).not.toHaveProperty('__rev');
    expect(writeStudioRecovery(storage, snapshot)).toBe(true);
    expect(readStudioRecovery(storage, 'user-a', 'scratch')).toEqual(snapshot);
    expect(readStudioRecovery(storage, 'user-b', 'scratch')).toBeNull();
  });

  it('recovers newer or conflicting equal-revision content, but not stale content', () => {
    const local = createStudioRecovery({
      ownerId: 'user-a',
      studioProjectId: 'scratch',
      rev: 5,
      timeline: { ...timeline, tracks: [{ id: 'base', clips: [] }] },
    });
    expect(chooseStudioTimeline(timeline, local)).toMatchObject({ recovered: true, rev: 5 });
    expect(chooseStudioTimeline({ ...timeline, __rev: 6 }, local)).toMatchObject({
      recovered: false,
      rev: 6,
    });
    expect(
      chooseStudioTimeline({ ...timeline, __rev: 5 }, { ...local, timeline: local.timeline }),
    ).toMatchObject({ recovered: true });
  });

  it('ignores revision and key order when content already reached the server', () => {
    const reordered = {
      __rev: 99,
      texts: [],
      tracks: timeline.tracks,
      schemaVersion: 2,
    };
    expect(sameStudioTimeline(timeline, reordered)).toBe(true);
  });

  it('clears only through the confirmed revision and preserves a newer edit', () => {
    const storage = memoryStorage();
    const snapshot = createStudioRecovery({
      ownerId: 'user-a',
      studioProjectId: 'project-1',
      rev: 8,
      timeline,
    });
    writeStudioRecovery(storage, snapshot);
    clearStudioRecoveryThrough(storage, 'user-a', 'project-1', 7);
    expect(readStudioRecovery(storage, 'user-a', 'project-1')).not.toBeNull();
    clearStudioRecoveryThrough(storage, 'user-a', 'project-1', 8);
    expect(storage.getItem(studioRecoveryKey('user-a', 'project-1'))).toBeNull();
  });

  it('rejects corrupt, oversized, and unavailable browser storage safely', () => {
    const storage = memoryStorage();
    storage.setItem(studioRecoveryKey('user-a', 'scratch'), '{bad json');
    expect(readStudioRecovery(storage, 'user-a', 'scratch')).toBeNull();
    expect(() =>
      createStudioRecovery({
        ownerId: 'user-a',
        studioProjectId: 'scratch',
        rev: 1,
        timeline: { value: 'x'.repeat(262_145) },
      }),
    ).toThrow('invalid_studio_recovery');
    const broken: StudioRecoveryStorage = {
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
    expect(
      writeStudioRecovery(
        broken,
        createStudioRecovery({
          ownerId: 'user-a',
          studioProjectId: 'scratch',
          rev: 1,
          timeline: {},
        }),
      ),
    ).toBe(false);
    expect(readStudioRecovery(broken, 'user-a', 'scratch')).toBeNull();
  });
});
