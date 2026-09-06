import { describe, expect, it } from 'vitest';
import { BOARD_LIMITS } from './board-contract';
import { GROUP_SEP, buildSceneContext } from './scene-context';

describe('buildSceneContext', () => {
  it('strips every Fountain prefix form without changing casing', () => {
    for (const prefix of ['ИНТ.', 'НАТ.', 'ИНТ./НАТ.', 'INT.', 'EXT.', 'INT./EXT.', 'Инт.']) {
      expect(buildSceneContext({ title: `${prefix} КАФЕ — ВЕЧЕР` })).toBe('КАФЕ, ВЕЧЕР');
    }
  });

  it('keeps a title without a dash and appends only new places', () => {
    expect(
      buildSceneContext({
        title: 'КАФЕ',
        objects: [
          { kind: 'place', name: 'кафе' },
          { kind: 'place', name: 'Крыша' },
          { kind: 'place', name: 'крыша' },
          { kind: 'person', name: 'Анна' },
          { kind: 'thing', name: 'Счёт' },
        ],
      }),
    ).toBe(`КАФЕ, Крыша${GROUP_SEP}Анна${GROUP_SEP}Счёт`);
  });

  it('omits empty groups and sanitizes separators and line breaks in all fields', () => {
    expect(
      buildSceneContext({
        title: `ИНТ. ДОМ${GROUP_SEP}ВЕЧЕР\n`,
        synopsis: `Она входит${GROUP_SEP}\nтихо`,
        objects: [{ kind: 'person', name: `Анна${GROUP_SEP}\n` }],
      }),
    ).toBe('ДОМВЕЧЕР · Анна — Она входит тихо');
    expect(buildSceneContext({ title: 'Сцена', objects: [{ kind: 'place', name: 'Сцена' }] })).toBe(
      'Сцена',
    );
  });

  it('omits a synopsis that does not fit instead of cutting it', () => {
    const base = buildSceneContext({ title: 'КАФЕ', objects: [{ kind: 'person', name: 'Анна' }] });
    expect(
      buildSceneContext({
        title: 'КАФЕ',
        synopsis: 'я'.repeat(500),
        objects: [{ kind: 'person', name: 'Анна' }],
      }),
    ).toBe(base);
  });

  it('truncates at a word boundary and handles a string with no boundary safely', () => {
    const withWords = buildSceneContext({ title: `ИНТ. ${'слово '.repeat(100)}` });
    expect(withWords.length).toBeLessThanOrEqual(BOARD_LIMITS.sceneContext);
    expect(withWords.endsWith('…')).toBe(true);
    expect(buildSceneContext({ title: 'я'.repeat(500) })).toBe(
      `${'я'.repeat(BOARD_LIMITS.sceneContext - 1)}…`,
    );
  });

  it('measures the digest in UTF-16 units without splitting astral characters', () => {
    const digest = buildSceneContext({ title: '😀'.repeat(300) });
    expect(digest).toBe(`${'😀'.repeat(199)}…`);
    expect(digest.length).toBeLessThanOrEqual(BOARD_LIMITS.sceneContext);
  });

  it('returns an empty digest for an empty scene', () => {
    expect(buildSceneContext({})).toBe('');
  });
});
