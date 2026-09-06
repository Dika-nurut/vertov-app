import { describe, expect, it } from 'vitest';
import { composeSubmitPrompt, type SubmitPreset } from './preset-submit';

/**
 * Contract test at the /generate submit seam (Phase 0 of the Open-Generative-AI
 * integration). Proves that applying a preset + typing a subject produces the
 * exact final prompt the job carries — the guarantee the feature rests on.
 * DAMP by design: each case reads as a spec, mirroring preset-merge.test.ts.
 */

describe('composeSubmitPrompt — no preset (plain prompting is unchanged)', () => {
  it('returns the user text verbatim when no preset is applied', () => {
    expect(composeSubmitPrompt({ userText: 'a cat on a sofa', preset: null })).toBe(
      'a cat on a sofa',
    );
  });

  it('trims surrounding whitespace like the old inline path did', () => {
    expect(composeSubmitPrompt({ userText: '  a cat on a sofa  ', preset: null })).toBe(
      'a cat on a sofa',
    );
  });
});

describe('composeSubmitPrompt — replace-mode row is byte-identical to today', () => {
  // A replace-mode preset never reaches this seam (it writes straight into the
  // textarea, so `preset` is null and `userText` already holds the template).
  // This asserts that legacy path: the composed prompt IS the textarea text.
  it('a legacy scene pack applied as textarea text submits byte-for-byte', () => {
    const sceneTemplate =
      'Portrait of a young person, vivid background, square frame, social network avatar style, high quality';
    expect(composeSubmitPrompt({ userText: sceneTemplate, preset: null })).toBe(sceneTemplate);
  });
});

describe('composeSubmitPrompt — slots mode (the «Кино» cinema presets)', () => {
  const cinema: SubmitPreset = {
    promptTemplate:
      '{subject}, shot on a grand-format 70mm film camera, aperture f/4, cinematic lighting',
    mergeMode: 'slots',
    slots: [{ key: 'subject', label: 'Что снимаем', required: true }],
    negativePrompt: 'blurry, low quality',
  };

  it('drops the user text into the single {subject} slot (Higgsfield convenience)', () => {
    expect(composeSubmitPrompt({ userText: 'a woman in a red dress', preset: cinema })).toBe(
      'a woman in a red dress, shot on a grand-format 70mm film camera, aperture f/4, cinematic lighting',
    );
  });

  it('an explicit slot fill wins over the raw textarea text', () => {
    expect(
      composeSubmitPrompt({
        userText: 'ignored because the sheet is filled',
        preset: cinema,
        slotValues: { subject: 'a vintage car' },
      }),
    ).toBe(
      'a vintage car, shot on a grand-format 70mm film camera, aperture f/4, cinematic lighting',
    );
  });
});

describe('composeSubmitPrompt — prefix / suffix modes', () => {
  it('prefix mode: the style scaffold leads, user subject trails', () => {
    const style: SubmitPreset = {
      promptTemplate: 'cinematic teal-and-orange grade',
      mergeMode: 'prefix',
    };
    expect(composeSubmitPrompt({ userText: 'a street at night', preset: style })).toBe(
      'cinematic teal-and-orange grade, a street at night',
    );
  });

  it('suffix mode: user subject leads, preset phrase trails', () => {
    const motion: SubmitPreset = {
      promptTemplate: 'slow dolly-in, cinematic',
      mergeMode: 'suffix',
    };
    expect(composeSubmitPrompt({ userText: 'a lighthouse', preset: motion })).toBe(
      'a lighthouse, slow dolly-in, cinematic',
    );
  });
});

describe('composeSubmitPrompt — video effect phrase folds on the end', () => {
  it('appends the effect as its own sentence after a plain prompt', () => {
    expect(
      composeSubmitPrompt({
        userText: 'a knight on a hill',
        preset: null,
        effectPhrase: 'Rapid crash zoom toward the subject',
      }),
    ).toBe('a knight on a hill. Rapid crash zoom toward the subject');
  });

  it('does not double-punctuate when the prompt already ends in a period', () => {
    expect(
      composeSubmitPrompt({
        userText: 'a knight on a hill.',
        preset: null,
        effectPhrase: 'Rapid crash zoom toward the subject',
      }),
    ).toBe('a knight on a hill. Rapid crash zoom toward the subject');
  });

  it('falls back to just the effect phrase when the subject is empty', () => {
    expect(
      composeSubmitPrompt({ userText: '   ', preset: null, effectPhrase: 'orbit around subject' }),
    ).toBe('orbit around subject');
  });

  it('composites a preset AND folds the effect phrase (both mechanisms stack)', () => {
    const style: SubmitPreset = {
      promptTemplate: 'film-grain editorial look',
      mergeMode: 'prefix',
    };
    expect(
      composeSubmitPrompt({
        userText: 'a dancer',
        preset: style,
        effectPhrase: 'slow motion',
      }),
    ).toBe('film-grain editorial look, a dancer. slow motion');
  });
});
