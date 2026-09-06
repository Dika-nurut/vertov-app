import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costLegFile } from '@seed/db';
import { seedModels } from '@seed/db/seed/models';
import { byteplusRouteContracts } from './model-contract-byteplus';
import {
  DUPLICATE_RESERVE_REASON,
  duplicateReserveExcusedLeaves,
  routeEngineG2CostGaps,
  unmappedDuplicateReserveExclusions,
} from './route-engine-guards';
import { gatewayArmingFromEnv } from './relay-gateway';

/**
 * Leaves the configured failover chain can REACH that carry no signed rate in rev. 12
 * of `cost-legs.csv`.
 *
 * Read the scope precisely. **Every configuration listed here IS priced** — finance
 * signed the relay it intends to serve it. What is missing is a rate for the OTHER relay
 * our chain falls over to, so this is not "finance forgot prices"; it is "our chain can
 * spend money at a rate nobody signed", a failover-configuration question first and a
 * pricing question second.
 *
 * Rev. 11 listed 27. Rev. 12 leaves SIX here (plus one separately-tracked unsignable leg,
 * below). Twenty closed, in three waves that must not be confused with each other:
 *
 *  - **12 were signed** (`seedance-2-0*|r2v|kie`). The rates already existed in
 *    docs/platform/model-catalog.md and simply never reached the export; rev. 12
 *    transcribes them. The twelve lines are six configurations counted twice, once under
 *    `seedance-2-0*` and once under the `-reference-to-video` picker id that resolves to
 *    the same (model, mode) price.
 *  - Rev. 22 explicitly costed the former Gemini/GPT reserve positions, so they are no
 *    longer hidden behind an EXCLUDED duplicate marker. The export now carries a signed
 *    cost row for each mode/quality rather than relying on a policy exemption.
 *  - **1 was closed later, separately: `flux-2-pro` 2–8 references on Kie.** Drafted at
 *    rev. 12 alongside the other twelve, then WITHDRAWN — see below for why and how it
 *    was re-signed on 2026-08-09.
 *
 * What is left is genuinely open, and NONE of it is a missing price:
 *
 *  - **`gpt-image-2` quality mapping on Kie** remains unarmed. Rev. 22 signs exact
 *    low/medium/high fallback cost rows, but Kie exposes resolution rather than the
 *    OpenAI quality axis; a runtime mapping must be approved before the fallback can
 *    serve a quality request.
 * Closed separately, after the nineteen above:
 *
 *  - **`wan-2-7 i2v` on Kie — CLOSED 2026-08-11.** Rev. 21 signs the wired Kie primary and
 *    OpenRouter reserve on both export rows 93–96 (`Сетка FX стр.77/78`), so the two
 *    previously uncosted Kie leaves are now costed at the same 163/244 credits as their
 *    t2v twins. They must not remain in this gap list.
 *
 *  - **`flux-2-pro` 2–8 references on Kie — CLOSED 2026-08-09** (was 1 line, now signed).
 *    Rev. 12 drafted the row at Kie's published $0.025/img, then WITHDREW it: the adapter
 *    (`packages/providers/byteplus/src/kie-adapter.ts`) threw above one reference image,
 *    on the assumption that `input_urls` was a single-string field. That assumption was
 *    never checked against the vendor spec captured in the same session 14 minutes
 *    earlier (`kie-specs/flux2__pro-image-to-image.md`), which always declared
 *    `input_urls` a REQUIRED 1–8 array with a worked two-image example, and no paid probe
 *    on record contradicts it — though none confirms it against a live two-reference
 *    call either. The adapter was fixed to send the spec's array shape, the route
 *    contract's `reference.maxImages` raised 1→8 to match, and the row re-signed at
 *    41.55% margin on kie's primary leg. kie is now cheaper than the OpenRouter primary
 *    ($0.025 vs $0.03), so `selectRoute` picks kie for this band — the disagreement
 *    entry that used to name this row was REMOVED from `route-disagreement-oracle.ts`
 *    rather than updated, because new and legacy now agree. A definitive submit-time
 *    4xx from kie still falls over to OpenRouter via `CircuitBreakerAdapter`; an
 *    accepted-then-failed task or a silent fewer-than-requested-images response would
 *    not — see the adapter's own comment for the remaining exposure.
 *
 * This list is the guard. Adding a line here is a deliberate act.
 */
