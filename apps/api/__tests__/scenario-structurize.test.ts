import { describe, expect, it } from 'vitest';
import {
  buildStructurizePrompt,
  parseStructurizeOutput,
  StructurizeSchemaError,
} from '../src/scenario-structurize';
import { scoreStructurize, type StructurizeCorpusEntry } from '../src/scenario-structurize-eval';
import { scenarioStructurizeResultSchema } from '@seed/shared';

/**
 * Unit tests for the structurization engine + rubric (goal S1). Pure functions,
 * no DB, no gateway: the prompt contract, the tolerant JSON parser, and the
 * eval rubric's accept/reject sensitivity.
 */

const GOOD_OUTPUT = {
  format: 'social',
  brief: { version: 1, goal: 'Научить складывать футболку', durationSeconds: 15 },
  outline: {
    version: 1,
    beats: [
      {
        kind: 'hook',
        title: 'Гора мятых футболок',
        summary: 'Руки над завалом: складываешь по 5 минут?',
        durationSeconds: 4,
      },
      {
        kind: 'development',
        title: 'Три точки захвата',
        summary: 'Замедленно показываем, где брать ткань.',
        durationSeconds: 7,
      },
      {
        kind: 'cta',
        title: 'Повтор на скорости',
        summary: 'Пять штук за 10 секунд, призыв сохранить.',
        durationSeconds: 4,
      },
    ],
  },
};

describe('buildStructurizePrompt', () => {
  it('carries all four format playbooks + universal rules + JSON contract in the system prompt', () => {
    const { system } = buildStructurizePrompt({ source: 'идея', kind: 'idea' });
    for (const label of ['«social»', '«ad»', '«film»', '«sketch»']) {
      expect(system).toContain(label);
    }
    expect(system).toContain('ОБЩИЕ ПРАВИЛА');
    expect(system).toContain('Верни ТОЛЬКО валидный JSON');
    // The craft is rules, not a fill-in template.
    expect(system).toContain('первые 2 секунды');
    expect(system).toContain('Панчлайн');
  });

  it('labels the source differently for a raw idea vs pasted fountain', () => {
    expect(buildStructurizePrompt({ source: 'x', kind: 'idea' }).user).toContain(
      'Идея пользователя',
    );
    expect(buildStructurizePrompt({ source: 'x', kind: 'fountain' }).user).toContain('Fountain');
  });
});

