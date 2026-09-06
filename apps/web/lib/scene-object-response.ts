import { boardSceneObjectSchema, type BoardSceneObject } from '@seed/shared/board-contract';
import {
  SCENE_OBJECTS_MAX,
  sceneObjectKey,
  sceneObjectsResponseSchema,
} from '@seed/shared/scene-objects';

export type { BoardSceneObject };

export interface ProjectedSceneObjectExtraction {
  objects: BoardSceneObject[];
  /** The exact source text hash the extraction service analysed. */
  objectsSourceHash: string;
  sourceTruncated: boolean;
}

export type MergeSceneObjectsResult =
  | { ok: true; objects: BoardSceneObject[] }
  | {
      ok: false;
      reason: 'object_limit';
      limit: number;
      required: number;
    };

function projectSceneObject(value: unknown): BoardSceneObject | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { kind?: unknown; name?: unknown; description?: unknown };
  const parsed = boardSceneObjectSchema.safeParse({
    kind: candidate.kind,
    name: candidate.name,
    ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Collapse extraction duplicates in response order. The server's extraction
 * envelope is capped at twelve, but preserving that cap here keeps a malformed
 * client response from becoming an unsaveable Scene card.
 */
function distinctSceneObjects(objects: readonly BoardSceneObject[]): BoardSceneObject[] {
  const seen = new Set<string>();
  const distinct: BoardSceneObject[] = [];
  for (const object of objects) {
    const key = sceneObjectKey(object);
    if (seen.has(key)) continue;
    seen.add(key);
    if (distinct.length >= SCENE_OBJECTS_MAX) break;
    distinct.push(object);
  }
  return distinct;
}

/** Project the extraction response into the strict, persisted chip shape. */
export function projectSceneObjects(response: unknown): BoardSceneObject[] {
  if (!Array.isArray(response)) return [];

  return distinctSceneObjects(
    response.flatMap((value) => {
      const object = projectSceneObject(value);
      return object ? [object] : [];
    }),
  );
}

/**
 * Project the complete API envelope when the caller also needs to persist the
 * source hash that makes stale-object state deterministic.
 */
export function projectSceneObjectExtraction(
  response: unknown,
): ProjectedSceneObjectExtraction | null {
  const parsed = sceneObjectsResponseSchema.safeParse(response);
  if (!parsed.success) return null;
  return {
    objects: projectSceneObjects(parsed.data.objects),
    objectsSourceHash: parsed.data.sourceHash,
    sourceTruncated: parsed.data.sourceTruncated,
  };
}

/**
 * Merge a fresh extraction over the persisted local continuity links.
 *
 * Matched records adopt the newly-grounded display fields and description, but
 * retain their Board-local cast pointer. Linked records missing from the new
 * extraction stay visible as stale rows; unlinked missing records disappear.
 * The result refuses rather than silently dropping a retained linked record if
 * the union would exceed the Scene's twelve-object contract.
 */
export function mergeSceneObjects(input: {
  existing: readonly BoardSceneObject[] | undefined;
  extracted: readonly BoardSceneObject[];
}): MergeSceneObjectsResult {
  const existing = distinctSceneObjects(input.existing ?? []);
  const extracted = distinctSceneObjects(input.extracted);
  const existingByKey = new Map(existing.map((object) => [sceneObjectKey(object), object]));
  const extractedKeys = new Set(extracted.map(sceneObjectKey));
  const merged = extracted.map((object) => {
    const existingObject = existingByKey.get(sceneObjectKey(object));
    return {
      ...object,
      ...(existingObject?.castNodeId ? { castNodeId: existingObject.castNodeId } : {}),
    };
  });
  const missingLinked = existing.filter(
    (object) => Boolean(object.castNodeId) && !extractedKeys.has(sceneObjectKey(object)),
  );
  const result = [
    ...merged,
    ...missingLinked.map((object) => ({ ...object, absentFromLatestExtraction: true })),
  ];
  if (result.length > SCENE_OBJECTS_MAX) {
    return {
      ok: false,
      reason: 'object_limit',
      limit: SCENE_OBJECTS_MAX,
      required: result.length,
    };
  }
  return { ok: true, objects: result };
}