const UNCOSTED_ARMED_LEAVES: readonly string[] = [
  // The Nano Banana chain's OTHER relay. Every line below is one model+rung whose chain
  // reaches a second vendor that finance has not signed a rate for at that rung, so a
  // failover would serve at a price nobody has costed. They arrived together in rev. 13,
  // Rev. 22 removed the former Gemini/GPT entries by signing their exact fallback rows;
  // the remaining entries below are still genuine uncosted leaves.
  //
  // Not a blocker for the primary: each of these rungs has a signed нога1 and sells at
  // its signed margin. What is missing is the RESERVE, and R-1 puts the fallback floor at
  // zero rather than 25% precisely because refusing to fail over turns a vendor outage
  // into ours. The exposure is that the reserve's price is unknown, not that it is bad.
  'gemini-3-pro-image|1K|-|i2i|audio=null|kie',
  'gemini-3-pro-image|1K|-|t2i|audio=null|kie',
  'gemini-3-pro-image|2K|-|t2i|audio=null|kie',
  // Rev. 16 adds the depth-1 4K Kie rows. OpenRouter remains an armed leaf on both
  // Seedance picker models, but finance signs no 4K OpenRouter leg for either mode.
  'seedance-2-0-reference-to-video|4K|-|r2v|audio=false|openrouter',
  'seedance-2-0-reference-to-video|4K|-|t2v|audio=false|openrouter',
  'seedance-2-0|4K|-|r2v|audio=false|openrouter',
  'seedance-2-0|4K|-|t2v|audio=false|openrouter',
  // FLUX.2 Pro's new 2K rung on its OpenRouter reserve. This one is a SERVABILITY gap as
  // much as a costing one: the OpenRouter image endpoint exposes no size control at all
  // (`EMPTY_MENU` on that route), so a 2K job that fails over comes back at the vendor's
  // ~1 MP default — a smaller picture at the 2K price — and OpenRouter bills per
  // MEGAPIXEL, so the rate for a real 2K render is not $0,03 either. Finance has asked
  // for exactly this measurement (one paid OpenRouter call at 2K with references, «17
  // credits or 31 is a factor of two and we will publish neither until one is measured»).
  // Closes when that probe lands.
  'flux-2-pro|2K|-|t2i|audio=null|openrouter',
  // The same gap on the two reference modes rev. 19 signed. Nothing new is unknown here:
  // the reserve's per-megapixel rate and its missing size control are one fact, and it
  // applies to every 2K mode, so all three close on the same paid probe.
  'flux-2-pro|2K|-|i2i|audio=null|openrouter',
  'flux-2-pro|2K|-|refs-2-8|audio=null|openrouter',
];

/**
 * CLOSED 2026-08-09 by finance's rev. 12 — and closed the way this comment predicted,
 * which is worth leaving on the record rather than deleting.
 *
 * The block that stood here said the AtlasCloud leg on `gemini-omni-flash` was servable
 * at $0.112/s, unsignable at 257 credits (90.17 ₽ cost against 85.10 ₽ revenue = −5.96%,
 * below R-1's zero floor), and that «273 credits per 8 s would put the leg at +0.25%».
 * rev. 12 signed exactly 273, and the leg now carries +0.25%. So the uncosted-armed-leaf
 * list drops from 7 to 6 and this constant is gone.
 *
 * Two things not to lose with it. The `$0,112` is the **t2v/i2v** Atlas route;
 * `reference-to-video` is a different route at `$0,135`, and reading one for the other is
 * what made 2026-08-03 report this rate as stale. And +0.25% is thin by design: a 2% move
 * at Atlas puts the leg under water, at which point R-11 governs — we keep serving and
 * absorb it — rather than R-1.
 */