describe('parseStructurizeOutput', () => {
  it('parses a clean valid object into a schema-valid result', () => {
    const result = parseStructurizeOutput(JSON.stringify(GOOD_OUTPUT));
    expect(result.format).toBe('social');
    expect(result.outline.beats).toHaveLength(3);
    // Every result is re-validated by the shared strict schema.
    expect(scenarioStructurizeResultSchema.safeParse(result).success).toBe(true);
  });

  it('strips ```json fences and surrounding prose', () => {
    const wrapped = 'Вот структура:\n```json\n' + JSON.stringify(GOOD_OUTPUT) + '\n```\nГотово.';
    expect(parseStructurizeOutput(wrapped).format).toBe('social');
  });

  it('assigns missing beat ids and dedups collisions', () => {
    const noIds = {
      ...GOOD_OUTPUT,
      outline: { version: 1, beats: GOOD_OUTPUT.outline.beats.map(({ ...b }) => b) },
    };
    const result = parseStructurizeOutput(JSON.stringify(noIds));
    const ids = result.outline.beats.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('coerces an unknown beat kind to a safe default (custom for non-film, scene for film)', () => {
    const weird = {
      format: 'film',
      brief: { version: 1 },
      outline: {
        version: 1,
        beats: [
          { kind: 'nonsense', title: 'ИНТ. ДОМ — ДЕНЬ', summary: 'Что-то происходит по сюжету.' },
        ],
      },
    };
    expect(parseStructurizeOutput(JSON.stringify(weird)).outline.beats[0]!.kind).toBe('scene');
  });

  it('coerces a stringified duration and drops non-positive/garbage durations', () => {
    const dur = {
      ...GOOD_OUTPUT,
      outline: {
        version: 1,
        beats: [
          { kind: 'hook', title: 'A', summary: 'первый бит истории тут', durationSeconds: '5' },
          { kind: 'cta', title: 'B', summary: 'второй бит истории тут', durationSeconds: -3 },
        ],
      },
    };
    const beats = parseStructurizeOutput(JSON.stringify(dur)).outline.beats;
    expect(beats[0]!.durationSeconds).toBe(5);
    expect(beats[1]!.durationSeconds).toBeUndefined();
  });

  it('throws StructurizeSchemaError on non-JSON, missing format, or empty title', () => {
    expect(() => parseStructurizeOutput('completely not json')).toThrow(StructurizeSchemaError);
    expect(() => parseStructurizeOutput('{"brief":{"version":1}}')).toThrow(StructurizeSchemaError);
    const emptyTitle = {
      format: 'ad',
      brief: { version: 1 },
      outline: {
        version: 1,
        beats: [{ kind: 'hook', title: '   ', summary: 'summary text here' }],
      },
    };
    expect(() => parseStructurizeOutput(JSON.stringify(emptyTitle))).toThrow(
      StructurizeSchemaError,
    );
  });

  it('rejects a degraded reply with no beats (empty/missing outline is not a usable result)', () => {
    // A model that returns only a format must NOT parse into a "success".
    expect(() => parseStructurizeOutput('{"format":"film"}')).toThrow(StructurizeSchemaError);
    const emptyBeats = {
      format: 'film',
      brief: { version: 1 },
      outline: { version: 1, beats: [] },
    };
    expect(() => parseStructurizeOutput(JSON.stringify(emptyBeats))).toThrow(
      StructurizeSchemaError,
    );
  });

  it('keeps at most one clarifying question and drops empty ones', () => {
    expect(
      parseStructurizeOutput(JSON.stringify({ ...GOOD_OUTPUT, question: '  ' })).question,
    ).toBeUndefined();
    expect(
      parseStructurizeOutput(JSON.stringify({ ...GOOD_OUTPUT, question: 'Какая площадка?' }))
        .question,
    ).toBe('Какая площадка?');
  });
});

describe('scoreStructurize rubric', () => {
  const socialEntry: StructurizeCorpusEntry = {
    id: 't-social',
    expectedFormat: 'social',
    idea: 'футболка',
    targetDurationSeconds: 15,
    reference: GOOD_OUTPUT,
  };

  it('passes a good social output on all four criteria', () => {
    const score = scoreStructurize(
      socialEntry,
      parseStructurizeOutput(JSON.stringify(GOOD_OUTPUT)),
    );
    expect(score.passed).toBe(true);
    expect(score.score).toBe(1);
  });

  it('fails when the format is wrong', () => {
    const wrong = parseStructurizeOutput(JSON.stringify({ ...GOOD_OUTPUT, format: 'ad' }));
    expect(scoreStructurize(socialEntry, wrong).formatGuessed).toBe(false);
  });

  it('fails timing when beat durations do not sum near the target', () => {
    const offTiming = parseStructurizeOutput(
      JSON.stringify({
        ...GOOD_OUTPUT,
        outline: {
          version: 1,
          beats: [
            { kind: 'hook', title: 'A', summary: 'первый бит истории тут', durationSeconds: 60 },
            { kind: 'cta', title: 'B', summary: 'второй бит истории тут', durationSeconds: 60 },
          ],
        },
      }),
    );
    expect(scoreStructurize(socialEntry, offTiming).timingSums).toBe(false);
  });

  it('fails concreteness on placeholder titles', () => {
    const placeholder = parseStructurizeOutput(
      JSON.stringify({
        ...GOOD_OUTPUT,
        outline: {
          version: 1,
          beats: [
            {
              kind: 'hook',
              title: 'Начало',
              summary: 'некий текст достаточной длины',
              durationSeconds: 7,
            },
            {
              kind: 'cta',
              title: 'Сцена 2',
              summary: 'ещё некий текст достаточной длины',
              durationSeconds: 8,
            },
          ],
        },
      }),
    );
    expect(scoreStructurize(socialEntry, placeholder).beatsConcrete).toBe(false);
  });

  it('penalizes a spurious question on an answerable idea, rewards one when expected', () => {
    const withQ = parseStructurizeOutput(JSON.stringify({ ...GOOD_OUTPUT, question: 'Зачем?' }));
    expect(scoreStructurize(socialEntry, withQ).questionDisciplined).toBe(false);
    const ambiguous: StructurizeCorpusEntry = { ...socialEntry, expectQuestion: true };
    expect(scoreStructurize(ambiguous, withQ).questionDisciplined).toBe(true);
    const noQ = parseStructurizeOutput(JSON.stringify(GOOD_OUTPUT));
    expect(scoreStructurize(ambiguous, noQ).questionDisciplined).toBe(false);
  });

  it('does not score film on duration sums (page-based timing)', () => {
    const filmEntry: StructurizeCorpusEntry = {
      id: 't-film',
      expectedFormat: 'film',
      idea: 'фильм',
      reference: {},
    };
    const filmOut = parseStructurizeOutput(
      JSON.stringify({
        format: 'film',
        brief: { version: 1, goal: 'логлайн истории про героя и его выбор' },
        outline: {
          version: 1,
          beats: [
            {
              kind: 'scene',
              title: 'ИНТ. ДОМ — ДЕНЬ',
              summary: 'Герой обнаруживает пропажу и идёт искать.',
            },
            {
              kind: 'scene',
              title: 'НАТ. УЛИЦА — НОЧЬ',
              summary: 'Погоня приводит его к развязке сюжета.',
            },
          ],
        },
      }),
    );
    expect(scoreStructurize(filmEntry, filmOut).timingSums).toBe(true);
    expect(scoreStructurize(filmEntry, filmOut).passed).toBe(true);
  });
});
