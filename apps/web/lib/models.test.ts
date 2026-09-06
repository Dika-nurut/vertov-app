import { describe, it, expect } from 'vitest';
import { modelDisplayName, modelDisplayNameFromId } from './models';

describe('modelDisplayName', () => {
  it('renders known ByteDance families with canonical capitalisation', () => {
    expect(modelDisplayName({ family: 'seedream', variant: '4.0' })).toBe('Seedream 4.0');
    expect(modelDisplayName({ family: 'seedance', variant: '2.0' })).toBe('Seedance 2.0');
    expect(modelDisplayName({ family: 'seedtts', variant: '1.0' })).toBe('Seed-TTS 1.0');
    expect(modelDisplayName({ family: 'doubao', variant: 'voice-v1' })).toBe('Doubao Voice V1');
  });

  it('uses a catalogue display name when present', () => {
    expect(
      modelDisplayName({ family: 'Nano Banana', variant: '3 Pro', displayName: 'Nano Banana Pro' }),
    ).toBe('Nano Banana Pro');
    expect(modelDisplayName({ family: 'Nano Banana', variant: '3 Pro' })).toBe('Nano Banana 3 Pro');
  });

  it('joins dashed variants with the right separators', () => {
    expect(modelDisplayName({ family: 'seedance', variant: '1-0-pro-fast' })).toBe(
      'Seedance 1.0 Pro Fast',
    );
  });

  it('falls back to capitalisation for unknown families', () => {
    expect(modelDisplayName({ family: 'midjourney', variant: '6' })).toBe('Midjourney 6');
  });

  it('handles missing variant', () => {
    expect(modelDisplayName({ family: 'seedream', variant: '' })).toBe('Seedream');
  });

  it('returns an em-dash for fully empty input', () => {
    expect(modelDisplayName({ family: '', variant: '' })).toBe('—');
  });
});

describe('modelDisplayNameFromId', () => {
  it('handles simple slugs', () => {
    expect(modelDisplayNameFromId('seedream-4-5')).toBe('Seedream 4.5');
    expect(modelDisplayNameFromId('seedance-2-0')).toBe('Seedance 2.0');
    expect(modelDisplayNameFromId('gemini-3-pro-image')).toBe('Gemini 3 Pro Image');
  });

  it('handles compound variants with alpha tokens', () => {
    expect(modelDisplayNameFromId('seedance-1-0-pro-fast')).toBe('Seedance 1.0 Pro Fast');
    expect(modelDisplayNameFromId('seedream-5-0-lite')).toBe('Seedream 5.0 Lite');
  });

  it('returns the family label when only the family is present', () => {
    expect(modelDisplayNameFromId('seedream')).toBe('Seedream');
  });

  it('returns em-dash for empty input', () => {
    expect(modelDisplayNameFromId('')).toBe('—');
  });
});
