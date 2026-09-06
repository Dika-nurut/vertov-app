import { z } from 'zod';

export const GENERATION_PARAMS_MAX_BYTES = 32_768;

export const generationGatewaySchema = z.enum(['evolink', 'atlascloud', 'openrouter']);
export const generationRequestSourceSchema = z.enum(['generate', 'boards']);

export const generationParamsSchema = z
  .record(z.unknown())
  .default({})
  .refine(
    (value) => JSON.stringify(value).length <= GENERATION_PARAMS_MAX_BYTES,
    'params payload too large',
  );

/**
 * The quote and submit endpoints consume this exact core. Submit adds only its
 * idempotency key; every price-affecting or provider-affecting field lives here.
 */
export const generationJobRequestSchema = z
  .object({
    modelId: z.string().min(1).max(160),
    prompt: z.string().min(1).max(8_000),
    params: generationParamsSchema,
    referenceAssets: z.array(z.string().url()).max(8).default([]),
    provider: generationGatewaySchema.optional(),
    source: generationRequestSourceSchema.default('generate'),
  })
  .strict();

/**
 * The estimate body. Same shape as a submit minus the idempotency key, plus one
 * field a submit must never carry.
 *
 * `pendingReferenceCount` exists because a board quote is taken BEFORE the graph
 * runs. In a Run All where shot B takes shot A's output as a reference, A has not
 * rendered when B is quoted, so B's reference list is one short — and once the
 * reference COUNT is a price dimension, that is a quote the submit cannot match:
 * `expectedCost` refuses it with `quote_stale`, and retrying re-takes the same
 * pre-run snapshot and refuses again. A placeholder URL is not the fix — quoting a
 * reference we never send is the same divergence pointing the other way. The count
 * is: it says «this many more references will exist», which is exactly what the
 * price depends on and all the caller can honestly know.
 *
 * It is on the ESTIMATE only. At submit the references are real and countable, so
 * accepting a caller-supplied count there would be a way to buy a cheaper band.
 */
export const generationJobEstimateSchema = generationJobRequestSchema
  .extend({
    pendingReferenceCount: z.number().int().min(0).max(16).optional(),
  })
  .strict();

export const generationJobSubmitSchema = generationJobRequestSchema
  .extend({
    idempotencyKey: z.string().min(8).max(128),
    projectId: z.string().min(1).max(160).optional(),
    // Optional provenance; NOT part of the quote identity.
    presetSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9-]+$/, 'invalid preset slug')
      .optional(),
    /**
     * Quote binding: the price the user was actually shown, from the last
     * `/v1/jobs/estimate` for THIS configuration. Submit resolves the price
     * itself and charges its own number — this field is never trusted as a
     * price, only compared against one. A mismatch means the catalogue moved
     * between quote and submit, and the job is refused (`quote_stale`) rather
     * than charged at a number the user never saw.
     */
    expectedCost: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

export type GenerationJobRequest = z.infer<typeof generationJobRequestSchema>;
export type GenerationJobEstimate = z.infer<typeof generationJobEstimateSchema>;
export type GenerationJobSubmit = z.infer<typeof generationJobSubmitSchema>;

/**
 * Every `params` key the platform is known to read — the vocabulary for tightening
 * the currently-unrestricted `generationParamsSchema` (execution plan DoD 6). A hard
 * `.strict()` reject would break legacy drafts / reuse-job payloads that carry a key
 * this list missed, so the tightening rolls out LOG-FIRST: `unknownGenerationParamKeys`
 * surfaces would-be-rejected keys for the routes to log, and only once real traffic
 * shows the list is complete does the reject flip on. Sourced by auditing every
 * `params[...]` read across apps/api, apps/worker, apps/web, and packages/*.
 */
export const KNOWN_GENERATION_PARAM_KEYS: ReadonlySet<string> = new Set([
  // Contract params (registry-owned)
  'resolution',
  'aspect_ratio',
  'duration_seconds',
  'generate_audio',
  'n',
  'seed',
  // Legacy Generate aliases (size = ratio, quality = image tier)
  'size',
  'quality',
  // Conditioning / references (reference_image_urls is constructed internally by the
  // kie adapter from imageUrls — it is NOT a client request key, so it is excluded)
  'imageUrls',
  'videoUrls',
  'audioUrls',
  'frameImages',
  // Vendor passthrough levers (some dead per-route — DoD 4 tracks those)
  'negative_prompt',
  'cfg_scale',
  'prompt_extend',
  // Video-input / misc knobs
  'inputDurationSeconds',
  'return_last_frame',
  'shotGrammar',
  // Active production request knobs (frontend-written, adapter-read)
  'watermark',
  'webSearch',
  // Routing sentinels (internal)
  '__gateway',
  '__mock',
]);

/**
 * The `params` keys NOT in the known vocabulary — the log-first signal for the DoD 6
 * schema tightening. Empty for a well-formed request; a non-empty result is what the
 * estimate/submit routes log (and, once the vocabulary is proven complete, reject).
 */
export function unknownGenerationParamKeys(params: Record<string, unknown>): string[] {
  return Object.keys(params).filter((key) => !KNOWN_GENERATION_PARAM_KEYS.has(key));
}

export interface UnitsForGenerationModelInput {
  kind: string;
  params: Record<string, unknown>;
  maxDurationSeconds: number | null;
  /**
   * Vendor floor — the minimum billable clip length. A crafted request for
   * `duration_seconds:1` on a model whose vendor snaps to (and bills) a 4-second
   * minimum must be billed for at least 4 seconds, or we eat the difference. The
   * Board UI already snaps duration to an allowed step, but a direct API POST
   * bypasses that, so the floor is enforced here on the shared charge path.
   */
  minDurationSeconds?: number | null;
}

export type UnitsForGenerationModelResult =
  | { ok: true; units: number }
  | { ok: false; error: string };

/** One billing-unit rule shared by local Board quotes and both API endpoints. */
export function unitsForGenerationModel(
  input: UnitsForGenerationModelInput,
): UnitsForGenerationModelResult {
  if (input.kind === 'video') {
    const duration = Number(input.params['duration_seconds']);
    if (!Number.isFinite(duration) || duration <= 0) {
      return { ok: false, error: 'duration_seconds_required' };
    }
    let units = Math.ceil(duration);
    // Vendor floor first: never bill below the model's minimum billable clip.
    const min = input.minDurationSeconds;
    if (min != null && Number.isFinite(min) && min > 0 && units < min) {
      units = Math.ceil(min);
    }
    // Then the vendor ceiling caps the billed seconds.
    const rawCap = input.maxDurationSeconds;
    if (rawCap !== null && rawCap > 0 && units > rawCap) {
      units = rawCap;
    }
    return { ok: true, units };
  }
  // Images: `n` generated images, floored at 1. Non-finite or unsafe counts from
  // crafted params collapse to 1 so arithmetic cannot overflow the ledger.
  const count = Number(input.params['n']);
  const rounded = Math.ceil(count);
  return {
    ok: true,
    units: Number.isSafeInteger(rounded) && rounded > 0 ? rounded : 1,
  };
}
