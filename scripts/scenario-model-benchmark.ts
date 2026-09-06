import { egressFetch } from '../apps/api/src/egress-fetch';

const models = process.argv.slice(2);
if (!models.length) throw new Error('pass one or more OpenRouter model slugs');
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const reasoningOptions = (model: string) => {
  if (model === 'openai/gpt-oss-120b') return { reasoning: { effort: 'low' } };
  if (model === 'minimax/minimax-m2.5' || model === 'minimax/minimax-m2.7') return {};
  if (model.includes('sonnet')) return {};
  return { reasoning: { enabled: false } };
};

const prompt = [
  'Ты сценарный редактор. Ответь кратко по-русски.',
  'Перепиши выделенную реплику конкретнее и верни ровно один блок <rewrite>...</rewrite>.',
  'Выделение: «Я думаю, нам надо уходить отсюда.»',
].join('\n');

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function call(model: string, index: number) {
  const started = performance.now();
  const response = await egressFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-title': 'Scenario model latency certification',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 160,
      temperature: 0.2,
      ...reasoningOptions(model),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const admittedMs = performance.now() - started;
  if (!response.ok || !response.body) {
    throw new Error(`${model} HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let ttftMs: number | null = null;
  let cost: number | null = null;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
      const frame = JSON.parse(line.slice(6));
      const delta = frame.choices?.[0]?.delta?.content;
      if (delta) {
        if (ttftMs == null) ttftMs = performance.now() - started;
        content += delta;
      }
      if (Number.isFinite(frame.usage?.cost)) cost = frame.usage.cost;
    }
  }
  return {
    index,
    admittedMs: Math.round(admittedMs),
    ttftMs: ttftMs == null ? null : Math.round(ttftMs),
    completionMs: Math.round(performance.now() - started),
    usable: /<rewrite>[\s\S]+<\/rewrite>/i.test(content),
    chars: content.length,
    costUsd: cost,
  };
}

async function main() {
  const report: Record<string, unknown> = {};
  for (const model of models) {
    try {
      const warm = await call(model, 0);
      const concurrent = await Promise.all(Array.from({ length: 5 }, (_, i) => call(model, i + 1)));
      const rows = [warm, ...concurrent];
      const ttfts = rows.flatMap((row) => (row.ttftMs == null ? [] : [row.ttftMs]));
      report[model] = {
        calls: rows,
        success: rows.filter((row) => row.usable).length,
        ttftP50Ms: percentile(ttfts, 50),
        ttftP95Ms: percentile(ttfts, 95),
        completionP95Ms: percentile(
          rows.map((row) => row.completionMs),
          95,
        ),
        totalCostUsd: rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
      };
    } catch (error) {
      report[model] = { error: String(error) };
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

void main();
