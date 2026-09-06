import type { Thread } from './_lib';

export function stripRewrite(text: string): string {
  return text
    .replace(/<rewrite>[\s\S]*?<\/rewrite>/g, '')
    .replace(/<\/?rewrite>/g, '')
    .replace(/<rule>[\s\S]*?<\/rule>/g, '')
    .replace(/<\/?rule>/g, '')
    .trim();
}

export function lastAssistant(thread: Thread): { content: string; tier?: string } | null {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]!;
    if (message.role === 'assistant') {
      return {
        content: stripRewrite(message.content),
        ...(message.tier ? { tier: message.tier } : {}),
      };
    }
  }
  return null;
}

export function firstUser(thread: Thread): string {
  return thread.messages.find((message) => message.role === 'user')?.content ?? '';
}
