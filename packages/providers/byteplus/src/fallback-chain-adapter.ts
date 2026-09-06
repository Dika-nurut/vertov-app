import { withServingLeg } from './serving-leg';
import {
  isAmbiguousSubmitError,
  type GenerationHandle,
  type GenerationResult,
  type ProviderAdapter,
  type WorkflowSpec,
} from './types';

/**
 * N-layer circuit breaker: try each leg in order; the first whose `generate()`
 * succeeds serves the job. Generalizes the 2-leg `NanoBananaAdapter` (which this
 * replaces at the `makeNanoBananaAdapter`/`makeGeminiOmniAdapter` call sites) to
 * an arbitrary chain, e.g. **laozhang → kie → official-OpenRouter** for the Nano
 * Banana family: the two cheap gray-market relays first, and an official
 * (pricier but reliable) leg as the last resort so a Google/OpenAI ban wave that
 * kills BOTH relays doesn't take the feature down. See docs/platform/backend-providers.md §B3.
 *
 * Semantics are intentionally identical to the shipped 2-leg breaker:
 *  - **Primary (leg 0)**: returns its handle as-is — the primary path is byte-
 *    identical to a bare adapter (a pollable video handle stays pollable). Only a
 *    `generate()` throw trips the breaker (a submit-ok-then-poll-fail is NOT
 *    retried, same limitation as before — documented).
 *  - **Fallback legs (1..n)**: fully resolved inline inside `generate()` and the
 *    result tagged (`servedBy`, `fellBackFrom`, `fallbackDepth` — see
 *    {@link withServingLeg}) so a fallback is observable and the worker never
 *    needs to know it happened. `awaitResult()` tags the PRIMARY leg the same
 *    way, so `jobs.gateway_used` names the leaf gateway on every path instead of
 *    the chain's own alias.
 *  - **All legs fail** → one `AggregateError` naming every leg's error (no hang).
 *
 * A leg that isn't live-configured must simply be omitted by the caller (don't
 * pass a stub as a fallback — that would be a free-asset backdoor on an outage).
 */
export class FallbackChainAdapter implements ProviderAdapter {
  private readonly legs: { name: string; adapter: ProviderAdapter }[];

  /**
   * Optional per-request leg order. The chain's construction order is one list for every
   * model and every resolution rung, while finance signs margins per (model, rung) — see
   * `SIGNED_CHAIN_LEG_ORDER` in @seed/shared for the case that forced this.
   *
   * MUST be a pure function of the spec: `awaitResult()` polls leg 0 for the primary path
   * and resolves the order a second time, so a reorder that is not deterministic would
   * poll a different vendor than the one that was submitted to.
   */
  private readonly reorder?: (
    legs: readonly { name: string; adapter: ProviderAdapter }[],
    spec: WorkflowSpec,
  ) => readonly { name: string; adapter: ProviderAdapter }[];

  constructor(
    legs: { name: string; adapter: ProviderAdapter }[],
    reorder?: (
      legs: readonly { name: string; adapter: ProviderAdapter }[],
      spec: WorkflowSpec,
    ) => readonly { name: string; adapter: ProviderAdapter }[],
  ) {
    if (legs.length < 2) {
      throw new Error('FallbackChainAdapter needs ≥2 legs (use the adapter directly for 1)');
    }
    this.legs = legs;
    if (reorder) this.reorder = reorder;
  }

  /** The leg order for one request. Identical inputs must give identical output. */
  private legsFor(spec: WorkflowSpec): readonly { name: string; adapter: ProviderAdapter }[] {
    const ordered = this.reorder ? this.reorder(this.legs, spec) : this.legs;
    // A reorder may only PERMUTE. Checking the length alone would accept
    // `[kie, kie, official]` for `[laozhang, kie, official]` — a leg silently deleted
    // and another billed twice — so compare the multiset of leg names instead.
    return isPermutationOfLegs(ordered, this.legs) ? ordered : this.legs;
  }

  async generate(spec: WorkflowSpec): Promise<GenerationHandle> {
    const errors: Error[] = [];
    const legs = this.legsFor(spec);

    // Leg 0 (primary): unchanged path — return the handle as-is.
    const primary = legs[0]!;
    try {
      return await primary.adapter.generate(spec);
    } catch (err) {
      if (isAmbiguousSubmitError(err)) throw err;
      errors.push(asError(err));
    }

    // Legs 1..n (fallbacks): resolve fully inline, tag, return.
    for (let i = 1; i < legs.length; i++) {
      const leg = legs[i]!;
      try {
        const handle = await leg.adapter.generate(spec);
        const result = await leg.adapter.awaitResult(handle, spec);
        return {
          ...handle,
          inlineResult: withServingLeg(result, {
            name: leg.name,
            fellBackFrom: legs[i - 1]!.name,
            depth: i,
          }),
        };
      } catch (err) {
        if (isAmbiguousSubmitError(err)) throw err;
        errors.push(asError(err));
      }
    }

    throw new AggregateError(
      errors,
      `all ${legs.length} provider legs failed: ${errors.map((e) => e.message).join(' | ')}`,
    );
  }

  async awaitResult(handle: GenerationHandle, spec: WorkflowSpec): Promise<GenerationResult> {
    // An inlineResult is either a fallback leg's (already tagged — withServingLeg
    // keeps that tag) or the primary's own sync result. Anything else is a
    // primary-leg poll (fallbacks inline in generate()). Either way the primary
    // path gets tagged HERE rather than in generate(), so its handle stays
    // byte-identical to a bare adapter's and a pollable video handle stays pollable.
    // Same order as generate() saw — legsFor() is required to be pure, so leg 0 here is
    // the leg that actually submitted.
    const legs = this.legsFor(spec);
    const result = handle.inlineResult ?? (await legs[0]!.adapter.awaitResult(handle, spec));
    return withServingLeg(result, { name: legs[0]!.name, depth: 0 });
  }
}

function isPermutationOfLegs(
  ordered: readonly { name: string }[],
  legs: readonly { name: string }[],
): boolean {
  if (ordered.length !== legs.length) return false;
  const remaining = new Map<string, number>();
  for (const leg of legs) remaining.set(leg.name, (remaining.get(leg.name) ?? 0) + 1);
  for (const leg of ordered) {
    const left = remaining.get(leg.name);
    if (!left) return false;
    remaining.set(leg.name, left - 1);
  }
  return true;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
