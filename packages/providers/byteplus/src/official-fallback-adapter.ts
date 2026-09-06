import { officialLegServability } from '@seed/shared/official-leg-cost';
import type { OfficialLegBudget } from './official-leg-budget';
import { MAX_IMAGE_BATCH, OpenRouterAdapter } from './openrouter-adapter';
import {
  ProviderError,
  workflowImageControls,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';

/**
 * The **official-OpenRouter last-resort leg** for the Nano Banana / Gemini image
 * family (see `FallbackChainAdapter`, docs/platform/backend-providers.md §B3).
 * It exists so a ban wave that kills BOTH gray-market relays (laozhang, kie)
 * does not take the feature offline.
 *
 * The relays take a vendor-native model id; OpenRouter needs a `vendor/model`
 * slug, so this wrapper rewrites `providerModelId` and delegates to a real
 * `OpenRouterAdapter`.
 *
 * ## Four gates, in this order
 *
 * 1. **Settleable.** The spec must carry a `jobId`. The budget below is a
 *    reservation keyed on it; a reservation nothing can ever settle would hold
 *    its ₽ against the cap until it aged out of the 30-day window.
 * 2. **Opt-in.** The row must carry `capabilities.openrouterFallbackSlug`.
 *    Until 2026-08-02 a HARDCODED slug map armed four gemini rows whether or not
 *    the row had asked for it — the doc claimed the leg was per-row opt-in while
 *    the code inferred it. The map is gone; the capability IS the opt-in, and a
 *    row without it gets `MODEL_UNAVAILABLE` (the chain degrades to 2 legs — no
 *    false success, no crash).
 * 3. **Costed, in units we can count.** The requested rung must have a third-leg
 *    USD rate in `capabilities.officialUsdPerUnit` (a per-rung map — see
 *    `@seed/shared/official-leg-cost`). We hold exactly one invoiced figure:
 *    `gemini-3-pro-image` @4K = $0.241344. An uncosted rung cannot be charged
 *    against the loss budget, so serving it would spend that budget invisibly —
 *    the exact defect the budget exists to close. It gets `OFFICIAL_LEG_UNPRICED`.
 *    Video is refused outright for the same reason: it bills by output second,
 *    the rung map is per unit, and `makeGeminiOmniAdapter` arms this leg on a
 *    VIDEO chain — so a video row here would spend real money that no
 *    billable-unit source could turn into ₽. (That chain simply degrades to its
 *    two relay legs, which its own comment already assumed it would.)
 * 4. **Booked.** Finance capped the leg's accumulated negative margin at
 *    3 000 ₽/day and 20 000 ₽/rolling month (`docs/business/finance-ask-model-cogs-2026-08-02.md`
 *    Ask 8, option b). This gate RESERVES the job's worst case against those caps
 *    rather than reading a historical sum — a read-then-submit gate approves
 *    every concurrent request off the same headroom. No reservation, no submit:
 *    `OFFICIAL_LEG_BUDGET_EXHAUSTED`.
 *
 * All four are checked BEFORE `generate()` submits — a post-submit check would
 * have already spent the money it was meant to withhold. `awaitResult()` does
 * not re-check: that handle is already paid for, and already booked.
 */
export class OfficialOpenRouterFallbackAdapter implements ProviderAdapter {
  constructor(
    private readonly openrouter: OpenRouterAdapter,
    private readonly budget: OfficialLegBudget,
  ) {}

  /** Gate 1 — a spend we could never settle is a spend we do not make. */
  private assertSettleable(spec: WorkflowSpec): string {
    if (spec.jobId) return spec.jobId;
    throw new ProviderError({
      code: 'OFFICIAL_LEG_UNTRACKABLE',
      status: 500,
      retryable: false,
      message: `'${spec.modelId}' reached the official OpenRouter leg with no jobId — its budget reservation could never be settled`,
    });
  }

  /**
   * Gates 2 and 3 — opt-in, servable kind, and a rate for this exact rung, from
   * the ONE predicate the admin gateway gate also scores this leg with
   * (`officialLegServability`). Two derivations would let the panel bless a rung
   * the worker refuses, which is precisely what happened to costed video.
   */
  private servableOrThrow(spec: WorkflowSpec): {
    slug: string;
    rung: string;
    usdPerUnit: number;
    units: number;
  } {
    const verdict = officialLegServability(spec.capabilities, spec.params, spec.kind);
    if (!verdict.servable) {
      if (verdict.reason === 'not-opted-in') {
        throw new ProviderError({
          code: 'MODEL_UNAVAILABLE',
          status: 400,
          retryable: false,
          message: `model '${spec.modelId}' has not opted into the official OpenRouter leg (no capabilities.openrouterFallbackSlug)`,
        });
      }
      throw new ProviderError({
        code: 'OFFICIAL_LEG_UNPRICED',
        status: 400,
        retryable: false,
        message:
          verdict.reason === 'unsupported-kind'
            ? `'${spec.modelId}' is kind '${spec.kind}' — the official OpenRouter leg is costed per image, so it has no billable-unit source here`
            : `no official-OpenRouter cost recorded for '${spec.modelId}' at rung '${verdict.rung}' — an uncostable leg cannot be charged against the loss budget`,
      });
    }
    // Exactly the fan-out the delegate will issue: one paid call per image.
    const units = Math.min(workflowImageControls(spec).count, MAX_IMAGE_BATCH);
    return { slug: verdict.slug, rung: verdict.rung, usdPerUnit: verdict.usdPerUnit, units };
  }

  /** Gate 4 — book the worst case, or do not go. Returns the attempt id. */
  private async reserve(
    spec: WorkflowSpec,
    jobId: string,
    price: { rung: string; usdPerUnit: number; units: number },
  ): Promise<string> {
    const outcome = await this.budget.reserve({
      jobId,
      modelId: spec.modelId,
      rung: price.rung,
      units: price.units,
      usdPerUnit: price.usdPerUnit,
    });
    if (outcome.reserved) return outcome.attemptId;
    throw new ProviderError({
      code: 'OFFICIAL_LEG_BUDGET_EXHAUSTED',
      status: 503,
      retryable: false,
      message:
        outcome.reason === 'no-credit-floor'
          ? `official-OpenRouter leg refused '${spec.modelId}': no priced subscription tier, so every job here is a total loss`
          : `official-OpenRouter leg is over its loss budget — '${spec.modelId}' is offline on this leg until a relay returns`,
    });
  }

  // async so a gate throw surfaces as a rejected promise, not a sync throw
  // (the ProviderAdapter contract is promise-returning).
  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    const jobId = this.assertSettleable(spec);
    const price = this.servableOrThrow(spec);
    const attemptId = await this.reserve(spec, jobId, price);
    try {
      return await this.openrouter.generate({ ...spec, providerModelId: price.slug });
    } catch (err) {
      // THIS attempt's booking, never the job's: a sibling attempt that was
      // billed keeps its ₽.
      if (provablyUnbilled(err, price.units)) await this.budget.release(attemptId);
      throw err;
    }
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    // Re-applies the same gates rather than re-deriving the slug: a handle this
    // adapter did not mint has no business resolving through it.
    return this.openrouter.awaitResult(handle, {
      ...spec,
      providerModelId: this.servableOrThrow(spec).slug,
    });
  }
}

