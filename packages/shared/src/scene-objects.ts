import { z } from 'zod';
import { llmPricingRecord } from './llm-pricing-workbook';

const SCENE_OBJECTS_WORKBOOK = llmPricingRecord('boards_scene_objects', 'default');
export const SCENE_OBJECTS_MODEL = SCENE_OBJECTS_WORKBOOK.model;
export const SCENE_OBJECTS_VERSION = 'so-2' as const;
export const SCENE_OBJECTS_SOURCE_MAX_CHARS = 32_000 as const;
export const SCENE_OBJECTS_OUTPUT_MAX_TOKENS = SCENE_OBJECTS_WORKBOOK.maxTokenBudget.output;
export const SCENE_OBJECTS_MAX = 12 as const;

/**
 * Pricing uses the repository's fail-closed tokens ≤ UTF-8 bytes rule. A
 * maximal Russian source is approximately two bytes per stored character;
 * this allowance also covers the fixed prompt, heading, and cue wrapper.
 */
export const SCENE_OBJECTS_INPUT_MAX_BYTES = SCENE_OBJECTS_WORKBOOK.maxTokenBudget.input;

/** Finance COGS ceiling; the current product policy keeps this operation free. */
export const SCENE_OBJECTS_CEILING_CREDITS = SCENE_OBJECTS_WORKBOOK.credits;

export const sceneObjectKindSchema = z.enum(['person', 'place', 'thing']);

export const sceneObjectSchema = z
  .object({
    kind: sceneObjectKindSchema,
    name: z
      .string()
      .min(1)
      .max(80)
      .refine((value) => value.trim().length > 0),
    description: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim().length > 0)
      .refine((value) => !/[\r\n]/u.test(value)),
    quotes: z.array(z.string().min(1).max(SCENE_OBJECTS_SOURCE_MAX_CHARS)).min(1).max(3),
  })
  .strict();

/** The strict envelope emitted by the model before the server adds its hash. */
export const sceneObjectsModelResultSchema = z
  .object({ objects: z.array(sceneObjectSchema) })
  .strict();

/** The server response envelope. The source hash is always server-computed. */
export const sceneObjectsResponseSchema = z
  .object({
    objects: z.array(sceneObjectSchema).max(SCENE_OBJECTS_MAX),
    sourceHash: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceTruncated: z.boolean(),
  })
  .strict();

export type SceneObjectKind = z.infer<typeof sceneObjectKindSchema>;
export type SceneObject = z.infer<typeof sceneObjectSchema>;
export type SceneObjectsModelResult = z.infer<typeof sceneObjectsModelResultSchema>;
export type SceneObjectsResponse = z.infer<typeof sceneObjectsResponseSchema>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

// This deliberately copies the private preservesSourceText normalization from
// packages/shared/src/shot-plan.ts: whitespace-equivalent is the guarantee we
// can make for quotes, not byte-for-byte verbatim text.
function preservesSourceText(value: string, sourceText: string): boolean {
  const normalizedValue = normalizeWhitespace(value);
  return normalizedValue.length > 0 && normalizeWhitespace(sourceText).includes(normalizedValue);
}

/**
 * Ground an object's name in the quote itself, or in a small source window
 * around that quote. This rejects an invented name attached to an unrelated
 * valid quote, but cannot catch every semantic misclassification when the same
 * spelling happens to occur nearby in the source.
 */
function nameIsGrounded(name: string, quotes: readonly string[], sourceText: string): boolean {
  const normalizedName = normalizedNameValue(name);
  const normalizedSource = normalizedNameValue(normalizeWhitespace(sourceText));
  if (!normalizedName || !normalizedSource) return false;

  for (const quote of quotes) {
    const normalizedQuote = normalizedNameValue(normalizeWhitespace(quote));
    if (normalizedQuote.includes(normalizedName)) return true;

    const quoteStart = normalizedSource.indexOf(normalizedQuote);
    if (quoteStart < 0) continue;
    const contextStart = Math.max(0, quoteStart - 120);
    const contextEnd = Math.min(normalizedSource.length, quoteStart + normalizedQuote.length + 120);
    if (normalizedSource.slice(contextStart, contextEnd).includes(normalizedName)) return true;
  }

  return false;
}

