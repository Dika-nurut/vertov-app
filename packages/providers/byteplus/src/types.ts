import { z } from 'zod';

// TODO(w2): #16 — 'voice' is declared but unsupported by both adapters;
// either ship a serializer or drop it from the union.
export type ModelKind = 'image' | 'image-edit' | 'video' | 'voice';

export interface WorkflowSpec {
  modelId: string;
  /**
   * The `jobs.id` this generation belongs to, set by the worker. Optional
   * because probe scripts and unit fixtures build specs without one — but a leg
   * that books money against a budget (the official-OpenRouter last resort)
   * REFUSES a spec without it: a reservation nothing can settle would hold
   * budget forever.
   */
  jobId?: string;
  providerModelId: string;
  providerEndpoint: string;
  kind: ModelKind;
  prompt: string;
  params: Record<string, unknown>;
  referenceAssets: string[];
  /** maxDurationSeconds from the model row, only meaningful for kind=video. */
  maxDurationSeconds?: number | null;
  /**
   * The model row's `capabilities` bag (option space synced from OpenRouter:
   * `resolutions`, `aspect_ratios`, `durations`, `audio`, `frames`, …). The
   * OpenRouter adapter reads it to clamp the wire body to THIS engine's real
   * schema instead of the Seedance constants. Absent/empty → Seedance defaults.
   */
  capabilities?: Record<string, unknown> | null;
  /** Worker-only context used to make the attempt journal row address the exact cost leg. */
  attemptContext?: {
    legIdentity?: string;
    rung?: string;
    role?: 'primary' | 'fallback';
    units?: number;
    configuredExpectedCostRub?: number;
    revenueRub?: number;
    legs?: Readonly<
      Record<
        string,
        {
          legIdentity: string;
          rung: string;
          role: 'primary' | 'fallback';
          units: number;
          configuredExpectedCostRub: number;
          revenueRub: number;
          vendorRubPerUsd: number;
        }
      >
    >;
  };
}

export interface WorkflowFrameImage {
  role: 'first' | 'last';
  url: string;
}

export interface WorkflowImageControls {
  aspectRatio?: string;
  // '3K' entered the enum with Seedream 5.0 Lite (kie quality high = 3K).
  resolution?: '1K' | '2K' | '3K' | '4K';
  count: number;
}

/** Read the normalized Board image fields while retaining compatibility with
 * older Generate jobs that used size=<ratio> and quality=<resolution tier>. */
export function workflowImageControls(spec: WorkflowSpec): WorkflowImageControls {
  const p = spec.params;
  const ratioCandidate =
    typeof p['aspect_ratio'] === 'string'
      ? p['aspect_ratio']
      : typeof p['size'] === 'string' && /^\d+:\d+$/.test(p['size'])
        ? p['size']
        : undefined;
  const resolutionCandidate = [p['resolution'], p['quality'], p['size']].find(
    (value): value is string =>
      typeof value === 'string' && ['1K', '2K', '3K', '4K'].includes(value.toUpperCase()),
  );
  const rawCount = typeof p['n'] === 'number' && Number.isFinite(p['n']) ? p['n'] : 1;
  return {
    ...(ratioCandidate ? { aspectRatio: ratioCandidate } : {}),
    ...(resolutionCandidate
      ? { resolution: resolutionCandidate.toUpperCase() as '1K' | '2K' | '3K' | '4K' }
      : {}),
    // ceil (matching billing's unitsForGenerationModel = ceil(n)) so a crafted
    // fractional n=1.4 SERVES 2 images as billed, not round's 1 (billed==served).
    // Integer n (all real UI traffic) is unchanged since ceil==round there.
    count: Math.max(1, Math.ceil(rawCount)),
  };
}

/**
 * Read the normalized frame-role contract, with an ordered imageUrls fallback
 * for legacy Generate jobs created before Boards emitted typed frameImages.
 */
export function workflowFrameImages(spec: WorkflowSpec): WorkflowFrameImage[] {
  const explicit = spec.params['frameImages'];
  if (Array.isArray(explicit)) {
    const result: WorkflowFrameImage[] = [];
    const seen = new Set<WorkflowFrameImage['role']>();
    for (const value of explicit) {
      if (!value || typeof value !== 'object') continue;
      const role = 'role' in value ? value.role : undefined;
      const url = 'url' in value ? value.url : undefined;
      if (
        (role !== 'first' && role !== 'last') ||
        typeof url !== 'string' ||
        !url ||
        seen.has(role)
      ) {
        continue;
      }
      seen.add(role);
      result.push({ role, url });
    }
    return result;
  }

  const rawUrls = spec.params['imageUrls'];
  const urls = Array.isArray(rawUrls)
    ? rawUrls.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : spec.referenceAssets.filter((value) => !/\.(mp4|mov|webm)(\?|$)/i.test(value));
  const declared = spec.capabilities?.['frames'];
  const roles = Array.isArray(declared)
    ? declared.filter(
        (value): value is WorkflowFrameImage['role'] => value === 'first' || value === 'last',
      )
    : (['first', 'last'] as const);
  return urls.slice(0, roles.length).map((url, index) => ({ role: roles[index]!, url }));
}

