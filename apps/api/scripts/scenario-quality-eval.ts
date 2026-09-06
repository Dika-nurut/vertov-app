import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const caseSchema = z.object({
  id: z.string().min(1),
  format: z.enum(['film', 'social', 'ad', 'sketch']),
  task: z.enum([
    'idea_to_plan',
    'span_rewrite',
    'scene_critique',
    'project_analysis',
    'renderer_fallback',
  ]),
  language: z.enum(['ru', 'mixed']),
  input: z.string().min(1),
  checks: z.array(z.string().min(1)).min(1),
});
const corpusSchema = z.array(caseSchema).min(8);

const corpusUrl = new URL('../evals/scenario-quality-corpus.json', import.meta.url);
const allCases = corpusSchema.parse(JSON.parse(await readFile(corpusUrl, 'utf8')));
const caseFilter = process.env.SCENARIO_EVAL_CASE;
const corpus = caseFilter ? allCases.filter((item) => item.id === caseFilter) : allCases;
if (corpus.length === 0) throw new Error(`unknown SCENARIO_EVAL_CASE: ${caseFilter}`);

if (process.env.SCENARIO_EVAL_LIVE !== '1') {
  console.log(`scenario eval corpus: ${corpus.length} cases valid (dry run; no provider calls)`);
  process.exit(0);
}

const endpoint = process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';
const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.SCENARIO_EVAL_MODEL;
if (!apiKey || !model) throw new Error('OPENROUTER_API_KEY and SCENARIO_EVAL_MODEL are required');

for (const item of corpus) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      max_tokens: 1_200,
      messages: [
        {
          role: 'system',
          content:
            'You are evaluating a Russian writing assistant. Return useful plain text; never expose internal tags.',
        },
        { role: 'user', content: `[${item.format}/${item.task}] ${item.input}` },
      ],
    }),
    signal: AbortSignal.timeout(Number(process.env.SCENARIO_EVAL_TIMEOUT_MS ?? 120_000)),
  });
  if (!response.ok) throw new Error(`${item.id}: provider HTTP ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const output = body.choices?.[0]?.message?.content?.trim() ?? '';
  console.log(
    JSON.stringify({ id: item.id, model, outputChars: output.length, checks: item.checks }),
  );
}
