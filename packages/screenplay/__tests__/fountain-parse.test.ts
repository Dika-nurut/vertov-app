import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFountain } from '../src/fountain/parse.js';
import { stripInline } from '../src/fountain/inline.js';
import type { FountainElement } from '../src/model.js';

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/fountain/${name}`, import.meta.url), 'utf-8');

const types = (els: FountainElement[]) => els.filter((e) => e.type !== 'blank').map((e) => e.type);

describe('title page', () => {
  it('parses RU keys with tab-indented continuation values', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const keys = doc.titlePage.map((e) => e.key);
    expect(keys).toEqual(['Название', 'Автор', 'Источник', 'Дата', 'Контакт']);
    const contact = doc.titlePage[4]!;
    expect(contact.values).toEqual(['ООО «Вертов»', 'Москва']);
  });

  it('does not mistake a transition-like first line for a title page', () => {
    const doc = parseFountain('CUT TO:\n\nSome action.');
    expect(doc.titlePage).toEqual([]);
    expect(doc.elements[0]!.type).toBe('transition');
  });
});

describe('scene headings', () => {
  it('recognizes naturally typed headings followed directly by action', () => {
    const doc = parseFountain(
      'ИНТ. КВАРТИРА — ДЕНЬ\nМаша смотрит в окно.\n\nНАТ. ДВОР — ВЕЧЕР\nМаша выходит из дома.\n',
    );
    expect(
      doc.elements.filter((element) => element.type === 'scene_heading').map((scene) => scene.text),
    ).toEqual(['ИНТ. КВАРТИРА — ДЕНЬ', 'НАТ. ДВОР — ВЕЧЕР']);
  });

  it('keeps a scene heading when a synopsis follows it directly', () => {
    const doc = parseFountain('ИНТ. КУХНЯ - УТРО\n= Алиса находит письмо.\n\nДействие.\n');
    expect(doc.elements.slice(0, 2)).toMatchObject([
      { type: 'scene_heading', text: 'ИНТ. КУХНЯ - УТРО' },
      { type: 'synopsis', text: 'Алиса находит письмо.' },
    ]);
  });

  it('recognizes RU headings: ИНТ., НАТ., ИНТ./НАТ., ПАВ.', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const headings = doc.elements.filter((e) => e.type === 'scene_heading');
    expect(headings.map((h) => h.text)).toEqual([
      'ИНТ. КИНОБУДКА - НОЧЬ',
      'НАТ. КРЫША КИНОТЕАТРА - НОЧЬ',
      'ИНТ./НАТ. ПРОХОДНАЯ КИНОТЕАТРА - УТРО',
      'ПАВ. ДЕКОРАЦИЯ «КВАРТИРА» - ДЕНЬ',
    ]);
    expect(headings[0]!.sceneNumber).toBe('1');
    expect(headings[1]!.sceneNumber).toBe('2');
  });

  it('recognizes forced headings with scene numbers', () => {
    const doc = parseFountain(fixture('edge-cases.fountain'));
    const forced = doc.elements.find((e) => e.type === 'scene_heading');
    expect(forced!.text).toBe('OPENING SHOT - A FORCED HEADING');
    expect(forced!.sceneNumber).toBe('A-1');
    expect(forced!.forced).toBe(true);
  });

  it('does not classify a heading-like line inside a paragraph', () => {
    const doc = parseFountain('He said:\nINT. NOT A HEADING - DAY\nreally.');
    expect(types(doc.elements)).toEqual(['action']);
  });

  it('keeps adjacent synopsis, character cue, transition, and forced heading behavior', () => {
    const synopsis = parseFountain('ИНТ. КУХНЯ - УТРО\n= Письмо на столе.\n');
    expect(types(synopsis.elements)).toEqual(['scene_heading', 'synopsis']);

    const dialogue = parseFountain('МАРК\nПривет.\n');
    expect(types(dialogue.elements)).toEqual(['character', 'dialogue']);

    const transition = parseFountain('CUT TO:\n\nДействие.\n');
    expect(types(transition.elements)).toEqual(['transition', 'action']);

    const forced = parseFountain('.СОН МАШИ\nОна летит.\n');
    expect(types(forced.elements)).toEqual(['scene_heading', 'action']);
    expect(forced.elements[0]).toMatchObject({ forced: true, text: 'СОН МАШИ' });
  });
});

describe('dialogue blocks', () => {
  it('parses Cyrillic character names with (ЗК) extensions', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const chars = doc.elements.filter((e) => e.type === 'character').map((e) => e.text);
    expect(chars).toContain('ЛИДА (ЗК)');
    expect(chars).toContain('МИХАЛЫЧ');
  });

  it('parses parentheticals inside dialogue', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const parens = doc.elements.filter((e) => e.type === 'parenthetical');
    expect(parens.map((p) => p.text)).toEqual(['(не оборачиваясь)', '(зевая)']);
  });

  it('keeps a two-space line as dialogue continuation, not a break', () => {
    const doc = parseFountain(fixture('edge-cases.fountain'));
    const i = doc.elements.findIndex((e) => e.type === 'character' && e.text === 'DEALER');
    const block = doc.elements.slice(i + 1, i + 5);
    expect(block.map((e) => e.type)).toEqual(['dialogue', 'dialogue', 'dialogue', 'dialogue']);
    expect(block.map((e) => e.text)).toEqual(['Ten.', 'Four.', '', 'Change?']);
  });

  it('marks dual dialogue and strips the caret', () => {
    const doc = parseFountain(fixture('edge-cases.fountain'));
    const dual = doc.elements.find((e) => e.dual);
    expect(dual!.text).toBe('MCCLANE');
  });

  it('parses forced mixed-case @characters', () => {
    const doc = parseFountain(fixture('edge-cases.fountain'));
    const forced = doc.elements.find((e) => e.type === 'character' && e.forced);
    expect(forced!.text).toBe('McCLANE');
  });

  it('treats a lone uppercase line followed by blank as action', () => {
    const doc = parseFountain('Setup.\n\nTHE END\n');
    expect(types(doc.elements)).toEqual(['action', 'action']);
  });
});

describe('transitions, centered, lyrics, breaks', () => {
  it('parses spec transitions (TO:) and forced RU transitions (>)', () => {
    const en = parseFountain(fixture('edge-cases.fountain'));
    const ru = parseFountain(fixture('ru-sample.fountain'));
    expect(en.elements.filter((e) => e.type === 'transition').map((e) => e.text)).toEqual([
      'CUT TO:',
      'BURN TO PINK.',
    ]);
    expect(ru.elements.filter((e) => e.type === 'transition').map((e) => e.text)).toEqual([
      'ЗАТЕМНЕНИЕ.',
    ]);
  });

  it('parses centered text, lyrics, page breaks, sections, synopses', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    expect(doc.elements.find((e) => e.type === 'centered')!.text).toBe('КОНЕЦ');
    expect(doc.elements.filter((e) => e.type === 'lyrics').length).toBe(2);
    expect(doc.elements.some((e) => e.type === 'page_break')).toBe(true);
    const section = doc.elements.find((e) => e.type === 'section')!;
    expect(section.text).toBe('Акт второй');
    expect(section.depth).toBe(1);
    expect(doc.elements.some((e) => e.type === 'synopsis')).toBe(true);
  });
});

describe('notes, boneyard, forced action', () => {
  it('parses standalone notes and multi-line boneyards as their own elements', () => {
    const doc = parseFountain(fixture('ru-sample.fountain'));
    const note = doc.elements.find((e) => e.type === 'note')!;
    expect(note.text).toContain('обсудить с Джаником');
    const boneyard = doc.elements.find((e) => e.type === 'boneyard')!;
    expect(boneyard.raw.length).toBe(4);
  });

  it('keeps forced action verbatim (heading-like line stays action)', () => {
    const doc = parseFountain(fixture('edge-cases.fountain'));
    const forced = doc.elements.find((e) => e.type === 'action' && e.forced)!;
    expect(forced.text).toBe('INT. THIS IS FORCED ACTION - NOT A HEADING');
  });
});

describe('stripInline', () => {
  it('removes emphasis but keeps escaped markers literal', () => {
    expect(
      stripInline('Some action with *italics*, **bold**, _underline_ and a \\*literal star\\*.'),
    ).toBe('Some action with italics, bold, underline and a *literal star*.');
  });

  it('removes inline notes', () => {
    expect(stripInline('Action containing an inline [[note]] survives.')).toBe(
      'Action containing an inline  survives.',
    );
  });
});
