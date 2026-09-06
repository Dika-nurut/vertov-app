import { nid } from '../src/id';

/**
 * Canonical parametric price matrix, keyed by the LIVE DB model id and ready to
 * seed `model_price_points`. The original rows came from the v14 workbook; every
 * representable configuration is now projected onto finance's signed rev. 9 export
 * in `cost-legs.csv`. `rev6-projection.test.ts` checks the whole matrix against the
 * strict parser/catalogue so another export change fails CI.
 *
 * This is the single source of the matrix. It lives in @seed/db (the lowest
 * package) because both the seed script AND the pure kernel/tests in
 * @seed/credits need it, and @seed/credits already depends on @seed/db — the
 * reverse edge would be a dependency cycle.
 *
 * `sourceRef` retains the original workbook cell for unchanged v14 rows. A `rev9:`
 * prefix marks a value changed by the signed export and names its source line. The
 * two withdrawn HappyHorse 1.0 rows and GPT Image 2's inactive compatibility row
 * have no export configuration; the projection test names and explains all three.
 *
 * `isActive` carries each row's REAL state (53 active / 14 inactive workbook or
 * export rows, plus one derived inactive compatibility row). Reasons for the 14:
 *   - 6 video-input rows (`Параметрика` 38–45): no media-duration provenance
 *     exists anywhere in the schema, so the input leg is unbillable today
 *     (goal §8 owner gate — follow-up goal "trusted input duration").
 *   - `seedance-2-0` `4K`: owner ruling 3 — blocked on the kie 4K probe; also
 *     unreachable today (the model's declared resolutions stop at 1080p).
 *   - `seedream-4-5` `1K`: Kie's route exposes no 1K quality tier, so the
 *     workbook row is retained for drift mapping but cannot be sold.
 *   - Flux 1K `refs-2-8`: retired by the approved finance ruling; the historical
 *     row remains inactive for audit reconciliation.
 *   - HappyHorse 1.0 720p/1080p: delisted by the owner ruling; retained for audit
 *     reconciliation but not exposed for sale.
 *   - Veo 4K (three variants): priced, but Kie's required `/veo/get-4k-video`
 *     second step is not wired.
 *
 * `rev6:` rows are the rungs the 2026-08-03 export adds that the v14 ladder never
 * held — Kling 1080p and 4K. They carry the `rev6:` prefix because the frozen
 * `pricing-ladder-v3.json` is the v14 ladder and cannot contain a cell that
 * post-dates the freeze; the drift guard exempts them for that reason alone, and
 * `rev6-projection.test.ts` pins them against the export itself so the exemption is
 * not a hole. Both ship INACTIVE, blocked on a route rather than a price. When the
 * ladder is refrozen against a signed export, they lose the prefix and rejoin the
 * guard.
 *
 * `baseUnits` provenance: video rows carry finance's exported quantity per SKU
 * (Veo=1 clip; seedance/happyhorse/wan/kling=5s; grok=6s; omni=8s). Images = 1.
 * The nullable `perItem` term exists for vendor-metered input images; no row
 * carries one today — see the Seedream note at its rows.
 *
 * DB-id reconciliation vs the workbook names: the workbook's «nano-banana-pro»
 * is DB id 'gemini-3-pro-image' (family «Nano Banana», variant «3 Pro»). Every
 * other modelId below is a verbatim live DB id (see packages/db/seed/models.ts).
 */
export interface PricePointSeedRow {
  modelId: string;
  /** Discrete resolution/quality step, or 'default' when the model has none. */
  resolution: string;
  videoInput: boolean;
  audio: boolean;
  unitKind: 'image' | 'second';
  baseCredits: number;
  baseUnits: number;
  /**
   * One charge for the whole job, whatever the duration. Veo only: the vendor bills
   * one price per clip at 4, 6 or 8 seconds, so proration would sell a 4-second clip
   * at half a cost we pay in full. See the `flat_rate` comment in the schema for why
   * this is a column and not a `clip` value on `unit_kind`.
   */
  flatRate: boolean;
  /**
   * Additive vendor charge for input images beyond `included`. Never combined
   * with a reference band — a band is one flat price for the whole band.
   */
  perItem: { included: number; creditsPerExtra: number } | null;
  /** Generation mode this row prices; `'any'` matches whatever the request is. */
  mode: 'any' | 't2v' | 'i2v' | 'r2v' | 'video-edit' | 't2i' | 'i2i';
  /** Reference band this row prices; 0/null matches any input-image count. */
  refsMin: number;
  refsMax: number | null;
  sourceRef: string;
  isActive: boolean;
}

