import { readFile } from 'node:fs/promises';
import { egressFetch } from '../apps/api/src/egress-fetch';

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');

const reasoningOptions = (model: string) => {
  if (model === 'openai/gpt-oss-120b') return { reasoning: { effort: 'low' } };
  if (model === 'minimax/minimax-m2.5' || model === 'minimax/minimax-m2.7') return {};
  if (model.includes('sonnet')) return {};
  return { reasoning: { enabled: false } };
};

type EvalCase = {
  id: string;
  format: string;
  task: string;
  language: string;
  input: string;
  checks: string[];
};

function realisticInput(item: EvalCase): string {
  if (item.task === 'span_rewrite') {
    return [
      'СЦЕНА: НАТ. ПУСТАЯ ПЛАТФОРМА — НОЧЬ.',
      'ЛЕРА прячет дрожащие руки. По громкой связи объявляют отмену последнего поезда.',
      'Выделенная реплика ЛЕРЫ: «Мне кажется, нам, наверное, лучше отсюда уйти.»',
      item.input,
      'Дай одну короткую рекомендацию и один блок <rewrite>новая реплика</rewrite>.',
    ].join('\n');
  }
  if (item.task === 'scene_critique') {
    return [
      item.input,
      'ТЕКУЩАЯ СЦЕНА:',
      'ИНТ. АРХИВ — НОЧЬ. Архивист МАРК хочет вынести папку до прихода охраны. ЛИФТ не работает. Он спорит по телефону с сестрой о старой ссоре, затем слышит шаги охранника. Марк кладёт папку обратно и прячется. Охранник проходит мимо. Марк снова берёт папку и выходит через окно.',
      'Ответь конкретно по этой сцене: цель, конфликт, причинность и одно применимое исправление. Не переписывай сцену.',
    ].join('\n');
  }
  if (item.task === 'project_analysis') {
    return [
      item.input,
      'КАРТА ПРОЕКТА:',
      '1. Архивист Марк обнаруживает, что вчерашние события исчезают из газет.',
      '2. Он обещает сестре не вмешиваться и прячет единственный сохранившийся выпуск.',
      '3. Без нового события или решения Марк уже публично обвиняет мэра и полиция начинает погоню.',
      '4. Сестра внезапно помогает Марку проникнуть в архив, хотя прежде не узнавала о пропаже газет.',
      'Назови конкретные разрывы между номерами сцен и предложи причинные мосты без переписывания текста.',
    ].join('\n');
  }
  return item.input;
}

const candidates = process.argv.slice(2);
if (!candidates.length) throw new Error('pass one or more OpenRouter model slugs');
const judge = process.env.QUALITY_JUDGE ?? 'anthropic/claude-sonnet-5';
const samplesPerCase = 3;

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
  }
  return shuffled;
}

