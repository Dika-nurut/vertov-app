/**
 * Мир проекта = attachment buffer (owner ruling 2026-07-29; normative rule 3 of
 * docs/programs/goals/scenario-boards-integration-2026-07-27.md).
 *
 * Both switches are OFF for the MVP and the code behind them is deliberately kept
 * alive: turning accretion back on requires showing its effect on the prompt-cache
 * hit rate, and that measurement needs the code, not a git archaeology session.
 */
export const CANON_ACCRETION_ENABLED = false;
export const CANON_MANUAL_NOTES_ENABLED = true;
