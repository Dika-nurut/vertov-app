import { describe, expect, it } from 'vitest';
import {
  buildSceneNav,
  moveScene,
  sceneAtOffset,
  formatTiming,
} from '../app/scenario/scenario-nav';

const SCRIPT = [
  'ИНТ. КИНОБУДКА - НОЧЬ',
  '',
  '= Марк отказывается сдать плёнку.',
  '',
  'Тесная будка. Гудит проектор.',
  '',
  'НАТ. КРЫША - НОЧЬ',
  '',
  'Ветер гонит афиши.',
  '',
  'ИНТ. ФОЙЕ - УТРО',
  '',
  'Пустое фойе.',
  '',
].join('\n');

describe('buildSceneNav', () => {
  it('lists scenes in order with headings, synopsis (= line) and a duration', () => {
    const nav = buildSceneNav(SCRIPT);
    expect(nav.map((s) => s.heading)).toEqual([
      'ИНТ. КИНОБУДКА - НОЧЬ',
      'НАТ. КРЫША - НОЧЬ',
      'ИНТ. ФОЙЕ - УТРО',
    ]);
    expect(nav[0]!.synopsis).toBe('Марк отказывается сдать плёнку.');
    expect(nav[1]!.synopsis).toBeNull();
    for (const s of nav) expect(s.duration).toMatch(/^\d+:\d{2}$/);
    // offsets: slicing [from,to) starts at the heading
    expect(SCRIPT.slice(nav[0]!.from).startsWith('ИНТ. КИНОБУДКА')).toBe(true);
    expect(SCRIPT.slice(nav[1]!.from).startsWith('НАТ. КРЫША')).toBe(true);
  });

  it('is empty for a script with no scene headings', () => {
    expect(buildSceneNav('Просто текст.\nБез сцен.\n')).toEqual([]);
  });
});

describe('sceneAtOffset', () => {
  it('maps a caret offset to the enclosing scene (1-based; 0 if none)', () => {
    const nav = buildSceneNav(SCRIPT);
    expect(sceneAtOffset(nav, 0)).toBe(1);
    expect(sceneAtOffset(nav, nav[1]!.from + 2)).toBe(2);
    expect(sceneAtOffset(nav, SCRIPT.length - 1)).toBe(3);
    expect(sceneAtOffset([], 5)).toBe(0);
  });
});

describe('moveScene', () => {
  it('reorders scene blocks and preserves every scene, re-parseable', () => {
    const moved = moveScene(SCRIPT, 3, 1); // ФОЙЕ to the top
    const nav = buildSceneNav(moved);
    expect(nav.map((s) => s.heading)).toEqual([
      'ИНТ. ФОЙЕ - УТРО',
      'ИНТ. КИНОБУДКА - НОЧЬ',
      'НАТ. КРЫША - НОЧЬ',
    ]);
    // no content lost
    expect(moved).toContain('Пустое фойе.');
    expect(moved).toContain('Ветер гонит афиши.');
    expect(moved).toContain('Марк отказывается сдать плёнку.');
  });

  it('is a no-op for invalid / equal indices', () => {
    expect(moveScene(SCRIPT, 2, 2)).toBe(SCRIPT);
    expect(moveScene(SCRIPT, 0, 1)).toBe(SCRIPT);
    expect(moveScene(SCRIPT, 1, 9)).toBe(SCRIPT);
  });
});

describe('formatTiming', () => {
  it('renders M:SS', () => {
    expect(formatTiming(0)).toBe('0:00');
    expect(formatTiming(0.5)).toBe('0:30');
    expect(formatTiming(1)).toBe('1:00');
  });
});
