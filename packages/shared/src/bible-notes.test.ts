import { describe, expect, it } from 'vitest';
import { bibleNotes } from './bible-notes';

describe('bibleNotes', () => {
  it('returns [] for empty / nullish bibles', () => {
    expect(bibleNotes(null)).toEqual([]);
    expect(bibleNotes(undefined)).toEqual([]);
    expect(bibleNotes({})).toEqual([]);
    expect(bibleNotes({ notes: ['', '  '] })).toEqual([]);
  });

  it('keeps notes as-is (trimmed)', () => {
    expect(bibleNotes({ notes: ['  Марк врёт  ', 'Тон: сухой'] })).toEqual([
      'Марк врёт',
      'Тон: сухой',
    ]);
  });

  it('keeps canon object notes and excludes scratch notes from AI context', () => {
    expect(
      bibleNotes({
        notes: [
          { id: 'canon-1', content: '  Маяк виден только ночью  ', includeInAi: true },
          { id: 'scratch-1', content: 'Попробовать другой финал', includeInAi: false },
        ],
      }),
    ).toEqual(['Маяк виден только ночью']);
  });

  it('folds legacy characters/tone/rules into notes losslessly, notes first', () => {
    expect(
      bibleNotes({
        notes: ['ручная запись'],
        characters: [
          { name: 'ЛИДА', description: 'голос из зала' },
          { name: 'МАРК', description: '' },
        ],
        tone: ['меланхолия', 'сухой юмор'],
        rules: ['никто не говорит «призрак»'],
      }),
    ).toEqual([
      'ручная запись',
      'ЛИДА — голос из зала',
      'МАРК',
      'Тон: меланхолия, сухой юмор',
      'никто не говорит «призрак»',
    ]);
  });
});
