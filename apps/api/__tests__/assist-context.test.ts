import { describe, expect, it } from 'vitest';
import type { ScriptThreadMessage } from '@seed/db';
import {
  CONSPECT_INPUT_TOKEN_LIMIT,
  MATERIALS_MAX_CHARS,
  MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT,
} from '@seed/shared';
import {
  assembleAssistPrompt,
  bibleBlock,
  conspectRefreshRequired,
  conspectPrompt,
  fitAssistPromptToInputLimit,
  materialCompactionPrompt,
  materialsBlock,
  selectWindow,
  SECTION,
  WINDOW_MAX_CHARS,
} from '../src/assist-context';

/**
 * Locks the cache-friendly prompt ORDER and the bounded-memory math. These
 * are pure functions — no DB, no gateway — so the invariants that keep the
 * assist cost flat (and provider caches warm) are pinned here, cheaply.
 */

const msg = (role: 'user' | 'assistant', content: string): ScriptThreadMessage => ({
  role,
  content,
  at: '2026-07-02T00:00:00.000Z',
});

describe('assembleAssistPrompt — cache-friendly order', () => {
  it('emits библия → materials → scene → conспект → window → question in that order', () => {
    const { system, user } = assembleAssistPrompt({
      bible: { characters: [{ name: 'МИХАЛЫЧ', description: 'молчун' }] },
      materials: 'заметки о мире',
      sceneBlock: '=== СЦЕНА ===\nтекст сцены',
      conspect: 'ранее обсудили финал',
      window: [msg('user', 'прошлый вопрос'), msg('assistant', 'прошлый ответ')],
      question: 'новый вопрос',
    });
    const whole = `${system}\n${user}`;
    const order = [
      SECTION.bible,
      SECTION.materials,
      '=== СЦЕНА ===',
      SECTION.conspect,
      SECTION.window,
      SECTION.question,
    ].map((marker) => whole.indexOf(marker));

    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // библия rides the stable system prefix; the question is last (volatile).
    expect(system).toContain(SECTION.bible);
    expect(user.trimEnd().endsWith('новый вопрос')).toBe(true);
  });

  it('omits empty sections without reordering the rest', () => {
    const { system, user } = assembleAssistPrompt({
      bible: {},
      materials: '',
      sceneBlock: '=== ОГЛАВЛЕНИЕ СЦЕН ===\n1. ИНТ.',
      conspect: '',
      window: [],
      question: 'вопрос',
    });
    expect(system).not.toContain(SECTION.bible);
    expect(user).not.toContain(SECTION.materials);
    expect(user).not.toContain(SECTION.conspect);
    expect(user).not.toContain(SECTION.window);
    expect(user.indexOf('ОГЛАВЛЕНИЕ')).toBeLessThan(user.indexOf(SECTION.question));
  });
});

describe('selectWindow — bounded verbatim memory', () => {
  it('keeps only the trailing messages that fit the char budget', () => {
    const big = 'я'.repeat(4_000);
    const messages = Array.from({ length: 6 }, (_, i) => msg('user', `${i}:${big}`));
    const { window, windowStart } = selectWindow(messages);
    const chars = window.reduce((n, m) => n + m.content.length, 0);
    expect(chars).toBeLessThanOrEqual(WINDOW_MAX_CHARS + 4_100);
    expect(windowStart).toBeGreaterThan(0); // older messages evicted → conспект
    expect(window[window.length - 1]!.content.startsWith('5:')).toBe(true);
  });

  it('always keeps at least the last message even if it alone exceeds the budget', () => {
    const huge = msg('user', 'ю'.repeat(WINDOW_MAX_CHARS * 2));
    const { window, windowStart } = selectWindow([msg('user', 'старое'), huge]);
    expect(window).toHaveLength(1);
    expect(windowStart).toBe(1);
  });

  it('empty thread → empty window', () => {
    expect(selectWindow([])).toEqual({ window: [], windowStart: 0 });
  });
});

describe('conspectPrompt — priced byte ceiling', () => {
  it('keeps the complete serialized prompt within the workbook input-token ceiling', () => {
    const messages = Array.from({ length: 200 }, () => msg('user', '😀'.repeat(8_000)));
    const prompt = conspectPrompt('старый конспект', messages);
    expect(Buffer.byteLength(prompt.system) + Buffer.byteLength(prompt.user)).toBeLessThanOrEqual(
      CONSPECT_INPUT_TOKEN_LIMIT,
    );
  });

  it('predicts a refresh from the maximum next answer, not from summary presence', () => {
    const history = Array.from({ length: 6 }, (_, i) => msg('user', `${i}:${'x'.repeat(2_000)}`));
    expect(conspectRefreshRequired(history, 0, 'новый вопрос', 2_000)).toBe(true);
    expect(conspectRefreshRequired(history, 6, 'новый вопрос', 2_000)).toBe(false);
  });
});

