import { describe, expect, it } from 'vitest';
import { TRANSFORMS, TRANSFORM_ORDER, transformPrompt, type TransformKind } from './transforms';

describe('TRANSFORMS catalog', () => {
  it('every transform has a label; ref-transforms carry an instruction', () => {
    for (const k of Object.keys(TRANSFORMS) as TransformKind[]) {
      const t = TRANSFORMS[k];
      expect(t.label.length).toBeGreaterThan(0);
      if (t.usesSourceRef) expect(t.instruction.length).toBeGreaterThan(0);
    }
  });
  it('exposes restyle/relight/environment as the menu order', () => {
    expect(TRANSFORM_ORDER).toEqual(['restyle', 'relight', 'environment']);
  });
});

describe('transformPrompt', () => {
  it('appends the steering instruction to a base prompt', () => {
    expect(transformPrompt('restyle', 'кот на крыше')).toBe(
      'кот на крыше. сохрани композицию и объект, измени стиль и фактуру',
    );
  });
  it('uses the instruction alone when the base is empty', () => {
    expect(transformPrompt('relight', '   ')).toBe(TRANSFORMS.relight.instruction);
  });
  it('does not double-append if the instruction is already present', () => {
    const once = transformPrompt('environment', 'сцена');
    expect(transformPrompt('environment', once)).toBe(once);
  });
  it('extend has no instruction — returns the base unchanged', () => {
    expect(transformPrompt('extend', 'кадр')).toBe('кадр');
  });
});
