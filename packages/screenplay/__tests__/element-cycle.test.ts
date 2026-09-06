import { describe, expect, it } from 'vitest';
import type { ElementType } from '../src/model.js';
import { parseFountain } from '../src/fountain/parse.js';
import { serializeFountain } from '../src/fountain/serialize.js';
import {
  ELEMENT_CYCLE,
  bareLineText,
  cycleLineElement,
  nextElement,
  setLineElement,
} from '../src/element-cycle.js';

/**
 * Guard tests for Tab element cycling — the spec (§3) requires these to pass
 * BEFORE the keymap ships. Two properties matter:
 *   1. classification: the produced line parses as the intended type;
 *   2. round-trip: any produced line survives serialize(parse(x)) === x.
 * Byte-fidelity (2) is free from the line-lossless parser, but we assert it
 * anyway so a future parser change can't silently break the keymap.
 */

/** Parse `line` inside a minimal context and return the type it classifies as. */
function typeInContext(line: string, context: 'standalone' | 'in-dialogue'): ElementType {
  const doc =
    context === 'in-dialogue'
      ? parseFountain(`ИНТ. КОМНАТА - ДЕНЬ\n\nМАРК\n${line}\n`)
      : parseFountain(`Раньше было действие.\n\n${line}\n\nПотом ещё действие.\n`);
  // The element carrying our line is the one whose raw contains it.
  const el = doc.elements.find((e) => e.raw.some((r) => r.trim() === line.trim()));
  return el?.type ?? 'action';
}

describe('bareLineText — strips every forced marker', () => {
  it.each([
    ['@МАРК', 'МАРК'],
    ['@Максим ^', 'Максим'],
    ['.ИНТ. КУХНЯ - НОЧЬ', 'ИНТ. КУХНЯ - НОЧЬ'],
    ['> ЗАТЕМНЕНИЕ.', 'ЗАТЕМНЕНИЕ.'],
    ['> КОНЕЦ <', 'КОНЕЦ'],
    ['(тихо)', 'тихо'],
    ['!ТИТР: три года', 'ТИТР: три года'],
    ['~Песня', 'Песня'],
    ['  Обычное действие.  ', 'Обычное действие.'],
  ])('%s → %s', (line, bare) => {
    expect(bareLineText(line)).toBe(bare);
  });
});

describe('setLineElement — forced types land on a blank-separated line', () => {
  // Fountain rule: inside a dialogue block (a line directly under a character
  // cue, no blank) EVERY line is dialogue — forced markers included. So the
  // forced types are deterministic for a normal, blank-separated line; the
  // live ribbon classifier reports the truth honestly in either case.
  const bare = 'Плёнка не врёт';
  it('scene_heading is forced and lands', () => {
    expect(typeInContext(setLineElement(bare, 'scene_heading'), 'standalone')).toBe(
      'scene_heading',
    );
  });
  it('a forced scene heading is NOT honoured inside a dialogue block (block wins)', () => {
    expect(typeInContext(setLineElement(bare, 'scene_heading'), 'in-dialogue')).toBe('dialogue');
  });
  it('character is forced and lands even for a lowercase name', () => {
    expect(typeInContext(setLineElement('лида', 'character'), 'standalone')).toBe('character');
  });
  it('transition is forced and lands', () => {
    expect(typeInContext(setLineElement('НАРЕЗКА', 'transition'), 'standalone')).toBe('transition');
  });
});

describe('setLineElement — contextual types land in the right block', () => {
  it('dialogue classifies as dialogue under a character cue', () => {
    const line = setLineElement('Плёнка не врёт', 'dialogue');
    expect(typeInContext(line, 'in-dialogue')).toBe('dialogue');
  });
  it('parenthetical classifies as parenthetical under a character cue', () => {
    const line = setLineElement('тихо', 'parenthetical');
    expect(typeInContext(line, 'in-dialogue')).toBe('parenthetical');
  });
  it('action stays action, forcing all-caps text so it is not read as a cue', () => {
    expect(typeInContext(setLineElement('обычная строка', 'action'), 'standalone')).toBe('action');
    expect(typeInContext(setLineElement('ГРОМКО', 'action'), 'standalone')).toBe('action');
  });
});

describe('nextElement / cycleLineElement — the visible cycle order', () => {
  it('advances действие → персонаж → реплика → ремарка → переход → сцена → действие', () => {
    const order: ElementType[] = [
      'action',
      'character',
      'dialogue',
      'parenthetical',
      'transition',
      'scene_heading',
      'action',
    ];
    for (let i = 0; i < order.length - 1; i++) {
      expect(nextElement(order[i]!)).toBe(order[i + 1]!);
    }
  });

  it('preserves the bare text through a full cycle', () => {
    let line = 'Плёнка не врёт';
    let type: ElementType = 'action';
    for (let i = 0; i < ELEMENT_CYCLE.length; i++) {
      const r = cycleLineElement(line, type);
      expect(bareLineText(r.line)).toBe('Плёнка не врёт');
      line = r.line;
      type = r.type;
    }
    // Back to the start of the cycle.
    expect(type).toBe('action');
  });
});

describe('round-trip fidelity — any cycled line survives serialize(parse(x))', () => {
  it('holds when a line inside a real script is retyped to each element', () => {
    const base = [
      'ИНТ. КИНОБУДКА - НОЧЬ',
      '',
      'МАРК',
      'Плёнка не врёт.',
      '',
      'Проектор гудит.',
      '',
    ];
    const lineIdx = 3; // "Плёнка не врёт."
    for (const target of ELEMENT_CYCLE) {
      const lines = [...base];
      lines[lineIdx] = setLineElement(lines[lineIdx]!, target);
      const doc = lines.join('\n');
      expect(serializeFountain(parseFountain(doc))).toBe(doc);
    }
  });
});
