import { describe, expect, it } from 'vitest';
import { resolveGeneratePrompt } from './board-prompt';

describe('resolveGeneratePrompt', () => {
  it('uses wired non-empty text', () => {
    const prompt = resolveGeneratePrompt(
      { data: { prompt: 'fallback' } },
      new Map([['prompt-1', { data: { text: '  wired text  ' } }]]),
      [{ source: 'prompt-1', targetHandle: 'prompt' }],
    );
    expect(prompt).toBe('  wired text  ');
  });

  it('falls back to data.prompt when wired text is empty', () => {
    const prompt = resolveGeneratePrompt(
      { data: { prompt: 'fallback' } },
      new Map([['prompt-1', { data: { text: '   ' } }]]),
      [{ source: 'prompt-1', targetHandle: 'prompt' }],
    );
    expect(prompt).toBe('fallback');
  });

  it('falls back to data.prompt when there is no prompt edge', () => {
    const prompt = resolveGeneratePrompt({ data: { prompt: 'fallback' } }, new Map(), []);
    expect(prompt).toBe('fallback');
  });

  it('ignores a scene context edge', () => {
    expect(
      resolveGeneratePrompt(
        { data: { prompt: 'fallback' } },
        new Map([['scene', { data: { text: 'context' } }]]),
        [{ source: 'scene', targetHandle: 'scene' }],
      ),
    ).toBe('fallback');
  });
});