async function complete(
  model: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 2_000,
) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await egressFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          // Representative of the real Scenario scene/project output budget
          // (1,500–2,500 tokens depending on scope), not an artificial short cap.
          max_tokens: maxTokens,
          temperature: 0.2,
          ...reasoningOptions(model),
          response_format: model === judge ? { type: 'json_object' } : undefined,
        }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        throw new Error(
          `${model}: HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
      }
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { cost?: number };
      };
      return {
        text: body.choices?.[0]?.message?.content?.trim() ?? '',
        cost: Number(body.usage?.cost ?? 0),
      };
    } catch (error) {
      lastError = error;
      console.error(`[quality-gate] ${model} attempt ${attempt} failed: ${String(error)}`);
    }
  }
  throw lastError;
}

async function judgeOutputs(messages: Array<{ role: string; content: string }>) {
  let cost = 0;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const judged = await complete(judge, messages, 4_000);
    cost += judged.cost;
    try {
      const verdict = JSON.parse(
        judged.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''),
      ) as {
        scores?: Array<{ candidate: number; sample: number; score: number; failure?: string }>;
      };
      if (!Array.isArray(verdict.scores)) throw new Error('missing scores array');
      return { verdict: { scores: verdict.scores }, cost };
    } catch (error) {
      lastError = error;
      console.error(`[quality-gate] invalid judge JSON attempt ${attempt}: ${String(error)}`);
    }
  }
  throw lastError;
}

async function main() {
  const corpus = JSON.parse(
    await readFile('/app/apps/api/evals/scenario-quality-corpus.json', 'utf8'),
  ).filter((item: EvalCase) => item.task !== 'renderer_fallback') as EvalCase[];
  const results: Record<
    string,
    {
      scores: number[];
      failures: string[];
      cost: number;
      cases: Array<{
        id: string;
        scores: number[];
        median: number;
        failures: string[];
        outputs: string[];
      }>;
    }
  > = Object.fromEntries(
    candidates.map((model) => [model, { scores: [], failures: [], cost: 0, cases: [] }]),
  );
  let judgeCost = 0;

  for (const item of corpus) {
    console.error(`[quality-gate] ${item.id}`);
    const outputs = await Promise.all(
      candidates.flatMap((model, candidate) =>
        Array.from({ length: samplesPerCase }, async (_, sample) => {
          const result = await complete(model, [
            {
              role: 'system',
              content:
                'Ты профессиональный редактор русскоязычных сценариев. Дай конкретный, применимый ответ без общих комплиментов. Не добавляй служебные теги сам; если пользователь явно требует <rewrite>, верни этот блок точно в запрошенном формате.',
            },
            { role: 'user', content: `[${item.format}/${item.task}] ${realisticInput(item)}` },
          ]);
          results[model]!.cost += result.cost;
          return { candidate, sample, output: result.text };
        }),
      ),
    );

    const judged = await judgeOutputs([
      {
        role: 'system',
        content:
          'Ты строгий слепой оценщик сценарного редактора. Оцени каждый ответ независимо от 1 до 5 по заданным критериям. 5 — профессионально и сразу применимо; 4 — хорошо с мелкими недостатками; 3 — приемлемо; 2 — заметно не выполняет задачу; 1 — бесполезно или нарушает формат. Сохрани candidate и sample каждого входа. Верни только компактный JSON {"scores":[{"candidate":0,"sample":0,"score":1}]}, без объяснений. Не предпочитай ответы по длине.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          case: {
            id: item.id,
            task: item.task,
            input: realisticInput(item),
            checks: item.checks,
          },
          candidates: shuffle(outputs),
        }),
      },
    ]);
    judgeCost += judged.cost;
    const verdict = judged.verdict;
    for (const [candidate, model] of candidates.entries()) {
      const caseScores = verdict.scores
        .filter((score) => score.candidate === candidate)
        .map((score) => score.score)
        .sort((a, b) => a - b);
      const median = caseScores[Math.floor(caseScores.length / 2)] ?? 0;
      results[model]!.scores.push(median);
      const failures = verdict.scores.filter(
        (score) => score.candidate === candidate && score.score < 3,
      );
      results[model]!.cases.push({
        id: item.id,
        scores: caseScores,
        median,
        failures: failures.map(
          (score) => `${score.sample}:${score.failure?.trim() || String(score.score)}`,
        ),
        outputs: outputs
          .filter((output) => output.candidate === candidate)
          .sort((left, right) => left.sample - right.sample)
          .map((output) => output.output),
      });
      if (median < 3) {
        results[model]!.failures.push(
          `${item.id}: median ${median}; ${failures.map((score) => `${score.sample}:${score.failure ?? score.score}`).join(' | ')}`,
        );
      }
    }
  }

  const report = Object.fromEntries(
    Object.entries(results).map(([model, result]) => {
      const average = result.scores.reduce((sum, score) => sum + score, 0) / result.scores.length;
      // Economy must be consistently usable (no median case below 3). The
      // aggregate 3.25 floor keeps it clearly above bare acceptability without
      // pretending the lowest-priced tier should match Standard/Max quality.
      const pass =
        result.scores.length === corpus.length &&
        average >= 3.25 &&
        result.scores.every((s) => s >= 3);
      return [model, { ...result, average, pass }];
    }),
  );
  console.log(
    JSON.stringify(
      { cases: corpus.length, samplesPerCase, judge, judgeCost, models: report },
      null,
      2,
    ),
  );
  if (!Object.values(report).some((result) => result.pass)) process.exitCode = 1;
}

void main();
