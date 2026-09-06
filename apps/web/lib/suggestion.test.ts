import { describe, expect, it } from 'vitest';
import { characterCues } from '../app/scenario/fountain-classify';
import { extractRule } from '../app/scenario/_lib';

describe('characterCues — name-diff trigger (spec §5)', () => {
  it('lists unique cues with the scene they first appear in, strips extensions', () => {
    const text = [
      'ИНТ. КОМНАТА - ДЕНЬ',
      '',
      'МАРК',
      'Привет.',
      '',
      'НАТ. КРЫША - НОЧЬ',
      '',
      'ЛИДА (ЗК)',
      'Ты знал.',
      '',
      'МАРК',
      'Знал.',
      '',
    ].join('\n');
    expect(characterCues(text)).toEqual([
      { name: 'МАРК', scene: 1 },
      { name: 'ЛИДА', scene: 2 },
    ]);
  });

  it('is empty when there are no character cues', () => {
    expect(characterCues('ИНТ. А - ДЕНЬ\n\nПросто действие.\n')).toEqual([]);
  });
});

describe('extractRule — <rule> protocol tag', () => {
  it('pulls a generalizable rule when the tag is present', () => {
    expect(
      extractRule('Готово.\n<rewrite>x</rewrite>\n<rule>Марк никогда не извиняется</rule>'),
    ).toBe('Марк никогда не извиняется');
  });
  it('returns null with no tag / empty tag / overlong', () => {
    expect(extractRule('Просто ответ без правила.')).toBeNull();
    expect(extractRule('<rule>   </rule>')).toBeNull();
    expect(extractRule(`<rule>${'x'.repeat(201)}</rule>`)).toBeNull();
  });
});
