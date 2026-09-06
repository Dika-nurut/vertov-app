import { describe, expect, it } from 'vitest';
import { pickSignedRung } from './board-contract';

describe('pickSignedRung', () => {
  it('honors a saved pick when the model offers it', () => {
    expect(pickSignedRung(['1K', '2K'], { default_resolution: '1K' }, '2K', '1K')).toBe('2K');
  });

  it('uses the signed default when the saved pick is absent or unsupported', () => {
    expect(pickSignedRung(['1K', '2K'], { default_resolution: '1K' }, null, '2K')).toBe('1K');
    expect(pickSignedRung(['1K', '2K'], { default_resolution: '1K' }, '4K', '2K')).toBe('1K');
  });

  it('falls through to the offered legacy default and then the first rung', () => {
    expect(pickSignedRung(['480p', '720p'], {}, null, '720p')).toBe('720p');
    expect(pickSignedRung(['480p', '720p'], {}, null, '1080p')).toBe('480p');
  });

  it('returns no rung for an empty offered list', () => {
    expect(pickSignedRung([], { default_resolution: '1K' }, null, '2K')).toBeUndefined();
  });
});
