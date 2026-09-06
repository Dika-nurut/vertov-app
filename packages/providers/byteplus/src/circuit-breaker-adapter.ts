import { withServingLeg } from './serving-leg';
import { isAmbiguousSubmitError } from './types';
import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';

/**
 * Generic two-gateway circuit breaker: try `primary`, and on ANY failure
 * (thrown error from generate() or awaitResult()) retry the whole call via
 * `fallback`. Tags the result with the shared {@link withServingLeg} vocabulary
 * (`servedBy`/`fallbackDepth`/`fellBackFrom`, plus `primaryError`) — the SAME
 * one `FallbackChainAdapter` uses, so the worker has one thing to read when it
 * persists jobs.gateway_used / jobs.used_fallback / jobs.fallback_depth. When
 * the primary is itself a chain, the chain's leaf leg wins and the depths add.
 *
 * This is the same pattern {@link NanoBananaAdapter} pioneered for the Nano
 * Banana family, generalized so ANY model can get an admin-configured
 * (primary, fallback) pair via `models.gateway_override` / `models.fallback_gateway`,
 * not just the two hardcoded families.
 */
export class CircuitBreakerAdapter implements ProviderAdapter {
  constructor(
    private readonly primary: ProviderAdapter,
    private readonly fallback: ProviderAdapter,
    private readonly primaryName: string,
    private readonly fallbackName: string,
  ) {}

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    try {
      // Mirrors NanoBananaAdapter: only a primary.generate() failure trips the
      // breaker. A successful handle (sync inline OR async pollable) defers to
      // primary.awaitResult() below — polling failures on an already-returned
      // handle are NOT covered, same as every single-gateway adapter today.
      return await this.primary.generate(spec);
    } catch (primaryErr) {
      if (isAmbiguousSubmitError(primaryErr)) throw primaryErr;
      try {
        const handle = await this.fallback.generate(spec);
        const result = await this.fallback.awaitResult(handle, spec);
        const tagged = withServingLeg(result, {
          name: this.fallbackName,
          fellBackFrom: this.primaryName,
          depth: 1,
        });
        return {
          ...handle,
          inlineResult: {
            ...tagged,
            meta: { ...tagged.meta, primaryError: (primaryErr as Error).message },
          },
        };
      } catch (fallbackErr) {
        if (isAmbiguousSubmitError(fallbackErr)) throw fallbackErr;
        throw new AggregateError(
          [primaryErr, fallbackErr],
          `${this.primaryName} and ${this.fallbackName} both failed: ` +
            `${(primaryErr as Error).message} | ${(fallbackErr as Error).message}`,
        );
      }
    }
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    const result = handle.inlineResult ?? (await this.primary.awaitResult(handle, spec));
    return withServingLeg(result, { name: this.primaryName, depth: 0 });
  }
}
