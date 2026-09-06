import { describe, expect, it } from 'vitest';
import { firstUser, lastAssistant, stripRewrite } from '../app/scenario/scenario-thread';
import type { Thread } from '../app/scenario/_lib';

const thread = {
  messages: [
    { role: 'user', content: 'Вопрос', at: '2026-07-11T00:00:00Z' },
    {
      role: 'assistant',
      content: 'Ответ <rewrite>замена</rewrite><rule>канон</rule>',
      tier: 'standard',
      at: '2026-07-11T00:00:01Z',
    },
  ],
} as Thread;

describe('Scenario thread projection', () => {
  it('keeps proposal markup out of visible assistant prose', () => {
    expect(stripRewrite(thread.messages[1]!.content)).toBe('Ответ');
    expect(lastAssistant(thread)).toEqual({ content: 'Ответ', tier: 'standard' });
  });

  it('owns the first user prompt projection', () => {
    expect(firstUser(thread)).toBe('Вопрос');
  });
});
