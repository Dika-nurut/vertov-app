/**
 * In-context shot transformations (B-7). Each transform re-runs generation from
 * an existing result instead of a blank prompt: the source asset is reused as a
 * reference and a steering instruction is appended, so the user transforms a
 * shot without rebuilding prompt/settings. Each transform is a NEW job (own
 * reserve/refund via B-0), so the original asset is never mutated.
 *
 * Pure (no I/O) → unit-tested; the Generate client wires the prep + lineage.
 */

export type TransformKind = 'extend' | 'restyle' | 'relight' | 'environment';

export interface TransformDef {
  kind: TransformKind;
  label: string;
  /** RU instruction appended to the prompt to steer the transform. */
  instruction: string;
  /** Reuse the source asset as an image reference (false = last-frame extend). */
  usesSourceRef: boolean;
}

export const TRANSFORMS: Record<TransformKind, TransformDef> = {
  extend: { kind: 'extend', label: 'Продолжить', instruction: '', usesSourceRef: false },
  restyle: {
    kind: 'restyle',
    label: 'Рестайл',
    instruction: 'сохрани композицию и объект, измени стиль и фактуру',
    usesSourceRef: true,
  },
  relight: {
    kind: 'relight',
    label: 'Свет',
    instruction: 'сохрани сцену и объект, измени освещение и атмосферу',
    usesSourceRef: true,
  },
  environment: {
    kind: 'environment',
    label: 'Окружение',
    instruction: 'сохрани главный объект, измени окружение и фон',
    usesSourceRef: true,
  },
};

export const TRANSFORM_ORDER: TransformKind[] = ['restyle', 'relight', 'environment'];

/** Append the transform's steering instruction to a base prompt (dedup, trim). */
export function transformPrompt(kind: TransformKind, base: string): string {
  const instr = TRANSFORMS[kind].instruction;
  const b = base.trim();
  if (!instr) return b;
  if (b.toLowerCase().includes(instr.toLowerCase())) return b;
  return b ? `${b}. ${instr}` : instr;
}