describe('fitAssistPromptToInputLimit — paid input ceiling', () => {
  it('preserves the question and stays within the byte ceiling for dense Unicode', () => {
    const raw = assembleAssistPrompt({
      bible: { notes: ['😀'.repeat(8_000)] },
      materials: 'я'.repeat(20_000),
      sceneBlock: `=== СЦЕНА ===\n${'ю'.repeat(20_000)}`,
      conspect: 'э'.repeat(4_000),
      window: [msg('assistant', 'щ'.repeat(9_000))],
      question: 'Сохрани этот вопрос.',
    });
    const fitted = fitAssistPromptToInputLimit(raw, 22_400);
    expect(Buffer.byteLength(fitted.system) + Buffer.byteLength(fitted.user)).toBeLessThanOrEqual(
      22_400,
    );
    expect(fitted.user).toContain(SECTION.question);
    expect(fitted.user).toContain('Сохрани этот вопрос.');
    expect(fitted.truncated).toBe(true);
  });
});

describe('materialCompactionPrompt — priced byte ceiling', () => {
  it('keeps the serialized prompt within the workbook input-token ceiling', () => {
    const prompt = materialCompactionPrompt('large.txt', '😀'.repeat(200_000));
    expect(Buffer.byteLength(prompt.system) + Buffer.byteLength(prompt.user)).toBeLessThanOrEqual(
      MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT,
    );
  });
});

describe('materialsBlock — hard char clamp', () => {
  it('clamps the injected total to the ceiling even if stored is larger', () => {
    const block = materialsBlock([
      { name: 'a', content: 'x'.repeat(MATERIALS_MAX_CHARS), summary: null },
      { name: 'b', content: 'y'.repeat(5_000), summary: null },
    ]);
    expect(block.length).toBeLessThanOrEqual(MATERIALS_MAX_CHARS + 100);
    expect(block).toContain('— a —');
  });

  it('injects a background summary in place of the raw content when present', () => {
    const block = materialsBlock([
      { name: 'заявка', content: 'СЫРОЙ ДЛИННЫЙ ТЕКСТ '.repeat(500), summary: 'Марк — механик.' },
    ]);
    expect(block).toBe('— заявка —\nМарк — механик.');
    expect(block).not.toContain('СЫРОЙ');
  });

  it('falls back to raw content when summary is empty', () => {
    const block = materialsBlock([{ name: 'a', content: 'сырой', summary: '' }]);
    expect(block).toBe('— a —\nсырой');
  });

  it('empty when there are no materials', () => {
    expect(materialsBlock([])).toBe('');
  });

  it('excludes scratch materials while retaining canon', () => {
    expect(
      materialsBlock([
        { name: 'canon', content: 'правило мира', summary: null, includeInAi: 1 },
        { name: 'scratch', content: 'сырой вариант', summary: null, includeInAi: 0 },
      ]),
    ).toBe('— canon —\nправило мира');
  });
});

describe('bibleBlock', () => {
  it('renders a flat notes list; empty bible → empty string', () => {
    expect(bibleBlock({})).toBe('');
    const b = bibleBlock({ notes: ['МАРК врёт только себе', 'Тон: меланхолия'] });
    expect(b).toBe('- МАРК врёт только себе\n- Тон: меланхолия');
  });

  it('clamps the memory to the notes ceiling (keeps author order, always ≥1)', () => {
    const many = Array.from({ length: 400 }, (_, i) => `Заметка номер ${i} про канон истории`);
    const b = bibleBlock({ notes: many }, 500);
    expect(b.length).toBeLessThanOrEqual(500);
    expect(b).toContain('Заметка номер 0'); // earliest kept
    expect(b).not.toContain('Заметка номер 399'); // overflow dropped
  });

  it('always keeps at least the first note even if it alone exceeds the ceiling', () => {
    const b = bibleBlock({ notes: ['x'.repeat(2_000)] }, 100);
    expect(b).toBe(`- ${'x'.repeat(2_000)}`);
  });

  it('folds legacy characters/tone/rules into notes (lossless read migration)', () => {
    const b = bibleBlock({
      characters: [{ name: 'ЛИДА', description: 'голос из зала' }],
      tone: ['ламповый хоррор'],
      rules: ['никто не говорит «призрак»'],
    });
    expect(b).toContain('ЛИДА — голос из зала');
    expect(b).toContain('Тон: ламповый хоррор');
    expect(b).toContain('призрак');
  });
});
