import { describe, expect, it } from 'vitest';
import {
  SHOT_SIZES,
  SHOT_MOVES,
  SHOT_LENSES,
  SHOT_LIGHT,
  SHOT_COLOR_TEMP,
  SHOT_GENRE,
  SHOT_ENERGY,
  MAX_MOVES,
  buildShotPrompt,
  effectiveMoves,
  shotGrammarLabel,
  shotGrammarMetadata,
  toggleMove,
} from './film-grammar';

describe('buildShotPrompt', () => {
  it('leads with camera grammar (size, lens, move), then the shot text', () => {
    const p = buildShotPrompt({
      grammar: { size: 'ws', lens: '24', move: 'static' },
      text: 'Кот сидит на столе',
    });
    expect(p).toBe(
      'общий план, широкий объектив 24мм, камера неподвижна, штатив. Кот сидит на столе',
    );
  });

  it('inserts the scene continuity look between camera and shot text', () => {
    const p = buildShotPrompt({
      grammar: { size: 'cu' },
      look: 'Ночь, холодный неон',
      text: 'Лицо героя',
    });
    expect(p).toBe('крупный план. Ночь, холодный неон. Лицо героя');
  });

  it('drops empty pieces — bare text when no grammar or look', () => {
    expect(buildShotPrompt({ text: 'просто кадр' })).toBe('просто кадр');
    expect(buildShotPrompt({ grammar: {}, look: '   ', text: 'просто кадр' })).toBe('просто кадр');
  });

  it('omits unset grammar fields but keeps set ones', () => {
    const p = buildShotPrompt({ grammar: { move: 'push' }, text: 'идём' });
    expect(p).toBe('медленный наезд камеры. идём');
  });
});

describe('shotGrammarLabel', () => {
  it('joins set fields as size · lens · move', () => {
    expect(shotGrammarLabel({ size: 'ws', lens: '50', move: 'pan' })).toBe(
      'Общий · 50мм · Панорама',
    );
  });
  it('is empty when nothing is set', () => {
    expect(shotGrammarLabel(undefined)).toBe('');
    expect(shotGrammarLabel({})).toBe('');
  });
});

describe('catalogs', () => {
  it('every option has a unique id and a non-empty fragment', () => {
    for (const cat of [
      SHOT_SIZES,
      SHOT_MOVES,
      SHOT_LENSES,
      SHOT_LIGHT,
      SHOT_COLOR_TEMP,
      SHOT_GENRE,
      SHOT_ENERGY,
    ]) {
      const ids = cat.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const o of cat) {
        expect(o.label.length).toBeGreaterThan(0);
        expect(o.frag.length).toBeGreaterThan(0);
      }
    }
  });
});

// --- B-4: extended dimensions, move stacking, structured metadata ----------

describe('toggleMove (stack ≤ MAX_MOVES)', () => {
  it('adds, removes, and caps the stack', () => {
    expect(toggleMove(undefined, 'push')).toEqual(['push']);
    expect(toggleMove(['push'], 'pan')).toEqual(['push', 'pan']);
    expect(toggleMove(['push', 'pan'], 'push')).toEqual(['pan']); // toggle off
    const full = ['push', 'pan', 'track'];
    expect(full).toHaveLength(MAX_MOVES);
    expect(toggleMove(full, 'crane')).toEqual(full); // capped — ignored
  });
});

describe('effectiveMoves', () => {
  it('prefers the new moves[] but falls back to legacy single move', () => {
    expect(effectiveMoves({ moves: ['push', 'pan'] })).toEqual(['push', 'pan']);
    expect(effectiveMoves({ move: 'static' })).toEqual(['static']);
    expect(effectiveMoves({})).toEqual([]);
  });
});

describe('buildShotPrompt — extended grammar', () => {
  it('weaves light, genre, energy, colour temp and stacked moves in order', () => {
    const p = buildShotPrompt({
      grammar: {
        size: 'cu',
        lens: '85',
        moves: ['push', 'handheld'],
        light: 'neon',
        colorTemp: 'cool',
        genre: 'noir',
        energy: 'high',
      },
      text: 'герой в переулке',
    });
    expect(p).toContain('крупный план');
    expect(p).toContain('медленный наезд камеры');
    expect(p).toContain('камера с рук');
    expect(p).toContain('неоновая подсветка');
    expect(p).toContain('нуар');
    expect(p).toContain('высокая энергия');
    expect(p.endsWith('герой в переулке')).toBe(true);
  });
});

describe('shotGrammarMetadata', () => {
  it('emits the raw ids for set dimensions only', () => {
    expect(shotGrammarMetadata({ size: 'cu', moves: ['push'], genre: 'noir' })).toEqual({
      size: 'cu',
      moves: ['push'],
      genre: 'noir',
    });
  });
  it('returns null when nothing is set', () => {
    expect(shotGrammarMetadata(undefined)).toBeNull();
    expect(shotGrammarMetadata({})).toBeNull();
  });
});
