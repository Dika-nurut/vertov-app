import { describe, expect, it } from 'vitest';
import { mergePresetPrompt, unfilledRequiredSlots, type PresetPromptSpec } from './preset-merge';

describe('mergePresetPrompt — legacy backward-compat (must not change existing packs)', () => {
  it('replace mode reproduces the scene-pack behavior: preset IS the prompt', () => {
    // A real scene pack from seed/preset-packs.ts (vk-avatar).
    const spec: PresetPromptSpec = {
      promptTemplate:
        'Portrait of a young person, vivid background, square frame, social network avatar style, high quality',
      mergeMode: 'replace',
    };
    expect(mergePresetPrompt(spec, 'ignored user text')).toBe(
      'Portrait of a young person, vivid background, square frame, social network avatar style, high quality',
    );
  });

  it('a pack with no mergeMode defaults to replace (legacy rows have no column value → default)', () => {
    const spec: PresetPromptSpec = { promptTemplate: 'a fixed prompt' };
    expect(mergePresetPrompt(spec, 'whatever')).toBe('a fixed prompt');
  });

  it('suffix mode reproduces the motion-pack behavior: user subject then camera phrase', () => {
    // crash-zoom motion pack: today the template is appended after the user prompt.
    const spec: PresetPromptSpec = {
      promptTemplate:
        'Rapid crash zoom toward the subject, dramatic acceleration, slight motion blur, cinematic high-energy shot',
      mergeMode: 'suffix',
    };
    expect(mergePresetPrompt(spec, 'a woman in a red dress')).toBe(
      'a woman in a red dress, Rapid crash zoom toward the subject, dramatic acceleration, slight motion blur, cinematic high-energy shot',
    );
  });

  it('suffix mode with empty user text falls back to just the template', () => {
    const spec: PresetPromptSpec = { promptTemplate: 'orbit around subject', mergeMode: 'suffix' };
    expect(mergePresetPrompt(spec, '   ')).toBe('orbit around subject');
  });
});

describe('mergePresetPrompt — prefix mode (style scaffold leads)', () => {
  it('puts the style scaffold before the user subject', () => {
    const spec: PresetPromptSpec = {
      promptTemplate: 'cinematic film still, teal and orange grade, 35mm film grain',
      mergeMode: 'prefix',
    };
    expect(mergePresetPrompt(spec, 'a lone detective in an alley')).toBe(
      'cinematic film still, teal and orange grade, 35mm film grain, a lone detective in an alley',
    );
  });
});

describe('mergePresetPrompt — slots mode (the new Higgsfield mechanic)', () => {
  const cinematic: PresetPromptSpec = {
    mergeMode: 'slots',
    promptTemplate:
      'cinematic film still of {subject}, {action}, in {environment}, teal and orange grade, film grain',
    slots: [
      { key: 'subject', label: 'Subject', required: true },
      { key: 'action', label: 'Action', default: 'standing still' },
      { key: 'environment', label: 'Environment', required: true },
    ],
  };

  it('substitutes provided slot values', () => {
    expect(
      mergePresetPrompt(cinematic, '', {
        subject: 'a detective',
        action: 'lighting a cigarette',
        environment: 'a rain-soaked alley',
      }),
    ).toBe(
      'cinematic film still of a detective, lighting a cigarette, in a rain-soaked alley, teal and orange grade, film grain',
    );
  });

  it('falls back to a slot default when the value is missing', () => {
    expect(
      mergePresetPrompt(cinematic, '', {
        subject: 'a detective',
        environment: 'an alley',
      }),
    ).toBe(
      'cinematic film still of a detective, standing still, in an alley, teal and orange grade, film grain',
    );
  });

  it('single-slot preset drops the whole raw user prompt into the slot', () => {
    const spec: PresetPromptSpec = {
      mergeMode: 'slots',
      promptTemplate: 'anime illustration of {subject}, vibrant cel shading, clean lineart',
      slots: [{ key: 'subject', label: 'Subject', required: true }],
    };
    expect(mergePresetPrompt(spec, 'a girl with blue hair on a train')).toBe(
      'anime illustration of a girl with blue hair on a train, vibrant cel shading, clean lineart',
    );
  });

  it('explicit slot value beats the single-slot user-text convenience', () => {
    const spec: PresetPromptSpec = {
      mergeMode: 'slots',
      promptTemplate: 'portrait of {subject}',
      slots: [{ key: 'subject', label: 'Subject', required: true }],
    };
    expect(mergePresetPrompt(spec, 'ignored', { subject: 'a knight' })).toBe(
      'portrait of a knight',
    );
  });

  it('tidies orphaned commas/spaces left by an unfilled non-required slot', () => {
    // {action} empty and not required, no default → the ", ," must not survive.
    const spec: PresetPromptSpec = {
      mergeMode: 'slots',
      promptTemplate: 'photo of {subject}, {action}, in {environment}',
      slots: [
        { key: 'subject', label: 'Subject', required: true },
        { key: 'action', label: 'Action' },
        { key: 'environment', label: 'Environment', required: true },
      ],
    };
    expect(mergePresetPrompt(spec, '', { subject: 'a cat', environment: 'a garden' })).toBe(
      'photo of a cat, in a garden',
    );
  });
});

describe('unfilledRequiredSlots — pre-submit guard', () => {
  const spec: PresetPromptSpec = {
    mergeMode: 'slots',
    promptTemplate: 'a {subject} in {environment}',
    slots: [
      { key: 'subject', label: 'Subject', required: true },
      { key: 'environment', label: 'Environment', required: true },
    ],
  };

  it('reports every unfilled required slot', () => {
    expect(unfilledRequiredSlots(spec, '', {})).toEqual(['subject', 'environment']);
  });

  it('passes once required slots are filled', () => {
    expect(unfilledRequiredSlots(spec, '', { subject: 'dog', environment: 'park' })).toEqual([]);
  });

  it('non-slots modes never block submit', () => {
    expect(unfilledRequiredSlots({ promptTemplate: 'x', mergeMode: 'replace' })).toEqual([]);
    expect(unfilledRequiredSlots({ promptTemplate: 'x', mergeMode: 'suffix' }, '')).toEqual([]);
  });

  it('single required slot is satisfied by raw user text', () => {
    const one: PresetPromptSpec = {
      mergeMode: 'slots',
      promptTemplate: 'anime {subject}',
      slots: [{ key: 'subject', label: 'Subject', required: true }],
    };
    expect(unfilledRequiredSlots(one, 'a robot')).toEqual([]);
    expect(unfilledRequiredSlots(one, '')).toEqual(['subject']);
  });
});
