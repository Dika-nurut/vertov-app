export interface RouteDisagreementOracleEntry {
  /** Stable identity of the active price row being swept. */
  rowKey: string;
  /** The resolved v2 catalogue entry used by selectRoute. */
  entry: string;
  /** The first NEW ordered relay, or null when the selector fails closed. */
  newChoice: string | null;
  /** Raw realGateway(model), or the explicit sentinel for an unknown legacy answer. */
  legacyChoice: string;
  /** The first executable relay for a legacy chain, otherwise the raw gateway. */
  legacyPrimaryRelay: string | null;
  /** fallbackGatewayOf(model), kept as the old reserve answer. */
  legacyFallback: string | null;
  verdict: string;
}

/**
 * Hand-authored from the offline sweep. This is a literal oracle: a changed
 * selection, legacy answer, or disagreement must be reviewed rather than
 * absorbed by deriving the expected set from the current implementation.
 *
 * RE-DERIVED 2026-08-09, when the last 15 `capability_unknown` legs were closed.
 * Nine of the previous fifteen findings existed only because a leg had no
 * capability contract — the selector was failing closed, not disagreeing about
 * price. Each is listed below with the reason it left, so a shrinking oracle can
 * never be mistaken for entries deleted to make a test pass:
 *
 *  - `flux-2-pro|default|t2i` — RESOLVED. kie now has a contract, and at $0.025
 *    (2.52 ₽ landed) it is cheaper than OpenRouter's $0.03 (3.19 ₽). The new engine
 *    now picks the same kie leg the seed row already pinned via gatewayOverride, so
 *    there is nothing left to disagree about.
 *  - `seedream-5-0-pro` × 4 (`1K|refs-0-1`, `2K|refs-0-1`, `1K|refs-2-10`,
 *    `2K|refs-2-10`) — RESOLVED. The model is in the registry; its single signed kie
 *    leg is now costed and selected instead of failing closed to `null`.
 *  - `seedream-5-0-lite` × 3 (`2K|t2i`, `3K|t2i`, `4K|t2i`) — RESOLVED, same reason.
 *
 * Four findings are NEW and are real price disagreements, not gaps: the kie second
 * leg of the `nanobanana` chain is now contracted, and finance costs it BELOW the
 * laozhang chain primary on the flash rungs.
 *
 * RE-SWEPT against rev. 12 of `cost-legs.csv` (2026-08-09), which signs six reserve legs
 * the export had been missing. The sweep held at eleven findings for the seedance/flux
 * legs listed below, and then DROPPED to ten later the same day when the flux adapter fix
 * landed:
 *
 *  - The six `seedance-2-0*|r2v` configurations gained a kie reserve at the t2v ladder,
 *    which is DEARER than the OpenRouter leg they are priced on ($0.095 vs $0.067 at
 *    480p, $0.51 vs $0.34 at 1080p). Cheapest-first therefore keeps choosing OpenRouter,
 *    which is also what the legacy answer says, so no new disagreement appears. What
 *    changed is not the choice but the visibility: the failover now has a price, and at
 *    1080p it is a 0.13% margin instead of a blank.
 *  - `flux-2-pro|refs-2-8` — RESOLVED, REMOVED FROM THE ORACLE 2026-08-09. Kie's
 *    published $0.025/img was signed once `kie-adapter.ts` stopped refusing
 *    multi-reference requests (it had assumed `input_urls` was a single string; the
 *    vendor spec always declared a 1–8 array — see route-engine-phase-3a.test.ts for the
 *    full account). kie is cheaper than the OpenRouter primary ($0.025 vs $0.03), so the
 *    engine now picks kie — the same leg the legacy `gatewayOverride` pin already named.
 *    Agreement, not disagreement: the row no longer belongs in this oracle.
 *
 * RE-SWEPT against rev. 13/14 (2026-08-10): ten findings became six.
 *
 *  - `gpt-image-2` × 4 (`t2i`/`i2i` at `medium` and `high`) — RESOLVED, REMOVED. They
 *    existed because finance had priced the tiers per-tier — low on LaoZhang at $0.03,
 *    medium and high on Kie at $0.05 and $0.08 — so cheapest-first sent the two dear
 *    rungs to the chain's SECOND leg while the legacy pin named the first. rev. 13
 *    MEASURED the rate and LaoZhang bills a FLAT $0.03 at every tier, with no kie row at
 *    medium or high at all. Both paths now name LaoZhang, so there is nothing to
 *    disagree about — and the flat cost is what the owner's 13/21/33 ladder ruling of
 *    2026-08-10 rests on, since at one cost the price rule returns 13 three times.
 * 2026-09-02 (O-1 + owner re-pin, migration 0108): the two flash-lite findings are GONE —
 * the row now routes kie primary (finance's нога1), so legacy and selectRoute agree.
 *
 * Rev. 21 removes the two Wan i2v findings: export rows 93–96 now sign the Kie primary
 * and OpenRouter reserve at 163/244 credits, exactly matching the t2v twins, so the new
 * cheapest-leg choice (Kie) agrees with the model row's legacy primary.
 */
export const ROUTE_DISAGREEMENT_ORACLE: readonly RouteDisagreementOracleEntry[] = [
  {
    rowKey: 'gemini-3-1-flash-image|1K|mode=any|audio=false|videoInput=false|refs=0-any',
    entry: 'gemini-3-1-flash-image|1K|t2i|-|-|any',
    newChoice: 'kie',
    legacyChoice: 'nanobanana',
    legacyPrimaryRelay: 'laozhang',
    legacyFallback: 'kie',
    verdict:
      'selectRoute is right: finance signs kie as лег 1 at $0.04 (4.03 ₽ landed) against LaoZhang’s $0.055 (5.53 ₽), so the legacy chain order sends the cheapest rung to the dearer vendor 27% of the time; the kie leg was only unreachable because it had no contract.',
  },
  {
    rowKey: 'gemini-3-1-flash-image|1K|mode=any|audio=false|videoInput=false|refs=0-any',
    entry: 'gemini-3-1-flash-image|1K|i2i|-|-|any',
    newChoice: 'kie',
    legacyChoice: 'nanobanana',
    legacyPrimaryRelay: 'laozhang',
    legacyFallback: 'kie',
    verdict:
      'selectRoute is right: same signed legs as the 1K t2i row (kie $0.04 vs LaoZhang $0.055), and kie’s nano-banana-2 route serves references, so the cheaper leg is also the capable one.',
  },
];

/** No active sweep case currently has an empty realGateway answer. */
export const LEGACY_NOT_STATICALLY_KNOWABLE_ORACLE: readonly RouteDisagreementOracleEntry[] = [];
