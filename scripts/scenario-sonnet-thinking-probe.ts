import { egressFetch } from '../apps/api/src/egress-fetch';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const modes = [
  { name: 'default', reasoning: undefined },
  { name: 'off', reasoning: { enabled: false } },
  { name: 'low', reasoning: { effort: 'low' } },
];

async function probe(mode: (typeof modes)[number]) {
  const started = performance.now();
  const response = await egressFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      messages: [
        {
          role: 'user',
          content:
            'Ты сценарный редактор. Перепиши конкретнее: «Я думаю, нам надо уходить отсюда.» Верни ровно <rewrite>...</rewrite>.',
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1200,
      ...(mode.reasoning ? { reasoning: mode.reasoning } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error(`${mode.name}: HTTP ${response.status}`);
  const admittedMs = Math.round(performance.now() - started);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstReasoningMs: number | null = null;
  let firstContentMs: number | null = null;
  let reasoningChunks = 0;
  let content = '';
  let usage: unknown = null;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const frame = JSON.parse(line.slice(6));
      const delta = frame.choices?.[0]?.delta ?? {};
      if (delta.reasoning || delta.reasoning_content || delta.reasoning_details?.length) {
        if (firstReasoningMs == null) firstReasoningMs = Math.round(performance.now() - started);
        reasoningChunks += 1;
      }
      if (delta.content) {
        if (firstContentMs == null) firstContentMs = Math.round(performance.now() - started);
        content += delta.content;
      }
      if (frame.usage) usage = frame.usage;
    }
  }
  return {
    mode: mode.name,
    admittedMs,
    firstReasoningMs,
    firstContentMs,
    completionMs: Math.round(performance.now() - started),
    reasoningChunks,
    usable: /<rewrite>[\s\S]+<\/rewrite>/i.test(content),
    usage,
  };
}

async function main() {
  const results = [];
  for (const mode of modes) results.push(await probe(mode));
  console.log(JSON.stringify(results, null, 2));
}

void main();