function normalizedNameValue(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

/** Remove unsupported quotes and hallucinated objects without failing the batch. */
export function validateSceneObjects(
  result: SceneObjectsModelResult,
  sourceText: string,
): { objects: SceneObject[]; dropped: number } {
  const objects: SceneObject[] = [];
  let dropped = 0;

  for (const object of result.objects) {
    if (!object.name.trim() || !object.description.trim()) {
      dropped += 1;
      continue;
    }
    const quotes = object.quotes.filter((quote) => preservesSourceText(quote, sourceText));
    dropped += object.quotes.length - quotes.length;
    if (quotes.length === 0) {
      dropped += 1;
      continue;
    }
    if (!nameIsGrounded(object.name, quotes, sourceText)) {
      dropped += 1;
      continue;
    }
    if (objects.length >= SCENE_OBJECTS_MAX) {
      dropped += 1;
      continue;
    }
    objects.push({
      kind: object.kind,
      name: object.name,
      description: object.description,
      quotes,
    });
  }

  return { objects, dropped };
}

export interface ExistingCastNode {
  id: string;
  castKind: 'character' | 'location' | 'product';
  name: string;
}

/**
 * A same-name card of another kind can explain why a name needs care, but it
 * must never be a reusable choice. Deliberately omit its node id: callers
 * cannot accidentally turn explanatory data into a cross-kind link.
 */
export interface CrossKindSceneObjectCandidate {
  castKind: ExistingCastNode['castKind'];
  name: string;
}

export type SceneObjectMatch =
  | { status: 'match'; nodeId: string; crossKindCandidates?: CrossKindSceneObjectCandidate[] }
  | {
      status: 'ambiguous';
      /** IDs are exclusively same-kind cards that the author may choose between. */
      candidateIds: string[];
      crossKindCandidates?: CrossKindSceneObjectCandidate[];
    }
  | { status: 'new'; crossKindCandidates?: CrossKindSceneObjectCandidate[] };

function normalizedName(value: string): string {
  return normalizedNameValue(value);
}

export function mappedSceneObjectCastKind(kind: SceneObjectKind): ExistingCastNode['castKind'] {
  return kind === 'person' ? 'character' : kind === 'place' ? 'location' : 'product';
}

/** Stable matching key shared by extraction projection and Board-local reuse. */
export function sceneObjectKey(input: Pick<SceneObject, 'kind' | 'name'>): string {
  return `${input.kind}:${normalizedName(input.name)}`;
}

/** Associate extracted objects with existing board cards without mutating them. */
export function matchSceneObjects(
  extracted: readonly SceneObject[],
  existingCast: readonly ExistingCastNode[],
): SceneObjectMatch[] {
  return extracted.map((object) => {
    const name = normalizedName(object.name);
    const candidates = existingCast.filter((cast) => normalizedName(cast.name) === name);
    const mappedKind = mappedSceneObjectCastKind(object.kind);
    const exact = candidates.filter((cast) => cast.castKind === mappedKind);
    const crossKindCandidates = candidates
      .filter((cast) => cast.castKind !== mappedKind)
      .map(({ castKind, name: candidateName }) => ({ castKind, name: candidateName }));
    const crossKind = crossKindCandidates.length > 0 ? { crossKindCandidates } : {};

    if (exact.length > 1) {
      return {
        status: 'ambiguous',
        candidateIds: exact.map((candidate) => candidate.id),
        ...crossKind,
      };
    }
    if (exact.length === 1) return { status: 'match', nodeId: exact[0]!.id, ...crossKind };
    return { status: 'new', ...crossKind };
  });
}