/** Returned by `generate()` — opaque ID the adapter uses to resolve the result. */
export interface GenerationHandle {
  providerJobId: string;
  /**
   * Registry key of the gateway that created this handle (see `getAdapter` in
   * index.ts). The worker persists it alongside `providerJobId` so a BullMQ
   * retry resumes the handle through the SAME vendor that minted it — never the
   * gateway that current routing happens to resolve to. Set by each concrete
   * adapter's `generate()`; wrapper adapters pass the inner adapter's value
   * through untouched.
   */
  gateway?: string;
  /** Durable attempt row that accepted this handle, when journaling is enabled. */
  attemptId?: string;
  /** True for sync image responses where the result is already attached. */
  inlineResult?: GenerationResult;
}

export interface GenerationAsset {
  bytes: Buffer;
  contentType: string;
  /** Suggested extension WITHOUT leading dot — used to build the MinIO key. */
  extension: string;
  /**
   * M-1: the provider flagged THIS asset as NSFW (e.g. AtlasCloud's
   * `has_nsfw_contents[i]`). The model's own self-moderation signal — we don't
   * block on it (that would over-block legitimate adult/edgy work), we record it
   * so the worker can tag the gallery item and curation keeps it off /showcase.
   */
  nsfw?: boolean;
}

export interface GenerationResult {
  assets: GenerationAsset[];
  /** Optional per-call provider metadata (seed, model version, etc.). */
  meta?: Record<string, unknown>;
}

export interface ProviderAdapter {
  /** Submit a job. For sync image kinds, result is attached to handle. */
  generate(spec: WorkflowSpec): Promise<GenerationHandle>;
  /** Resolve a handle to its terminal result. May poll. */
  awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(opts: { code: string; status: number; retryable: boolean; message: string }) {
    super(opts.message);
    this.name = 'ProviderError';
    this.code = opts.code;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

/**
 * The provider package deliberately knows only this narrow port. The worker
 * owns its implementation (and its database transaction); adapters never
 * import Drizzle or a worker module. A row is created before `generate()` and
 * the accepted provider id is durable before the handle leaves this seam.
 */
export interface AttemptJournalPort {
  beginAttempt(input: {
    jobId: string;
    gateway: string;
    legIdentity?: string;
    modelId?: string;
    rung?: string;
    role?: 'primary' | 'fallback';
    units?: number;
    configuredExpectedCostRub?: number;
    revenueRub?: number;
  }): Promise<{ attemptId: string }>;
  recordAccepted(input: {
    attemptId: string;
    gateway: string;
    providerJobId: string;
  }): Promise<void>;
  recordDefinitiveFailure(input: { attemptId: string; error: unknown }): Promise<void>;
  recordAmbiguous(input: { attemptId: string; error: unknown }): Promise<void>;
  recordOutcome?(input: {
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    vendorReportedCostRub?: number | null;
    revenueRub?: number | null;
    costSource?: 'invoiced' | 'configured';
    costNote?: string | null;
    resolvedAt?: Date;
  }): Promise<void>;
}

/** The only submit outcomes this code is allowed to treat as certainly unbilled. */
export const PROVABLY_UNBILLED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 413, 422, 429,
]);

export function isProvablyUnbilledProviderError(error: unknown): boolean {
  return error instanceof ProviderError && PROVABLY_UNBILLED_STATUSES.has(error.status);
}

/**
 * A provider may have accepted the request even though its response never
 * reached us. This is intentionally non-retryable: retrying it is the
 * duplicate-charge path the durable attempt journal exists to prevent.
 */
export class AmbiguousSubmitError extends ProviderError {
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    const message = originalError instanceof Error ? originalError.message : String(originalError);
    const status = originalError instanceof ProviderError ? originalError.status : 0;
    super({
      code: 'AMBIGUOUS_SUBMIT',
      status,
      retryable: false,
      message: `provider submit outcome is ambiguous; refusing a second submit: ${message}`,
    });
    this.name = 'AmbiguousSubmitError';
    this.originalError = originalError;
  }
}

export function isAmbiguousSubmitError(error: unknown): error is AmbiguousSubmitError {
  return error instanceof AmbiguousSubmitError;
}

export const seedreamParamsSchema = z
  .object({
    size: z
      .string()
      .regex(/^\d{2,5}x\d{2,5}$/, 'size must be WxH (e.g. 1024x1024)')
      .default('1024x1024'),
    seed: z.number().int().nonnegative().optional(),
    n: z.number().int().min(1).max(4).default(1),
    guidance_scale: z.number().min(0).max(20).optional(),
  })
  .strict();

export const seedanceParamsSchema = z
  .object({
    duration_seconds: z.number().int().min(1).max(10).default(5),
    resolution: z.enum(['480p', '720p', '1080p']).default('720p'),
    seed: z.number().int().nonnegative().optional(),
    aspect_ratio: z.enum(['16:9', '9:16', '1:1']).default('16:9'),
  })
  .strict();
