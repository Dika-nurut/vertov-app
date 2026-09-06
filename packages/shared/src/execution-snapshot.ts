import { z } from 'zod';

/**
 * Immutable product/routing facts captured before a paid job enters the queue.
 *
 * v2 drops `model.creditCostPerUnit` (the legacy catalog ceiling): it was never
 * read downstream of the snapshot — settlement locks on `job.creditUnitCost` /
 * `quotedCredits`, pricing resolves from workbook rows. v1 rows may still be in
 * flight at rollout, so the worker parses both: `parseExecutionSnapshot` treats
 * the field as tolerated-but-ignored when present.
 */
export const EXECUTION_SNAPSHOT_VERSION = 2 as const;

/**
 * The v1 model block, for in-flight jobs written before the ceiling purge. Same
 * shape as v2 plus the mandatory `creditCostPerUnit` ceiling.
 */
const executionModelV1Schema = z
  .object({
    kind: z.enum(['image', 'image-edit', 'video', 'voice']),
    provider: z.enum(['byteplus', 'volcengine', 'yandex', 'stub']),
    providerModelId: z.string().min(1),
    providerEndpoint: z.string().min(1),
    gatewayOverride: z.string().min(1).nullable(),
    fallbackGateway: z.string().min(1).nullable(),
    capabilities: z.record(z.unknown()),
    creditCostPerUnit: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive().nullable(),
    pricing: z
      .object({
        source: z.string().min(1),
        imageUnitCredits: z.number().int().positive().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

const executionModelSchema = executionModelV1Schema.omit({ creditCostPerUnit: true });

export const executionSnapshotSchema = z
  .object({
    snapshotVersion: z.literal(EXECUTION_SNAPSHOT_VERSION),
    model: executionModelSchema,
    /** The post-routing gateway chosen by the API, before any worker mock override. */
    effectiveGateway: z.string().min(1).nullable(),
    validatedRequest: z
      .object({
        prompt: z.string().min(1),
        params: z.record(z.unknown()),
        referenceAssets: z.array(z.string()),
      })
      .strict(),
    unitsBreakdown: z
      .object({
        units: z.number().int().positive(),
        imageUnitCredits: z.number().int().positive().nullable(),
        referenceCount: z.number().int().nonnegative(),
      })
      .strict(),
    quotedCredits: z.number().int().positive(),
  })
  .strict();

export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;

const executionSnapshotV1Schema = executionSnapshotSchema.extend({
  snapshotVersion: z.literal(1),
  model: executionModelV1Schema,
});

/** A v1 row parses back into the current shape once the ceiling is dropped. */
const normalizeV1 = (v1: z.infer<typeof executionSnapshotV1Schema>): ExecutionSnapshot => {
  const { creditCostPerUnit: _creditCostPerUnit, ...model } = v1.model;
  return { ...v1, snapshotVersion: EXECUTION_SNAPSHOT_VERSION, model };
};

/**
 * Parse a stored snapshot, accepting both the current version and v1 rows that
 * were already in flight when the ceiling field was dropped. Returns the
 * version-normalized v2 shape on success (v1's `creditCostPerUnit` is consumed
 * by the parse and never surfaces), or the Zod error either schema produced —
 * a corrupt row must still fail loudly.
 */
export function parseExecutionSnapshot(
  value: unknown,
): { ok: true; snapshot: ExecutionSnapshot } | { ok: false; error: z.ZodError } {
  const v2 = executionSnapshotSchema.safeParse(value);
  if (v2.success) return { ok: true, snapshot: v2.data };
  const v1 = executionSnapshotV1Schema.safeParse(value);
  if (v1.success) return { ok: true, snapshot: normalizeV1(v1.data) };
  // Prefer the v2 issues: they describe what the CURRENT contract wants, which
  // is what an operator debugging a corrupt row needs to see.
  return { ok: false, error: v2.error };
}
