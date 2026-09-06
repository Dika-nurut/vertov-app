import { z } from 'zod';

/** Versioned, portable project structure for Scenario's four writing lenses. */
export const scenarioFormatSchema = z.enum(['film', 'social', 'ad', 'sketch']);
export type ScenarioFormat = z.infer<typeof scenarioFormatSchema>;

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const scenarioBriefV1Schema = z
  .object({
    version: z.literal(1),
    goal: optionalText(500),
    audience: optionalText(500),
    platform: optionalText(100),
    durationSeconds: z.number().int().positive().max(7_200).optional(),
    tone: optionalText(300),
    cta: optionalText(500),
    constraints: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    inferred: z.boolean().optional(),
  })
  .strict();
export type ScenarioBriefV1 = z.infer<typeof scenarioBriefV1Schema>;

export const scenarioBeatV1Schema = z
  .object({
    id: z.string().trim().min(1).max(128),
    kind: z.enum([
      'hook',
      'setup',
      'conflict',
      'development',
      'turn',
      'resolution',
      'cta',
      'scene',
      'custom',
    ]),
    title: z.string().trim().min(1).max(300),
    summary: z.string().trim().max(4_000),
    visual: optionalText(4_000),
    spokenText: optionalText(8_000),
    onScreenText: optionalText(2_000),
    durationSeconds: z.number().int().positive().max(7_200).optional(),
  })
  .strict();
export type ScenarioBeatV1 = z.infer<typeof scenarioBeatV1Schema>;

const SCENARIO_OUTLINE_MAX_BYTES = 100_000;
export const scenarioOutlineV1Schema = z
  .object({ version: z.literal(1), beats: z.array(scenarioBeatV1Schema).max(100) })
  .strict()
  .superRefine((value, ctx) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > SCENARIO_OUTLINE_MAX_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'outline payload too large' });
    }
  });
export type ScenarioOutlineV1 = z.infer<typeof scenarioOutlineV1Schema>;

export const EMPTY_SCENARIO_BRIEF: ScenarioBriefV1 = { version: 1 };
export const EMPTY_SCENARIO_OUTLINE: ScenarioOutlineV1 = { version: 1, beats: [] };

/** A raw idea fed to structurization is capped at this many chars (goal S1). */
export const STRUCTURIZE_SOURCE_MAX_CHARS = 8_000;

/**
 * The validated result of one structurization: a chosen writing lens, an
 * editable brief, and the ordered beats — the exact shape every visual unit
 * downstream consumes. `question` is at most ONE clarifying question and only
 * appears when a missing fact materially changes the structure (decision #3);
 * it is NOT persisted into the project, only surfaced beside the structure.
 * The raw model JSON is never exposed — callers return this validated object.
 */
export const scenarioStructurizeResultSchema = z
  .object({
    format: scenarioFormatSchema,
    brief: scenarioBriefV1Schema,
    outline: scenarioOutlineV1Schema,
    question: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A structurization MUST produce at least one beat. The base outline schema
    // allows an empty `beats` (create-on-intent starts a project with none), but
    // a structurize RESULT with no beats is a degraded/empty model answer — a
    // reply like `{ "format": "film" }` must never be treated as a usable, paid
    // result. Rejecting it here routes the call through retry → refund.
    if (value.outline.beats.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outline', 'beats'],
        message: 'structurization produced no beats',
      });
    }
  });
export type ScenarioStructurizeResult = z.infer<typeof scenarioStructurizeResultSchema>;
