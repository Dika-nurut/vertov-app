/**
 * Cost of the **third leg** of the image chain — Google's own listing on
 * OpenRouter, reached as `laozhang → kie → openrouter-official`.
 *
 * Legs 0 and 1 are priced by scalar model-row capabilities
 * (`priceUsdPerUnit` / `fallbackUsdPerUnit`). The third leg is NOT a scalar:
 * OpenRouter passes Google's own resolution-tiered list price straight through,
 * and the only figure we have a real invoice for is `gemini-3-pro-image` at 4K
 * ($0.241344). So the row carries a **per-rung map**, `officialUsdPerUnit`, and
 * a rung with no entry is UNCOSTED.
 *
 * An uncosted rung must not be served on this leg: finance's 2026-08-02 ruling
 * (Ask 8, option b) caps the loss in ₽, and a leg whose cost we cannot compute
 * cannot be charged against that cap — it would spend the budget invisibly,
 * which is the exact defect the cap exists to close. `usdPerUnit === null` is
 * therefore a REFUSAL, not a "price it later".
 *
 * Lives in `@seed/shared` because both sides of the money path need the same
 * answer: the provider adapter refuses on `null`, and the worker prices the
 * ledger entry from the same number after the job succeeds.
 */

/** The name this leg stamps into `jobs.gateway_used` (see `serving-leg.ts`). */
export const OFFICIAL_LEG_GATEWAY = 'openrouter-official';

/** Model-row capability holding the per-rung third-leg cost. */
export const OFFICIAL_LEG_USD_CAPABILITY = 'officialUsdPerUnit';

/** Model-row capability that OPTS a row into the third leg at all. */
export const OFFICIAL_LEG_SLUG_CAPABILITY = 'openrouterFallbackSlug';

export interface OfficialLegCost {
  /** Price-point rung the request lands on ('1K'/'2K'/'4K'/… or 'default'). */
  rung: string;
  /** Third-leg USD per billable unit, or `null` when this rung is uncosted. */
  usdPerUnit: number | null;
}

function capabilityRecord(capabilities: unknown): Record<string, unknown> | null {
  return capabilities && typeof capabilities === 'object'
    ? (capabilities as Record<string, unknown>)
    : null;
}

function firstString(params: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * The price-point rung a request lands on. Deliberately mirrors
 * `priceSelectorFromParams` (apps/api/src/pricing-resolver.ts) — same aliases,
 * same `'default'` for a row that declares an empty `resolutions` list — so the
 * rung we cost the leg at is the rung we charged the customer for. Duplicated
 * rather than imported because `apps/api` is not a dependency of the worker or
 * the provider package.
 */
export function officialLegRung(
  capabilities: unknown,
  params: Record<string, unknown> | null | undefined,
  kind?: string,
): string {
  const caps = capabilityRecord(capabilities);
  const declared = caps?.['resolutions'];
  if (Array.isArray(declared) && declared.length === 0) return 'default';
  const aliases =
    kind === 'video' ? (['resolution'] as const) : (['resolution', 'quality'] as const);
  return firstString(params ?? {}, aliases) ?? 'default';
}

/**
 * Third-leg USD per billable unit at ONE named rung, or `null` when that rung is
 * uncosted (no map, wrong shape, missing rung, or a non-positive figure).
 *
 * **This is the single per-rung lookup for the leg**, and both money-path sides
 * must read it rather than re-deriving the number: the worker authorizes a
 * generation (and prices its budget reservation) from it, and the admin gateway
 * gate scores the same leg from it when an operator repoints routing. Two
 * derivations would let the panel bless a rung the worker refuses, or vice versa.
 *
 * A SCALAR `officialUsdPerUnit` is rejected on purpose: legs 0/1 use scalars, so
 * copying that shape here is an easy mistake, and silently reading it as "this
 * price applies to every rung" would re-introduce a blind rate. Fail loud.
 */
export function officialLegCostForRung(capabilities: unknown, rung: string): number | null {
  const raw = capabilityRecord(capabilities)?.[OFFICIAL_LEG_USD_CAPABILITY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usd = (raw as Record<string, unknown>)[rung];
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
  return usd;
}

/**
 * Third-leg cost for this REQUEST — the rung it lands on plus that rung's rate
 * (`null` when uncosted). Thin composition of {@link officialLegRung} and
 * {@link officialLegCostForRung}; a caller that already knows the rung (the
 * admin gate scores price-point rows, not request params) uses the latter.
 */
export function officialLegCost(
  capabilities: unknown,
  params: Record<string, unknown> | null | undefined,
  kind?: string,
): OfficialLegCost {
  const rung = officialLegRung(capabilities, params, kind);
  return { rung, usdPerUnit: officialLegCostForRung(capabilities, rung) };
}

/** The official OpenRouter slug a row opts into, or `null` when it has not. */
export function officialLegSlug(capabilities: unknown): string | null {
  const slug = capabilityRecord(capabilities)?.[OFFICIAL_LEG_SLUG_CAPABILITY];
  return typeof slug === 'string' && slug.length > 0 ? slug : null;
}

export type OfficialLegServability =
  | { servable: true; slug: string; rung: string; usdPerUnit: number }
  | {
      servable: false;
      rung: string;
      /**
       * `not-opted-in` — the row carries no `openrouterFallbackSlug`, so it has
       * no third leg at all.
       * `unsupported-kind` — video/voice. The leg bills by output second while
       * the rung map is per unit, so nothing here could turn the spend into ₽.
       * `uncosted` — this rung has no `officialUsdPerUnit` entry.
       */
      reason: 'not-opted-in' | 'unsupported-kind' | 'uncosted';
    };

/**
 * **Can the official leg actually serve this request?** — the ONE answer both
 * sides of the money path must use.
 *
 * The provider adapter refuses on every `servable: false` (mapping the reason to
 * a `ProviderError` code), and the admin gateway gate exempts a leg from the
 * ordinary margin floor only on `servable: true` — because "the spend cap
 * governs this leg" is only true of a leg that can execute.
 *
 * They disagreed until 2026-08-03: the gate exempted any opted-in rung it could
 * PRICE, while the adapter refused every video before it consulted a cost. A
 * costed official video rung was therefore blessed by the panel and refused by
 * the worker — latent only because no video row has an official slug yet.
 */
export function officialLegServability(
  capabilities: unknown,
  params: Record<string, unknown> | null | undefined,
  kind?: string,
): OfficialLegServability {
  const rung = officialLegRung(capabilities, params, kind);
  const slug = officialLegSlug(capabilities);
  if (!slug) return { servable: false, rung, reason: 'not-opted-in' };
  if (kind === 'video' || kind === 'voice') {
    return { servable: false, rung, reason: 'unsupported-kind' };
  }
  const usdPerUnit = officialLegCostForRung(capabilities, rung);
  if (usdPerUnit === null) return { servable: false, rung, reason: 'uncosted' };
  return { servable: true, slug, rung, usdPerUnit };
}
