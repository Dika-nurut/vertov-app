import { describe, expect, it } from 'vitest';
import { MEDIA_TITLE_MAX_LENGTH, generatedMediaTitle, mediaDisplayTitle } from './media-title';

describe('generatedMediaTitle', () => {
  it('normalizes Cyrillic prompt whitespace and distinguishes sibling outputs', () => {
    expect(
      generatedMediaTitle({
        prompt: '  Девушка\n\nна берегу\tморя  ',
        kind: 'image',
        outputIndex: 2,
        outputCount: 3,
      }),
    ).toBe('Девушка на берегу моря · 2 из 3');
  });

  it('bounds long prompts while preserving the readable output ordinal', () => {
    const title = generatedMediaTitle({
      prompt: 'очень '.repeat(100),
      kind: 'video',
      outputIndex: 12,
      outputCount: 12,
    });
    expect(Array.from(title).length).toBeLessThanOrEqual(MEDIA_TITLE_MAX_LENGTH);
    expect(title).toMatch(/… · 12 из 12$/);
  });

  it('uses a useful kind-specific fallback for an empty prompt', () => {
    expect(generatedMediaTitle({ prompt: ' \n ', kind: 'video' })).toBe('Сгенерированное видео');
  });
});

describe('mediaDisplayTitle', () => {
  it('normalizes title and filename and avoids an internal-id fallback', () => {
    expect(mediaDisplayTitle({ title: '  Мой\nкадр ', originalName: 'old.png' })).toBe('Мой кадр');
    expect(mediaDisplayTitle({ title: ' ', originalName: ' upload.png ' })).toBe('upload.png');
    expect(mediaDisplayTitle({})).toBe('Материал без названия');
  });
});