const row = (
  modelId: string,
  resolution: string,
  unitKind: PricePointSeedRow['unitKind'],
  baseCredits: number,
  baseUnits: number,
  sourceRef: string,
  isActive: boolean,
  videoInput = false,
  audio = false,
  flatRate = false,
  perItem: PricePointSeedRow['perItem'] = null,
  mode: PricePointSeedRow['mode'] = 'any',
  refsMin = 0,
  refsMax: number | null = null,
): PricePointSeedRow => ({
  modelId,
  resolution,
  videoInput,
  audio,
  unitKind,
  baseCredits,
  baseUnits,
  flatRate,
  perItem,
  mode,
  refsMin,
  refsMax,
  sourceRef,
  isActive,
});

export const PRICE_POINT_SEED: readonly PricePointSeedRow[] = [
  // === Veo 3.1 — finance bills one whole clip at any positive duration. Audio is
  // model-managed output, so these rows carry the export configuration's audio=true.
  row('veo-3-1', '720p', 'second', 597, 1, 'rev9:Сетка FX стр.9', true, false, true, true),
  row('veo-3-1', '1080p', 'second', 597, 1, 'rev9:Сетка FX стр.10', true, false, true, true),
  row('veo-3-1-fast', '720p', 'second', 122, 1, 'rev9:Сетка FX стр.11', true, false, true, true),
  row('veo-3-1-fast', '1080p', 'second', 132, 1, 'rev9:Сетка FX стр.12', true, false, true, true),
  row('veo-3-1-lite', '720p', 'second', 66, 1, 'rev9:Сетка FX стр.13', true, false, true, true),
  row('veo-3-1-lite', '1080p', 'second', 71, 1, 'rev9:Сетка FX стр.14', true, false, true, true),
  // 4K is priced but inactive: Kie requires the `/veo/get-4k-video` two-step and
  // `packages/providers/byteplus/src/kie-adapter.ts` deliberately refuses it until wired.
  row('veo-3-1', '4K', 'second', 750, 1, 'rev9:Сетка FX стр.72', false, false, true, true),
  row('veo-3-1-fast', '4K', 'second', 365, 1, 'rev9:Сетка FX стр.73', false, false, true, true),
  row('veo-3-1-lite', '4K', 'second', 304, 1, 'rev12:Сетка FX стр.74', false, false, true, true),
  // === Seedance 2.0 — 5-s clip (row 7). 4K stays inactive: owner ruling 3 (kie
  // 4K probe unresolved) AND unreachable (model's declared resolutions stop at
  // 1080p — the price-points-drift ceiling guard exempts inactive rows for
  // exactly this reason). Rev. 16 aligns the parked row with the signed Kie price,
  // 2183 → 2108. Because `isActive` remains false, this is not a customer-visible
  // price cut today. rows 8–10. ===
  row('seedance-2-0', '4K', 'second', 2108, 5, 'rev16:Сетка FX стр.15/Сетка FX стр.66', false),
  row('seedance-2-0', '1080p', 'second', 775, 5, 'rev12:Сетка FX!AA16/AB16', true),
  row('seedance-2-0', '720p', 'second', 323, 5, 'rev9:Сетка FX стр.17', true),
  row('seedance-2-0', '480p', 'second', 145, 5, 'rev9:Сетка FX стр.18', true),
  // === Seedance Fast — 720p ceiling (rows 11–12). ===
  row('seedance-2-0-fast', '720p', 'second', 259, 5, 'Сетка FX!AA19/AB19', true),
  row('seedance-2-0-fast', '480p', 'second', 118, 5, 'rev9:Сетка FX стр.20', true),
  // === HappyHorse (rows 13–16). ===
  row('happyhorse-1-1', '720p', 'second', 212, 5, 'rev9:Сетка FX стр.21', true),
  row('happyhorse-1-1', '1080p', 'second', 274, 5, 'Сетка FX!AA22/AB22', true),
  // Delisted 2026-08-03 (owner ruling): HappyHorse 1.0 is dearer than 1.1 at the
  // same result. Rows kept inactive for audit reconciliation.
  row('happyhorse-1-0', '720p', 'second', 284, 5, 'Сетка FX!AA23/AB23', false),
  row('happyhorse-1-0', '1080p', 'second', 365, 5, 'Сетка FX!AA24/AB24', false),
  // === Wan 2.7 (rows 17–18) — the mode no longer moves the price, and that is the news.
  //
  // Rev. 10 charged i2v 31% more than t2v for the same clip, and the reason was real at
  // the time: the kie route was text-to-video only, so a framed shot fell to the
  // OpenRouter leg at $0.10/$0.15 against kie's $0.08/$0.12 — the same clip off a 25%
  // dearer meter. Rev. 18 cut the difference on my report that kie served frames; it did
  // not, the kie leg was refusing every framed job, and finance rolled back to rev. 19.
  //
  // `wan/2-7-image-to-video` was wired on 2026-08-11 and a paid call through the
  // production adapter confirmed $0.08/s to the cent (task
  // d1f623742cc98f2af897ab45048eb63d). Both modes now run the same leg at the same rate,
  // so rev. 21 sets i2v equal to its t2v twin — 163 and 244.
  //
  // The i2v rows stay even though they now duplicate the 'any' rows. The six-column key
  // needs an explicit i2v row: without one an i2v job falls through to 'any', which is
  // correct only for exactly as long as the two prices happen to agree.
  row('wan-2-7', '720p', 'second', 163, 5, 'rev9:Сетка FX стр.25', true),
  row('wan-2-7', '1080p', 'second', 244, 5, 'rev9:Сетка FX стр.26', true),
  row(
    'wan-2-7',
    '720p',
    'second',
    163,
    5,
    'rev21:Сетка FX стр.77',
    true,
    false,
    false,
    false,
    null,
    'i2v',
  ),
  row(
    'wan-2-7',
    '1080p',
    'second',
    244,
    5,
    'rev21:Сетка FX стр.78',
    true,
    false,
    false,
    false,
    null,
    'i2v',
  ),
  // === Kling v3 — 720p only, priced from the leg that exists (rev. 11).
  //
  // The route is OPENROUTER (`kwaivgi/kling-v3.0-std`) and always was: there is no kie
  // slug for Kling anywhere, no gateway override, no fallback. Rev. 10 nonetheless
  // priced it from a Kie leg at $0.07/$0.10 — a rate taken as evidence of a route —
  // and the resulting 203/142 sold at 0.48% and 5.16% against a 25% target. Rev. 11
  // re-derives both from OpenRouter's real $0.126/$0.084 per second. The rows are
  // typed ИСПРАВЛЕНИЕ in the workbook journal, not a repricing.
  //
  // Audio is a user toggle on this model, so BOTH states carry a row; without the
  // quiet one a silent request takes the audio price. With one leg and one rate, t2v
  // and i2v converge — the mode split rev. 10 recorded for Kling was an artefact of
  // the phantom leg, not a property of the model. Finance's rule out of this round:
  // a price difference between modes is only real when the modes ROUTE differently.
  //
  // 1080p and 4K are WITHDRAWN in rev. 11 (СНЯТО, not deleted): the catalogue declares
  // `resolutions: ['720p']`, so those rows priced rungs that were never for sale.
  row('kling-v3-0-std', '720p', 'second', 270, 5, 'rev11:Сетка FX стр.27', true, false, true),
  row('kling-v3-0-std', '720p', 'second', 180, 5, 'rev11:Сетка FX стр.27б', true, false, false),
  // === Grok (rows 20–21). ===
  row('grok-imagine-video', '720p', 'second', 69, 6, 'rev9:Сетка FX стр.28', true),
  row('grok-imagine-video', '480p', 'second', 37, 6, 'rev9:Сетка FX стр.29', true),
  // === Gemini Omni — no resolution control (row 22). ===
  row('gemini-omni-flash', 'default', 'second', 273, 8, 'rev12:Сетка FX стр.30', true, false, true),
  // === Nano Banana family (rows 23–30). ===
  row('gemini-2-5-flash-image', 'default', 'image', 9, 1, 'Сетка FX!AA31', true),
  row('gemini-3-1-flash-image', '1K', 'image', 17, 1, 'rev9:Сетка FX стр.32', true),
  row('gemini-3-1-flash-image', '2K', 'image', 23, 1, 'rev9:Сетка FX стр.47', true),
  row('gemini-3-1-flash-image', '4K', 'image', 28, 1, 'rev9:Сетка FX стр.48', true),
  row('gemini-3-1-flash-lite-image', 'default', 'image', 9, 1, 'rev9:Сетка FX стр.33', true),
  row('gemini-3-pro-image', '1K', 'image', 37, 1, 'Сетка FX!AA34', true),
  row('gemini-3-pro-image', '2K', 'image', 43, 1, 'Сетка FX!AA46', true),
  row('gemini-3-pro-image', '4K', 'image', 50, 1, 'Сетка FX!AA35', true),
  // === gpt-image-2 — quality tiers keyed on the vendor's OWN quality values
  // (owner ruling: not 1K/2K/4K; phase 1.1 wires this through the adapters).
  // One price for t2i and i2i (owner ruling 2 — no separate i2i row). rows 31–33. ===
  row('gpt-image-2', 'low', 'image', 13, 1, 'Сетка FX!AA36', true),
  row('gpt-image-2', 'medium', 'image', 21, 1, 'Сетка FX!AA37', true),
  row('gpt-image-2', 'high', 'image', 33, 1, 'Сетка FX!AA38', true),
  // Compatibility row ONLY — NOT one of the 55 SSOT rows. gpt-image-2 no longer
  // declares an empty `resolutions` list (phase 1.1), so `pricing-resolver.ts`
  // never collapses a request to the literal `'default'` selector for this model
  // any more — this row is unreachable. Kept (inactive) rather than deleted: the
  // migration that carries the price catalogue to prod is additive-only.
  row('gpt-image-2', 'default', 'image', 27, 1, 'derived:gpt-image-2-default', false),
  // === Seedream family (rows 34–41). ===
  // Kie's Seedream 4.5 route has no 1K tier, so this workbook rung is unsellable.
  // Keep it parked to preserve its Сетка FX!AA39 mapping for the drift guard.
  row('seedream-4-5', '1K', 'image', 14, 1, 'Сетка FX!AA39', false),
  row('seedream-4-5', '2K', 'image', 17, 1, 'Сетка FX!AA49', true),
  row('seedream-4-5', '4K', 'image', 20, 1, 'Сетка FX!AA50', true),
  // Two configurations, not one price with a surcharge. A job with 0–1 input images
  // is text-to-image at $0.035/$0.07; from the second image kie routes it through
  // `seedream/5-pro-image-to-image` and meters every image past the first at $0.0025,
  // so finance prices the whole 2–10 band at its worst count ($0.0575 = 0.035 + 9 ×
  // 0.0025, and $0.0925 the same way) and signs ONE flat number for it.
  //
  // The `perItem` term that used to stand in for this is GONE with the band. Keeping
  // both would charge the band price plus the per-image term — the surcharge twice —
  // which is why the kernel refuses a row carrying both rather than adding them up.
  row('seedream-5-0-pro', '1K', 'image', 16, 1, 'Сетка FX!AA40', true, false, false, false, null),
  row(
    'seedream-5-0-pro',
    '2K',
    'image',
    31,
    1,
    'rev9:Сетка FX стр.41',
    true,
    false,
    false,
    false,
    null,
  ),
  row(
    'seedream-5-0-pro',
    '1K',
    'image',
    24,
    1,
    'rev10:Сетка FX стр.61',
    true,
    false,
    false,
    false,
    null,
    'any',
    2,
    10,
  ),
  row(
    'seedream-5-0-pro',
    '2K',
    'image',
    38,
    1,
    'rev10:Сетка FX стр.62',
    true,
    false,
    false,
    false,
    null,
    'any',
    2,
    10,
  ),
  row('seedream-5-0-lite', '2K', 'image', 12, 1, 'Сетка FX!AA42', true),
  row('seedream-5-0-lite', '3K', 'image', 14, 1, 'Сетка FX!AA51', true),
  row('seedream-5-0-lite', '4K', 'image', 17, 1, 'Сетка FX!AA52', true),
  // === Flux / Recraft (rows 42–44). Flux's 2–8 band: kie serves both the single-image
  // case ($0.025) and, since the kie-adapter multi-reference fix of 2026-08-09, the
  // 2–8 band too — kie is now cheaper than OpenRouter and is what selectRoute picks. ===
  row('flux-2-pro', '1K', 'image', 11, 1, 'rev14:Сетка FX стр.43', true),
  // 2K, signed in rev. 13 against a rate we MEASURED: 7 kie credits at $0,005 = $0,035,
  // with the unit calibrated off the already-signed 1K leg rather than assumed. 15 and
  // not 14 because 14 lands at 24,0%, under the floor. Note kie's «2K» delivers 1536²,
  // so it is 2,25x the pixels for 1,40x the cost — a per-megapixel model over-predicts
  // this rung about fourfold, which is why it had to be measured instead of derived.
  //
  // ACTIVE since rev. 14. It shipped inactive for one round because rev. 13 added this
  // rung while leaving the cheap one banded `default`, making flux the first model in
  // the catalogue with a `default` band beside a named one — and `priceSelectorFromParams`
  // reads the DECLARED list, so declaring ['1K','2K'] would have keyed every 1K request
  // on '1K', found no row, and refused the charge. rev. 14 re-bands the cheap rung `1K`
  // and asserts at generation that no model may mix `default` with a named rung, so the
  // class is closed rather than this instance. The adapter's hardcoded `resolution: '1K'`
  // comes off in this same change.
  row('flux-2-pro', '2K', 'image', 15, 1, 'rev14:Сетка FX стр.104', true),
  // Rev. 19 signs Kie's 2K image-to-image call separately because it is a distinct
  // export configuration, even though Kie bills the input-image request at the same
  // flat 15-credit image rate as text-to-image.
  row(
    'flux-2-pro',
    '2K',
    'image',
    15,
    1,
    'rev19:Сетка FX стр.105',
    true,
    false,
    false,
    false,
    null,
    'i2i',
  ),
  // The rev. 19 2K reference band is a distinct six-column key, not a fallback to the
  // plain 2K row: Kie signs the whole 2–8 image band at one flat 15-credit price.
  row(
    'flux-2-pro',
    '2K',
    'image',
    15,
    1,
    'rev19:Сетка FX стр.106',
    true,
    false,
    false,
    false,
    null,
    'any',
    2,
    8,
  ),
  // 13 → 14 in rev. 13. Not a repricing: OpenRouter bills $0,03 per MEGAPIXEL and 1K is
  // 1,049 MP, so the leg always cost $0,0315 and 13 credits was 22,4% — under the floor
  // by a rounding we had both been reading as flat. Safe in both directions: if the
  // vendor does bill flat, 14 is 31%.
  row(
    'flux-2-pro',
    '1K',
    'image',
    14,
    1,
    'rev14:Сетка FX стр.79',
    false,
    false,
    false,
    false,
    null,
    'any',
    2,
    8,
  ),
  row('recraft-v4', 'default', 'image', 18, 1, 'Сетка FX!AA44', true),
  row('recraft-v4-vector', 'default', 'image', 35, 1, 'Сетка FX!AA45', true),
  // === With-video selectors remain inactive until trusted media duration exists.
  // Rev. 9 prices the serving r2v configuration over five output seconds; without a
  // distinct mode/duration key, these parked rows must carry that signed value too.
  // Rev. 16 moves the signed 4K r2v price 2910 → 2108, so this inactive selector follows
  // the same export row and remains non-customer-visible until trusted duration exists. ===
  row(
    'seedance-2-0-reference-to-video',
    '4K',
    'second',
    2108,
    5,
    'rev16:Сетка FX стр.66',
    false,
    true,
  ),
  row(
    'seedance-2-0-reference-to-video',
    '1080p',
    'second',
    775,
    5,
    // rev. 12 moved the 1080p t2v twin to 775 and left this mirror at 776. The mirror is
    // DERIVED (owner ruling 5), not independently signed, so the ruling wins and finance
    // was asked to correct the export in rev. 13 — see finance-ask-5-measured-rates.
    'rev12-зеркало:Сетка FX стр.65',
    false,
    true,
  ),
  row(
    'seedance-2-0-reference-to-video',
    '720p',
    'second',
    323,
    5,
    'rev9:Сетка FX стр.64',
    false,
    true,
  ),
  row(
    'seedance-2-0-reference-to-video',
    '480p',
    'second',
    145,
    5,
    'rev9:Сетка FX стр.63',
    false,
    true,
  ),
  row(
    'seedance-2-0-fast-reference-to-video',
    '720p',
    'second',
    259,
    5,
    'rev9:Сетка FX стр.68',
    false,
    true,
  ),
  row(
    'seedance-2-0-fast-reference-to-video',
    '480p',
    'second',
    118,
    5,
    'rev9:Сетка FX стр.67',
    false,
    true,
  ),
  // === Image-only r2v mirror rows (owner ruling 5) — the r2v model reaches the
  // SAME resolutions as its t2v twin when no video reference is attached, at the
  // SAME price (OpenRouter bills r2v output at the t2v ladder — model-catalog.md
  // §71). Active: image-only requests contain no video-reference field, select
  // videoInput=false, and price solely by normalized output seconds. rows 51–55. ===
  row(
    'seedance-2-0-reference-to-video',
    '1080p',
    'second',
    775,
    5,
    // Deliberate mirror of the t2v twin (owner ruling 5). The export still says 776;
    // correction requested for rev. 13. Prose stays OUT of source_ref — it is parsed.
    'rev12-зеркало:Сетка FX!AA16/AB16',
    true,
  ),
  row('seedance-2-0-reference-to-video', '720p', 'second', 323, 5, 'rev9:Сетка FX стр.64', true),
  row('seedance-2-0-reference-to-video', '480p', 'second', 145, 5, 'rev9:Сетка FX стр.63', true),
  row(
    'seedance-2-0-fast-reference-to-video',
    '720p',
    'second',
    259,
    5,
    'Сетка FX!AA19/AB19 (deliberate mirror of the t2v twin — owner ruling 5)',
    true,
  ),
  row(
    'seedance-2-0-fast-reference-to-video',
    '480p',
    'second',
    118,
    5,
    'rev9:Сетка FX стр.67',
    true,
  ),
];

/**
 * Insertable rows for `model_price_points`. Carries each row's REAL isActive
 * state (see PRICE_POINT_SEED doc comment) — 53 active / 14 inactive export/workbook
 * rows, plus the one inactive compatibility row (68 total). The seed script's
 * onConflict `set` (packages/db/scripts/seed.ts) omits `isActive` and gates the
 * update on `is_active = false`, so a reseed still never silently flips an
 * operator's activation of a row already live in prod — only inactive rows get
 * their other fields refreshed from this file.
 */
export function buildPricePointRows() {
  return PRICE_POINT_SEED.map((r) => ({ id: nid(), ...r }));
}