describe('Phase 3a shared routing guards', () => {
  it('G2: every armed executable leaf is costed, while refused official rungs are excluded', () => {
    const noGatewaysArmed = gatewayArmingFromEnv({});
    expect(routeEngineG2CostGaps(noGatewaysArmed)).toEqual([]);

    // Exercise the guard with every real leaf armed so an uncosted adapter is visible
    // in CI rather than being hidden by the test process's usual stub environment. The
    // three Gemini official rows without an officialUsdPerUnit rung are intentionally
    // absent because the adapter refuses those submits.
    const allLeavesArmed = gatewayArmingFromEnv({
      KIE_MODE: 'live',
      KIE_API_KEY: 'ci-test-key',
      LAOZHANG_MODE: 'live',
      LAOZHANG_API_KEY: 'ci-test-key',
      OPENROUTER_MODE: 'live',
      OPENROUTER_API_KEY: 'ci-test-key',
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'ci-test-key',
    });
    const gaps = routeEngineG2CostGaps(allLeavesArmed);

    // The whole set, not a sample of it. A NEW uncosted executable leaf fails here.
    expect([...gaps].sort()).toEqual([...UNCOSTED_ARMED_LEAVES].sort());
    // And the key must stay unique, or two configurations hide behind one line.
    expect(new Set(gaps).size).toBe(gaps.length);
    expect(gaps.some((gap) => gap.includes('openrouter-official'))).toBe(false);

    // The contract registry is part of the same check: an armed named model
    // must remain represented by its route data, even where the finance gap
    // is the result being reported.
    expect(
      seedModels.filter((model) => model.isActive && byteplusRouteContracts[model.id]),
    ).not.toEqual([]);
  });

  it('G2 reads the EXCLUDED block: a duplicated reserve is costed, a withdrawn rung is not', () => {
    // Every «резерв дублирует основную» position must be mapped to the leaf it excuses.
    // An unmapped one would excuse nothing and reappear as a cost gap, which reads like
    // a missing price — so a new exclusion nobody mapped fails HERE, deliberately.
    expect(unmappedDuplicateReserveExclusions()).toEqual([]);
    // Rev. 22 moved the former GPT duplicate positions into explicit cost rows. The
    // EXCLUDED block therefore has no duplicate-reserve exemptions left.
    expect([...duplicateReserveExcusedLeaves()].sort()).toEqual([]);

    // Only that reason excuses anything. `снято с продажи` is the opposite situation —
    // a rung with no price at all — and mapping one would silently bless a real gap.
    const withdrawnOnly = {
      ...costLegFile,
      excluded: costLegFile.excluded.filter((row) => row.reason !== DUPLICATE_RESERVE_REASON),
    };
    expect(withdrawnOnly.excluded.length).toBeGreaterThan(0);
    expect(duplicateReserveExcusedLeaves(withdrawnOnly).size).toBe(0);

    // With no duplicate exemption, switching the empty set off must not change the
    // projection. This keeps the guard fail-closed if a future exclusion is added without
    // a corresponding explicit map entry.
    const armed = gatewayArmingFromEnv({
      KIE_MODE: 'live',
      KIE_API_KEY: 'ci-test-key',
      LAOZHANG_MODE: 'live',
      LAOZHANG_API_KEY: 'ci-test-key',
      OPENROUTER_MODE: 'live',
      OPENROUTER_API_KEY: 'ci-test-key',
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'ci-test-key',
    });
    const withExcusal = routeEngineG2CostGaps(armed, seedModels);
    const withoutExcusal = routeEngineG2CostGaps(armed, seedModels, new Set());
    expect(withoutExcusal.filter((gap) => !withExcusal.includes(gap)).sort()).toEqual([]);
  });

  /**
   * The pin above is only a guard if an unapproved gap actually fails it. Feed the
   * projection a model configured onto a gateway finance never signed and prove the
   * new line surfaces — this is the mutation the previous `toContain` version could
   * not fail.
   */
  it('G2 bites: a newly armed uncosted leaf is not absorbed by the approved list', () => {
    const armed = gatewayArmingFromEnv({
      KIE_MODE: 'live',
      KIE_API_KEY: 'ci-test-key',
      ATLASCLOUD_MODE: 'live',
      ATLASCLOUD_API_KEY: 'ci-test-key',
    });
    const seedream = seedModels.find((model) => model.id === 'seedream-5-0-pro');
    if (!seedream) throw new Error('seedream-5-0-pro is gone from the seed');

    const baseline = routeEngineG2CostGaps(armed, [seedream]);
    const drifted = routeEngineG2CostGaps(armed, [
      { ...seedream, gatewayOverride: 'atlascloud', fallbackGateway: null },
    ]);
    expect(baseline).toEqual([]);
    expect(drifted.length).toBeGreaterThan(0);
    expect(drifted.every((gap) => gap.endsWith('|atlascloud'))).toBe(true);
    expect(drifted.some((gap) => UNCOSTED_ARMED_LEAVES.includes(gap))).toBe(false);
  });

  it('the rev. 21 Wan i2v rows are costed on both signed legs', () => {
    // Rev. 21 closes the old gap: the wired Kie image-to-video route is now signed as
    // primary and OpenRouter remains the reserve on export rows 93–96 (Сетка FX стр.77/78).
    const spec = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../docs/platform/vendor-api/kie-specs/wan__2-7-image-to-video.md',
    );
    expect(existsSync(spec), 'kie publishes a wan i2v route; the gap is ours').toBe(true);
    const body = readFileSync(spec, 'utf8');
    // The frame roles our OpenRouter leg already wires — i.e. the request shape we would
    // send. If kie ever drops them, «cannot serve» becomes true and this must be revisited.
    expect(body).toContain('wan/2-7-image-to-video');
    expect(body).toContain('first_frame_url');

    // The capability remains explicit even though the contract stores the shared gateway
    // entry: frame roles are served by the wired sibling slug, and the signed cost rows
    // mean no Wan i2v Kie leaf may appear as an uncosted gap.
    const kieWan = byteplusRouteContracts['wan-2-7']?.find(
      (contract) => contract.gateway === 'kie',
    );
    expect(kieWan?.slug).toBe('wan/2-7-text-to-video');
    expect(kieWan?.reference.frameRoles).toEqual(['first', 'last']);
    // maxImages stays 0 and that is not a contradiction: the row's `slug` is the T2V
    // endpoint, which takes no reference images. The frames are served by a SECOND kie
    // slug (`wan/2-7-image-to-video`) that this single-slug row cannot express, which is
    // why the frame roles and the image cap disagree here and only here. Asserting both
    // keeps the row honest — dropping the cap would hide a real widening.
    expect(kieWan?.reference.maxImages).toBe(0);
    expect(UNCOSTED_ARMED_LEAVES.filter((leaf) => leaf.startsWith('wan-2-7|'))).toHaveLength(0);
  });
});
