/**
 * Preset prompt-merge engine — the single mechanic behind "presets".
 *
 * A preset is a saved config bundle (see research/archive/presets-real-product-plan-2026-07-01.md
 * §1). At submit time we composite the preset's curated prompt scaffold around the
 * user's own subject. This module is the ONE place that decides how they merge, so the
 * API prefill preview and the actual job submission never drift apart.
 *
 * Pure functions only — no I/O, no DB. Fully unit-testable.
 */

/** How the preset's promptTemplate combines with the user's free-text prompt. */
export type PresetMergeMode = 'replace' | 'prefix' | 'suffix' | 'slots';

/** A single fillable slot in a `slots`-mode template ({key} in the template). */
export interface PresetSlot {
  key: string;
  label: string;
  required?: boolean;
  default?: string;
  placeholder?: string;
}

export interface PresetPromptSpec {
  promptTemplate: string;
  /** Defaults to 'replace' for legacy full-string packs (byte-for-byte unchanged). */
  mergeMode?: PresetMergeMode;
  slots?: PresetSlot[];
}

/** Collapse doubled spaces and orphaned/duplicated commas left by empty slots. */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*(?=,)/g, '') // drop a comma immediately followed by another
    .replace(/,\s*,/g, ', ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/(^[\s,]+)|([\s,]+$)/g, '') // trim leading/trailing spaces+commas
    .trim();
}

/**
 * Compute the final prompt sent to the model.
 *
 * @param spec       the preset's template + merge mode + slot definitions
 * @param userText   the user's free-text prompt (the visible textarea)
 * @param slotValues per-slot fills from the apply form (slots mode only)
 */
export function mergePresetPrompt(
  spec: PresetPromptSpec,
  userText = '',
  slotValues: Record<string, string> = {},
): string {
  const template = spec.promptTemplate ?? '';
  const user = (userText ?? '').trim();
  const mode: PresetMergeMode = spec.mergeMode ?? 'replace';
  const slots = spec.slots ?? [];

  switch (mode) {
    case 'replace':
      // Legacy scene packs: the preset IS the prompt; user text is ignored.
      return template.trim();

    case 'prefix':
      // Style scaffold leads, user's subject trails.
      return user ? tidy(`${template}, ${user}`) : template.trim();

    case 'suffix':
      // Legacy motion packs: user's subject leads, camera/effect phrase trails.
      return user ? tidy(`${user}, ${template}`) : template.trim();

    case 'slots': {
      const filled = template.replace(/\{(\w+)\}/g, (_, key: string) => {
        const provided = slotValues[key]?.trim();
        if (provided) return provided;
        const slot = slots.find((s) => s.key === key);
        if (slot?.default?.trim()) return slot.default.trim();
        // Convenience: a single-slot preset with a raw user prompt and no form fill
        // drops the whole prompt into that slot (the Higgsfield "just type it" path).
        if (slots.length === 1 && user) return user;
        return '';
      });
      return tidy(filled);
    }
  }
}

/**
 * Validate that every required slot is satisfiable before submit, so a half-baked
 * "{subject}" never reaches the model. Returns the list of unfilled required slot keys
 * (empty = ok to submit). Mirrors the single-slot convenience of mergePresetPrompt.
 */
export function unfilledRequiredSlots(
  spec: PresetPromptSpec,
  userText = '',
  slotValues: Record<string, string> = {},
): string[] {
  if ((spec.mergeMode ?? 'replace') !== 'slots') return [];
  const slots = spec.slots ?? [];
  const user = (userText ?? '').trim();
  const singleSlotSatisfiedByUser = slots.length === 1 && !!user;
  return slots
    .filter((s) => s.required)
    .filter((s) => {
      if (slotValues[s.key]?.trim()) return false;
      if (s.default?.trim()) return false;
      if (singleSlotSatisfiedByUser) return false;
      return true;
    })
    .map((s) => s.key);
}
