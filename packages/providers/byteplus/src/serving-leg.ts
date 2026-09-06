import type { GenerationHandle, GenerationResult, ProviderAdapter, WorkflowSpec } from './types';

/**
 * The ONE vocabulary every failover wrapper uses to name the leg that actually
 * served a job. Before this existed, `FallbackChainAdapter` said
 * `servedBy`/`fallbackDepth` while `CircuitBreakerAdapter` said
 * `gatewayUsed`/`usedFallback` — so the worker, which only read the breaker's
 * names, silently recorded a 3-leg chain job as "served by the chain" at depth 0.
 * That is how an openrouter-official leg costing ~2.7× the primary stayed
 * invisible in the admin cost report.
 *
 *  - `servedBy` — the LEAF gateway that produced the assets (never a chain alias
 *    like `nanobanana`). This is what lands in `jobs.gateway_used`.
 *  - `fallbackDepth` — hops away from the top-level primary. 0 = primary leg,
 *    1 = the first fallback (priced by `capabilities.fallbackUsdPerUnit`),
 *    ≥2 = a leg with no recorded cost → the report must say UNKNOWN.
 *  - `fellBackFrom` — the leg that failed immediately before, for diagnostics.
 */
export const SERVED_BY = 'servedBy';
export const FALLBACK_DEPTH = 'fallbackDepth';

/**
 * Stamp a result with the leg that served it, composing with any tag an INNER
 * wrapper already applied. Wrappers nest in production (`getAdapterWithFallback`
 * puts a `CircuitBreakerAdapter` around the `nanobanana` `FallbackChainAdapter`),
 * so the outer wrapper must not overwrite the inner leaf's name: the inner
 * `servedBy` wins and the depths ADD (outer hop + inner hops = hops from the
 * top-level primary).
 */
export function withServingLeg(
  result: GenerationResult,
  leg: { name: string; depth: number; fellBackFrom?: string },
): GenerationResult {
  const meta = result.meta;
  const innerServedBy = typeof meta?.[SERVED_BY] === 'string' ? (meta[SERVED_BY] as string) : null;
  const innerDepth =
    typeof meta?.[FALLBACK_DEPTH] === 'number' ? (meta[FALLBACK_DEPTH] as number) : 0;
  const innerFellBackFrom =
    typeof meta?.['fellBackFrom'] === 'string' ? meta['fellBackFrom'] : null;
  return {
    ...result,
    meta: {
      ...meta,
      [SERVED_BY]: innerServedBy ?? leg.name,
      [FALLBACK_DEPTH]: leg.depth + innerDepth,
      ...((innerFellBackFrom ?? leg.fellBackFrom)
        ? { fellBackFrom: innerFellBackFrom ?? leg.fellBackFrom }
        : {}),
    },
  };
}

/**
 * Name the leg when there is only one of it.
 *
 * `FallbackChainAdapter` needs ≥2 legs, so a chain whose other vendors are not
 * live-configured used to collapse to the bare inner adapter — and with it went
 * the only thing that stamped `servedBy`. The `openrouter-official` leg then
 * reported itself as plain `openrouter` (the inner adapter's own name), which is
 * a DIFFERENT gateway in every downstream table: the routing alias landed in
 * `jobs.gateway_used` and the ~2.7x last-resort leg was invisible again, in
 * exactly the configuration where it is the only leg we have.
 *
 * Deliberately not "FallbackChainAdapter, but with one leg": a chain wraps every
 * failure in an `AggregateError`, which would swallow the `ProviderError` codes
 * (`OFFICIAL_LEG_BUDGET_EXHAUSTED`, `KieUnarmedError`) that a single-leg gateway
 * relies on reaching the worker intact. This passes `generate()` straight
 * through — handle, gateway stamp, errors and all — and only tags the result.
 */
export class ServingLegAdapter implements ProviderAdapter {
  constructor(
    private readonly name: string,
    private readonly inner: ProviderAdapter,
  ) {}

  generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    return this.inner.generate(spec);
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    return withServingLeg(await this.inner.awaitResult(handle, spec), {
      name: this.name,
      depth: 0,
    });
  }
}