/**
 * The 4xx statuses that are OpenRouter REFUSING the request outright, before any
 * upstream generation could run: a rejected body, a bad or unpaid key, a
 * forbidden or unknown route, an oversized payload, a rate limit.
 *
 * An ALLOWLIST, not the `400 ≤ status < 500` range it replaces, because the
 * default has to be "assume we were billed". The two errors are not
 * symmetrical: wrongly releasing under-counts real spend and lets the cap be
 * breached — the failure this whole budget exists to prevent — while wrongly
 * retaining over-books 25.6 ₽ of a 3 000 ₽/day cap.
 *
 * **408 is deliberately absent.** A request timeout is not a refusal: the
 * request was accepted and we stopped waiting for it, so the generation may well
 * have run and been billed. Nobody has shown that OpenRouter guarantees an
 * unbilled 408, and unlike a 401 storm (unbounded — every job, forever, which is
 * why releasing on 401 is necessary) a 408 is retryable and self-limiting:
 * BullMQ's attempt ceiling bounds the over-booking at a handful of rungs per
 * job. Retaining an unbilled 408 costs availability we can afford; releasing a
 * billed one costs a cap that is the only thing standing between this leg and
 * an unmetered −55% margin.
 */
const PROVABLY_UNBILLED_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 402, 403, 404, 413, 422, 429,
]);

/**
 * Can we PROVE the vendor charged this attempt nothing? Only then does its
 * reservation go back.
 *
 * Two conditions, both required:
 *  - **One call.** `generate()` fans out one paid call per requested image with
 *    `Promise.all`, which rejects on the first failure while its siblings are
 *    billed regardless. Above one image a rejection tells us nothing about what
 *    was spent, so the reservation stands.
 *  - **The vendor refused the request** — see {@link PROVABLY_UNBILLED_STATUSES}.
 *    A 5xx, a timeout, or one of our own 200-status codes (`NO_ASSET`,
 *    `BAD_IMAGE_PAYLOAD`) all mean the call may well have run and been billed;
 *    those keep the reservation, and the worker settles them as the losses
 *    they are.
 *
 * Being narrow here is the point, but so is releasing at all: a wrong
 * `OPENROUTER_API_KEY` 401s every request, and without this a few hundred
 * zero-cost failures would burn the day's whole budget and take the leg offline
 * for 24 h — during the ban wave it exists for.
 */
function provablyUnbilled(err: unknown, units: number): boolean {
  if (units !== 1) return false;
  if (!(err instanceof ProviderError)) return false;
  return PROVABLY_UNBILLED_STATUSES.has(err.status);
}
