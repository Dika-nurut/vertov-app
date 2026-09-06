/**
 * The /generate submit seam — the ONE place the final prompt is composed from
 * the user's subject text, an optionally-applied preset recipe, and a video
 * effect phrase. Kept pure (no React, no I/O) so a contract test can lock it to
 * the same spec as @seed/shared `preset-merge.test.ts`.
 *
 * A `replace`-mode (or absent) preset is never passed here — those write their
 * template straight into the textarea, so `preset` is null and the composed
 * prompt is byte-identical to plain prompting (legacy behavior preserved).
 */
import {
  mergePresetPrompt,
  type PresetMergeMode,
  type PresetSlot,
} from '@seed/shared/preset-merge';

export interface SubmitPreset {
  promptTemplate: string;
  mergeMode?: PresetMergeMode;
  slots?: PresetSlot[];
  negativePrompt?: string;
}

/**
 * Compose the prompt sent to the model.
 *
 * @param userText     the user's own subject (EN enhancement wins upstream)
 * @param preset       an applied non-replace preset, or null for plain prompting
 * @param slotValues   per-slot fills from the apply sheet (slots mode)
 * @param effectPhrase a video effect phrase folded on the end (video mode only)
 */
export function composeSubmitPrompt(args: {
  userText: string;
  preset: SubmitPreset | null;
  slotValues?: Record<string, string>;
  effectPhrase?: string;
}): string {
  const userText = (args.userText ?? '').trim();
  const base = args.preset
    ? mergePresetPrompt(
        {
          promptTemplate: args.preset.promptTemplate,
          mergeMode: args.preset.mergeMode ?? 'replace',
          slots: args.preset.slots ?? [],
        },
        userText,
        args.slotValues ?? {},
      )
    : userText;
  const effect = (args.effectPhrase ?? '').trim();
  if (!effect) return base;
  // Join the effect phrase as its own sentence so the two ideas don't run on.
  return base ? `${base}${/[.!?…]$/.test(base) ? ' ' : '. '}${effect}` : effect;
}
