import { describe, expect, it } from 'vitest';
import { buildStructurizePrompt, parseStructurizeOutput } from '../src/scenario-structurize';
import { scoreCorpus, scoreStructurize } from '../src/scenario-structurize-eval';
import { STRUCTURIZE_CORPUS, STRUCTURIZE_CORPUS_BY_FORMAT } from './fixtures/structurize-corpus';
import { STRUCTURIZE_MODEL, STRUCTURIZE_TOKEN_BUDGET } from '@seed/shared';

/**
 * The structurization release gate (goal S1). Two modes:
 *
 *  · CI (default, zero-spend): the mock "gateway" replays each corpus entry's
 *    human-authored reference; we run the FULL pipeline (parse → score) and
 *    require every reference to pass the rubric. This locks the parser + rubric
 *    against regression and asserts the corpus itself stays valid. A rubric that
 *    silently loosens, or a reference that drifts, fails here.
 *
 *  · LIVE (opt-in, STRUCTURIZE_LIVE_EVAL=1 + OPENROUTER_API_KEY): the same ideas
 *    are sent to the real economy model; a drop in the aggregate score blocks a
 *    prompt/model change. Kept out of CI to honor the zero-spend discipline.
 */

/** The mock gateway: a real model would return this text for the entry's idea. */
function replayReference(entry: (typeof STRUCTURIZE_CORPUS)[number]): string {
  return JSON.stringify(entry.reference);
}

describe('structurize corpus (shape + coverage)', () => {
  it('has 10 reference ideas for each of the four formats', () => {
    expect(STRUCTURIZE_CORPUS_BY_FORMAT.social).toHaveLength(10);
    expect(STRUCTURIZE_CORPUS_BY_FORMAT.ad).toHaveLength(10);
    expect(STRUCTURIZE_CORPUS_BY_FORMAT.sketch).toHaveLength(10);
    expect(STRUCTURIZE_CORPUS_BY_FORMAT.film).toHaveLength(10);
    expect(STRUCTURIZE_CORPUS).toHaveLength(40);
    expect(new Set(STRUCTURIZE_CORPUS.map((e) => e.id)).size).toBe(40);
  });

  it('every reference is schema-valid and matches its declared format', () => {
    for (const entry of STRUCTURIZE_CORPUS) {
      const result = parseStructurizeOutput(replayReference(entry));
      expect(result.format, entry.id).toBe(entry.expectedFormat);
    }
  });

  it('expectQuestion entries carry exactly one reference question; the rest carry none', () => {
    for (const entry of STRUCTURIZE_CORPUS) {
      const result = parseStructurizeOutput(replayReference(entry));
      if (entry.expectQuestion) {
        expect(result.question, entry.id).toBeTruthy();
      } else {
        expect(result.question, entry.id).toBeUndefined();
      }
    }
  });
});

describe('structurize eval gate (zero-spend, mock gateway)', () => {
  it('every corpus reference passes the rubric at full score', () => {
    const scored = STRUCTURIZE_CORPUS.map((entry) => ({
      id: entry.id,
      score: scoreStructurize(entry, parseStructurizeOutput(replayReference(entry))),
    }));
    const report = scoreCorpus(scored);
    // Golden references must clear the gate — any failure is a rubric or corpus regression.
    expect(report.failures).toEqual([]);
    expect(report.passRate).toBe(1);
    expect(report.meanScore).toBe(1);
  });

  it('the full prompt→gateway→parse→score chain runs per entry', () => {
    for (const entry of STRUCTURIZE_CORPUS) {
      const { system, user } = buildStructurizePrompt({ source: entry.idea, kind: 'idea' });
      expect(system.length).toBeGreaterThan(500);
      expect(user).toContain(entry.idea);
      const result = parseStructurizeOutput(replayReference(entry)); // mock gateway
      expect(scoreStructurize(entry, result).passed, entry.id).toBe(true);
    }
  });
});

/**
 * Opt-in live eval. Runs ONLY when explicitly enabled — it spends real credits
 * on the economy model. This is the true "score drop blocks the change" gate for
 * prompt/model edits. Thresholds are deliberately below 1.0: a real model won't
 * match every golden, but must clear a floor to ship.
 */
const LIVE = process.env.STRUCTURIZE_LIVE_EVAL === '1' && Boolean(process.env.OPENROUTER_API_KEY);
const OPENROUTER_URL =
  process.env.OPENROUTER_URL ?? 'https://openrouter.ai/api/v1/chat/completions';

async function liveStructurize(idea: string): Promise<string> {
  const { system, user } = buildStructurizePrompt({ source: idea, kind: 'idea' });
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ''}`,
      'Content-Type': 'application/json',
      'X-Title': 'Seed',
    },
    body: JSON.stringify({
      model: STRUCTURIZE_MODEL,
      max_tokens: STRUCTURIZE_TOKEN_BUDGET.output,
      reasoning: { enabled: false },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? '';
}

describe.skipIf(!LIVE)('structurize LIVE eval (real economy model, opt-in)', () => {
  it(
    'clears the score floor across the corpus',
    async () => {
      const scored = [];
      for (const entry of STRUCTURIZE_CORPUS) {
        try {
          const result = parseStructurizeOutput(await liveStructurize(entry.idea));
          scored.push({ id: entry.id, score: scoreStructurize(entry, result) });
        } catch {
          scored.push({
            id: entry.id,
            score: {
              formatGuessed: false,
              timingSums: false,
              beatsConcrete: false,
              questionDisciplined: false,
              passed: false,
              score: 0,
            },
          });
        }
      }
      const report = scoreCorpus(scored);
      // eslint-disable-next-line no-console
      console.log('LIVE structurize eval', JSON.stringify(report, null, 2));
      expect(report.meanScore).toBeGreaterThanOrEqual(0.8);
      expect(report.passRate).toBeGreaterThanOrEqual(0.7);
    },
    10 * 60 * 1000,
  );
});
