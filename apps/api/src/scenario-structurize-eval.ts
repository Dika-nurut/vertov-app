import type { ScenarioFormat, ScenarioStructurizeResult } from '@seed/shared';

/**
 * Structurization eval rubric (goal S1) — the release gate that closes the CTO
 * "production-proof" gap. Pure scoring: given a reference idea and a produced
 * {format, brief, outline}, score whether the structure is actually usable.
 *
 * The four criteria are the ones a human editor checks first (plan §6 S1):
 *   1. format guessed        — did we route to the writing lens the idea implies?
 *   2. timing sums           — do the beats' durations add up to the target?
 *   3. beats concrete        — is every beat a real event, not a placeholder?
 *   4. question discipline    — exactly ≤1 question, and only when it's needed?
 *
 * Runs zero-spend through the mock gateway on every prompt/model change; a drop
 * in the aggregate score blocks the change (see scenario-structurize-eval.test).
 */

export interface StructurizeCorpusEntry {
  id: string;
  /** The writing lens the idea should be routed to. */
  expectedFormat: ScenarioFormat;
  /** The raw idea handed to the engine. */
  idea: string;
  /** Target total duration for non-film formats (drives the timing check). */
  targetDurationSeconds?: number;
  /** True only for deliberately-underspecified ideas that SHOULD draw one question. */
  expectQuestion?: boolean;
  /**
   * A human-authored reference output (a "good answer"). In CI the mock gateway
   * replays this so the rubric + parse pipeline are locked without spend; it
   * also documents what a passing structure looks like per format.
   */
  reference: unknown;
}

export interface StructurizeScore {
  formatGuessed: boolean;
  timingSums: boolean;
  beatsConcrete: boolean;
  questionDisciplined: boolean;
  passed: boolean;
  /** Fraction of the four criteria satisfied (0..1). */
  score: number;
}

/** ±25% of target, with a 3s absolute floor for very short pieces. */
const TIMING_TOLERANCE_FRACTION = 0.25;
const TIMING_TOLERANCE_MIN_SECONDS = 3;

/**
 * Bare structural placeholders — a beat whose entire title is one of these (or
 * one of these + a number, e.g. "Сцена 2") is not a concrete event.
 */
const PLACEHOLDER_TITLES = new Set<string>([
  'начало',
  'середина',
  'конец',
  'вступление',
  'введение',
  'заключение',
  'интро',
  'аутро',
  'завязка',
  'развитие',
  'кульминация',
  'развязка',
  'финал',
  'сцена',
  'бит',
  'часть',
  'эпизод',
  'hook',
  'intro',
  'outro',
  'setup',
  'beat',
  'scene',
  'part',
  'climax',
  'ending',
  'middle',
]);

function isPlaceholderTitle(title: string): boolean {
  const normalized = title
    .toLowerCase()
    .replace(/[\s\d.:;,–—\-]+$/u, '') // strip trailing number/punctuation ("Сцена 2." → "сцена")
    .trim();
  return PLACEHOLDER_TITLES.has(normalized);
}

function checkTimingSums(
  entry: StructurizeCorpusEntry,
  result: ScenarioStructurizeResult,
): boolean {
  // Film timing is page-based/optional — not scored on duration sums.
  if (result.format === 'film') return true;
  const target = entry.targetDurationSeconds ?? result.brief.durationSeconds;
  if (!target) return true; // no target to check against
  const beats = result.outline.beats;
  if (beats.length === 0) return false;
  if (beats.some((b) => b.durationSeconds === undefined)) return false;
  const sum = beats.reduce((acc, b) => acc + (b.durationSeconds ?? 0), 0);
  const tolerance = Math.max(target * TIMING_TOLERANCE_FRACTION, TIMING_TOLERANCE_MIN_SECONDS);
  return Math.abs(sum - target) <= tolerance;
}

function checkBeatsConcrete(result: ScenarioStructurizeResult): boolean {
  const beats = result.outline.beats;
  if (beats.length < 2) return false;
  return beats.every(
    (b) =>
      b.title.trim().length > 0 && !isPlaceholderTitle(b.title) && b.summary.trim().length >= 12,
  );
}

function checkQuestionDiscipline(
  entry: StructurizeCorpusEntry,
  result: ScenarioStructurizeResult,
): boolean {
  const hasQuestion = typeof result.question === 'string' && result.question.trim().length > 0;
  // The schema already caps it at ONE; the rubric checks it appears iff needed.
  return entry.expectQuestion ? hasQuestion : !hasQuestion;
}

export function scoreStructurize(
  entry: StructurizeCorpusEntry,
  result: ScenarioStructurizeResult,
): StructurizeScore {
  const formatGuessed = result.format === entry.expectedFormat;
  const timingSums = checkTimingSums(entry, result);
  const beatsConcrete = checkBeatsConcrete(result);
  const questionDisciplined = checkQuestionDiscipline(entry, result);
  const checks = [formatGuessed, timingSums, beatsConcrete, questionDisciplined];
  const score = checks.filter(Boolean).length / checks.length;
  return {
    formatGuessed,
    timingSums,
    beatsConcrete,
    questionDisciplined,
    passed: checks.every(Boolean),
    score,
  };
}

export interface CorpusReport {
  perEntry: Array<{ id: string; score: StructurizeScore }>;
  meanScore: number;
  passRate: number;
  failures: string[];
}

/** Aggregate per-entry scores into a corpus report for the gate assertion. */
export function scoreCorpus(scored: Array<{ id: string; score: StructurizeScore }>): CorpusReport {
  const meanScore = scored.length
    ? scored.reduce((acc, s) => acc + s.score.score, 0) / scored.length
    : 0;
  const passRate = scored.length ? scored.filter((s) => s.score.passed).length / scored.length : 0;
  return {
    perEntry: scored,
    meanScore,
    passRate,
    failures: scored.filter((s) => !s.score.passed).map((s) => s.id),
  };
}
