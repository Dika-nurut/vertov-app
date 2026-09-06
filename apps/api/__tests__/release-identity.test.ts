import { describe, expect, it } from 'vitest';
import { releaseCommit } from '../src/release-identity';

describe('release identity', () => {
  it('returns the immutable build SHA when present', () => {
    expect(releaseCommit({ SEED_COMMIT_SHA: ' ef2ecf76 ' })).toBe('ef2ecf76');
  });

  it('fails closed for local images without a build identity', () => {
    expect(releaseCommit({})).toBeNull();
    expect(releaseCommit({ SEED_COMMIT_SHA: '   ' })).toBeNull();
  });
});
