import { describe, expect, it } from 'vitest';
import { classifyLines } from './fountain-classify';

describe('Scenario Fountain classification', () => {
  it('keeps naturally typed scene count and order when action follows directly', () => {
    const fountain =
      'ИНТ. КВАРТИРА — ДЕНЬ\nМаша смотрит в окно.\n\nНАТ. ДВОР — ВЕЧЕР\nМаша выходит из дома.';
    const lines = fountain.split('\n');
    const classes = classifyLines(fountain);

    expect(lines.filter((_line, index) => classes[index] === 'scene')).toEqual([
      'ИНТ. КВАРТИРА — ДЕНЬ',
      'НАТ. ДВОР — ВЕЧЕР',
    ]);
  });

  it('preserves synopsis, character cue, transition, and forced heading classification', () => {
    expect(classifyLines('= Письмо на столе.')).toEqual(['synopsis']);
    expect(classifyLines('МАРК\nПривет.')).toEqual(['character', 'dialogue']);
    expect(classifyLines('CUT TO:')).toEqual(['transition']);
    expect(classifyLines('.СОН МАШИ\nОна летит.')).toEqual(['scene', 'action']);
  });

  it('keeps the live navigator aligned with canonical scene block boundaries and prefixes', () => {
    expect(classifyLines('Он говорит:\nИНТ. НЕ ЗАГОЛОВОК — ДЕНЬ')).toEqual(['action', 'action']);
    expect(classifyLines('НАТ./ИНТ. МАШИНА — ДЕНЬ')).toEqual(['scene']);
    expect(classifyLines('EXT./INT. CAR — NIGHT')).toEqual(['scene']);
  });
});
