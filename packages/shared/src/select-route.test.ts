import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  costCatalogue,
  creditFloorRub,
  entryKey,
  fallbackGatewayOf,
  executableIdentity,
  landedRubPerUsd,
  servingModelId,
  usdAtReferenceCount,
  realGateway,
  type CatalogueEntry,
  type CostLeg,
} from '@seed/db';
import { seedModels } from '@seed/db/seed/models';
import { PRICE_POINT_SEED } from '@seed/db/seed/price-points';
import { seedSubscriptionTiers } from '@seed/db/seed/subscription-catalog';
import { contractForGateway, type ContractGateway } from './model-contract';
import { byteplusRouteContracts as routeContracts } from './model-contract-byteplus';
import {
  CHAIN_RELAY_EXPANSIONS,
  RELAY_TO_ADAPTER_GATEWAY,
  UNCOSTED_ADAPTER_GATEWAYS,
  contractGatewayForRelay,
  relayForAdapterGateway,
} from './relay-gateway';
import {
  CAPABILITY_UNKNOWN_GATEWAY_ABSENT,
  CAPABILITY_UNKNOWN_MODEL_ABSENT,
  CAPABILITY_UNKNOWN_TOTAL,
  selectRoute,
  type RouteRequest,
  type OfficialOpenRouterLeg,
} from './select-route';
import {
  LEGACY_NOT_STATICALLY_KNOWABLE_ORACLE,
  ROUTE_DISAGREEMENT_ORACLE,
  type RouteDisagreementOracleEntry,
} from './__fixtures__/route-disagreement-oracle';
import type { BreakEvenModel } from '@seed/db';
import { splitModelId } from '@seed/db';

const catalogue = costCatalogue();
const knownModelIds = new Set(Object.keys(routeContracts));
const floorRub = creditFloorRub(seedSubscriptionTiers);
const now = new Date('2026-08-08T00:00:00.000Z');

const activeSeedModelIds = new Set(
  seedModels.filter((model) => model.isActive).map((model) => model.id),
);
const activePriceRows = PRICE_POINT_SEED.filter(
  (row) => row.isActive && activeSeedModelIds.has(row.modelId),
);

function rowMatchesEntry(row: (typeof activePriceRows)[number], entry: CatalogueEntry): boolean {
  const leg = entry.legs[0]!;
  const resolution = entry.quality ?? entry.rung;
  const referencesMatch =
    row.refsMin === 0 && row.refsMax === null
      ? leg.refsMin === 0 && leg.refsMax <= 1
      : row.refsMin === leg.refsMin && (row.refsMax ?? 0) === leg.refsMax;
  return (
    row.modelId === entry.modelId &&
    row.resolution === resolution &&
    (row.mode === 'any' || row.mode === entry.mode) &&
    referencesMatch &&
    (row.audio === false
      ? entry.audio === null || entry.audio === false
      : row.audio === entry.audio)
  );
}

const activeEntries = catalogue.filter(
  (entry) =>
    activeSeedModelIds.has(entry.modelId) &&
    activePriceRows.some((row) => rowMatchesEntry(row, entry)),
);

function modelIdForEntry(entry: CatalogueEntry): string {
  const baseModelId = splitModelId(entry.modelId).modelId;
  return (
    (routeContracts[entry.modelId] ? entry.modelId : null) ??
    servingModelId({ modelId: entry.modelId, mode: entry.mode }, knownModelIds) ??
    baseModelId
  );
}

function requestFor(
  entry: CatalogueEntry,
  overrides: Partial<Omit<RouteRequest, 'entry'>> = {},
): RouteRequest {
  const { health = () => true, ...facts } = overrides;
  return {
    entry,
    references: 0,
    durationSeconds: null,
    frames: [],
    audio: false,
    resolution: entry.quality ?? entry.rung,
    aspect: '16:9',
    units: entry.baseUnits,
    revenueRub: entry.credits * floorRub,
    videoReferences: 0,
    audioReferences: 0,
    ...facts,
    health,
  };
}

function isCostLeg(leg: CostLeg | { gateway: string }): leg is CostLeg {
  return 'relay' in leg;
}

function legLabel(entry: CatalogueEntry, leg: CostLeg): string {
  return `${entryKey(entry)}#${leg.leg}`;
}

function independentUnknownKind(
  entry: CatalogueEntry,
  leg: CostLeg,
): 'model_absent' | 'gateway_absent' | null {
  const modelId = modelIdForEntry(entry);
  const contracts = routeContracts[modelId];
  if (!contracts) return 'model_absent';
  const gateway = contractGatewayForRelay(leg.relay);
  if (!gateway || !contractForGateway(contracts, gateway)) return 'gateway_absent';
  return null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function durationBoundaries(entry: CatalogueEntry): Array<number | null> {
  const contracts = routeContracts[modelIdForEntry(entry)] ?? [];
  const values = new Set<number>();
  for (const contract of contracts) {
    if (!contract.duration) continue;
    values.add(contract.duration.min);
    values.add(contract.duration.max);
    for (const step of contract.duration.steps ?? []) values.add(step);
    values.add(contract.duration.min - 1);
    values.add(contract.duration.max + 1);
  }
  return values.size === 0 ? [null] : [null, ...values];
}

function referenceBoundaries(entry: CatalogueEntry): number[] {
  const values = new Set<number>([0, 1]);
  for (const leg of entry.legs) {
    if (leg.refsMin === 0 && leg.refsMax === 0) continue;
    values.add(leg.refsMin - 1);
    values.add(leg.refsMin);
    values.add(leg.refsMax);
    values.add(leg.refsMax + 1);
  }
  return [...values].filter((value) => value >= 0).sort((a, b) => a - b);
}

function priceRowKey(row: (typeof activePriceRows)[number]): string {
  return `${row.modelId}|${row.resolution}|mode=${row.mode}|audio=${row.audio}|videoInput=${row.videoInput}|refs=${row.refsMin}-${row.refsMax ?? 'any'}`;
}

function legacyPrimaryRelay(gateway: string): string | null {
  const chain = CHAIN_RELAY_EXPANSIONS[gateway as keyof typeof CHAIN_RELAY_EXPANSIONS];
  if (chain) return chain.find((relay) => relay !== 'openrouter-official')?.toLowerCase() ?? null;
  return gateway || null;
}

function sweepRowMatchesEntry(
  row: (typeof activePriceRows)[number],
  entry: CatalogueEntry,
): boolean {
  const split = splitModelId(row.modelId);
  const leg = entry.legs[0]!;
  const modeMatches =
    split.mode !== null ? entry.mode === split.mode : row.mode === 'any' || row.mode === entry.mode;
  const referencesMatch =
    row.refsMin === 0 && row.refsMax === null
      ? leg.refsMin === 0 && leg.refsMax <= 1
      : row.refsMin === leg.refsMin && (row.refsMax ?? 0) === leg.refsMax;
  return (
    entry.modelId === split.modelId &&
    modeMatches &&
    (entry.quality ?? entry.rung) === row.resolution &&
    (entry.audio === null || entry.audio === row.audio) &&
    referencesMatch
  );
}

function sweepRowForEntry(entry: CatalogueEntry): (typeof activePriceRows)[number] | null {
  const matches = activePriceRows.filter((row) => sweepRowMatchesEntry(row, entry));
  const exactMode = matches.filter((row) => {
    const split = splitModelId(row.modelId);
    return split.mode === entry.mode || (split.mode === null && row.mode === entry.mode);
  });
  return exactMode[0] ?? matches.find((row) => row.mode === 'any') ?? null;
}

function sweepCases(): Array<{
  row: (typeof activePriceRows)[number];
  entry: CatalogueEntry;
}> {
  return catalogue.flatMap((entry) => {
    const row = sweepRowForEntry(entry);
    return row ? [{ row, entry }] : [];
  });
}

function oracleShape(
  row: (typeof activePriceRows)[number],
  entry: CatalogueEntry,
  newChoice: string | null,
  legacyChoice: string,
  legacyFallback: string | null,
  verdict: string,
): RouteDisagreementOracleEntry {
  return {
    rowKey: priceRowKey(row),
    entry: entryKey(entry),
    newChoice,
    legacyChoice,
    legacyPrimaryRelay:
      legacyChoice === 'legacy_not_statically_knowable' ? null : legacyPrimaryRelay(legacyChoice),
    legacyFallback,
    verdict,
  };
}

/**
 * EMPTY since rev. 15, and it stays as a named constant rather than being deleted because
 * the answer was not the one we asked for.
 *
 * rev. 13 priced five nano-banana reserve legs with the ПОСРЕДНИК cell left as `—`, and
 * we asked finance to name the vendor. There was none: the reserve rate was a byte-copy of
 * the primary's, typed to fill a column, and those five configurations have no failover at
 * all. The export now marks them with `ГЛУБИНА ЛЕСТНИЦЫ = 1`, and its generator
 * refuses to emit a leg without a named relay.
 *
 * Keeping the list here means a future unnamed relay lands as a diff against an empty
 * expectation instead of as a new idea someone has to notice.
 */
const UNNAMED_RELAY_LEGS: readonly string[] = [];

describe('Phase 2 relay and route selection', () => {
  it('normalizes every finance relay and keeps chains distinct from vendors', () => {
    const relays = new Set(catalogue.flatMap((entry) => entry.legs.map((leg) => leg.relay)));
    // Back to four relays in rev. 15. The `—` label was never a missing vendor NAME — it
    // was a placeholder reserve leg copying the primary's own rate, and the five rows it
    // sat on have no failover at all. Removing the phantom moved no price and no margin,
    // which is exactly why it survived three revisions.
    expect([...relays].sort()).toEqual(['AtlasCloud', 'Kie', 'LaoZhang', 'OpenRouter']);
    // The mapping still refuses `—` explicitly. A relay label that reaches the router
    // without a vendor must dial nothing, whether or not one is in the file today.
    expect(RELAY_TO_ADAPTER_GATEWAY['—' as keyof typeof RELAY_TO_ADAPTER_GATEWAY]).toBeUndefined();
    expect(contractGatewayForRelay('—')).toBeNull();
    for (const relay of [...relays].filter((candidate) => candidate !== '—')) {
      expect(RELAY_TO_ADAPTER_GATEWAY[relay as keyof typeof RELAY_TO_ADAPTER_GATEWAY]).toBeTruthy();
      expect(
        relayForAdapterGateway(
          RELAY_TO_ADAPTER_GATEWAY[relay as keyof typeof RELAY_TO_ADAPTER_GATEWAY],
        ),
      ).toBe(relay);
      expect(contractGatewayForRelay(relay)).toBe(relay.toLowerCase() as ContractGateway);
    }
    expect(CHAIN_RELAY_EXPANSIONS.nanobanana).toEqual(['laozhang', 'kie', 'openrouter-official']);
    expect(CHAIN_RELAY_EXPANSIONS.geminiomni).toEqual(['kie', 'atlascloud', 'openrouter-official']);
    // rev. 12 signed the AtlasCloud omni leg, so atlascloud is no longer an
    // uncosted gateway and a priced leg naming it is now CORRECT. Evolink still has
    // an adapter and no signed row, and must never appear on a priced leg.
    expect(Object.keys(UNCOSTED_ADAPTER_GATEWAYS).sort()).toEqual(['evolink']);
    expect(catalogue.flatMap((entry) => entry.legs).some((leg) => /evolink/i.test(leg.relay))).toBe(
      false,
    );
    expect(
      catalogue.flatMap((entry) => entry.legs).filter((leg) => /atlascloud/i.test(leg.relay))
        .length,
      'exactly one AtlasCloud leg is signed — the rev. 12 omni t2v reserve',
    ).toBe(1);
  });

  it('pins the two Wan winners and exposes the official leg exclusion', () => {
    const wan = activeEntries.find(
      (entry) => entry.modelId === 'wan-2-7' && entry.rung === '720p' && entry.mode === 't2v',
    );
    if (!wan) throw new Error('Wan 720p t2v entry is missing');

    const plain = selectRoute(requestFor(wan, { durationSeconds: 5 }), now);
    expect(plain.ordered[0]?.leg.relay).toBe('Kie');

    // A keyframed Wan job used to be REFUSED on kie and served by the dearer OpenRouter
    // reserve, because `wan/2-7-image-to-video` had never been wired. Since 2026-08-11 it
    // is, so the cheap leg wins here too — which is the whole point of wiring it. Rev. 21
    // now signs both legs at the same 163-credit 720p rate as the t2v twin.
    const framed = selectRoute(
      requestFor(wan, { durationSeconds: 5, frames: ['first', 'last'] }),
      now,
    );
    expect(framed.ordered[0]?.leg.relay).toBe('Kie');
    expect(
      framed.rejected.some(
        (rejection) => isCostLeg(rejection.leg) && rejection.leg.relay === 'Kie',
      ),
    ).toBe(false);
    expect(framed.ordered.some((candidate) => candidate.leg.relay === 'openrouter-official')).toBe(
      false,
    );
    // Wan is not one of the two built-in chains, so it has NO official third leg and
    // must not be handed a marker claiming one. The marker appears only when the
    // caller says the model opted in — see the `hasOfficialLeg` case below.
    expect(framed.rejected.some((rejection) => rejection.reason === 'official_leg_excluded')).toBe(
      false,
    );

    const optedIn = selectRoute(
      {
        ...requestFor(wan, { durationSeconds: 5, frames: ['first', 'last'] }),
        hasOfficialLeg: true,
      },
      now,
    );
    const marker = optedIn.rejected.find(
      (rejection) => rejection.reason === 'official_leg_excluded',
    );
    expect(marker).toBeDefined();
    // Never ordered, and uniquely identified — a shared constant collided across entries.
    expect(optedIn.ordered.some((candidate) => candidate.leg.relay === 'openrouter-official')).toBe(
      false,
    );
    const markerLeg = marker!.leg;
    expect(isCostLeg(markerLeg)).toBe(false);
    expect((markerLeg as OfficialOpenRouterLeg).executableIdentity).toBe(
      'openrouter-official|wan-2-7|720p|t2v',
    );
  });

  it('reaches every real rejection reason, including strict loss and injected health', () => {
    const wan = activeEntries.find(
      (entry) => entry.modelId === 'wan-2-7' && entry.rung === '720p' && entry.mode === 't2v',
    );
    const fluxBand = activeEntries.find(
      (entry) => entry.modelId === 'flux-2-pro' && entry.mode === 'refs-2-8',
    );
    if (!wan || !fluxBand) throw new Error('pinned rejection fixtures are missing');

    // Wan no longer supplies this fixture: its kie leg serves frames as of 2026-08-11,
    // so a framed Wan request has no incapable leg left to reject. seedance-2-0 is the
    // live case — frames are on OpenRouter and its kie leg declares none.
    const seedance = activeEntries.find(
      (entry) => entry.modelId === 'seedance-2-0' && entry.mode === 't2v',
    );
    if (!seedance) throw new Error('the seedance t2v fixture is missing');
    const incapable = selectRoute(
      requestFor(seedance, { durationSeconds: 5, frames: ['first'] }),
      now,
    );
    expect(incapable.rejected.some((rejection) => rejection.reason === 'incapable')).toBe(true);

    // `model_absent` and `gateway_absent` no longer have a fixture: every active
    // signed leg carries a contract now (see the empty-set guard below). The one
    // capability_unknown kind still reachable is the ambiguous zero image cap.
    const ambiguous = selectRoute(requestFor(wan, { references: 1 }), now);
    expect(ambiguous.rejected).toContainEqual(
      expect.objectContaining({
        reason: 'capability_unknown',
        unknownKind: 'ambiguous_max_images',
      }),
    );

    const uncosted = selectRoute(requestFor(fluxBand), now);
    expect(uncosted.rejected.some((rejection) => rejection.reason === 'uncosted')).toBe(true);

    const kie = wan.legs.find((leg) => leg.relay === 'Kie');
    if (!kie) throw new Error('Wan Kie leg is missing');
    const kieCost = usdAtReferenceCount(kie, 0)! * landedRubPerUsd(kie) * wan.baseUnits;
    const equal = selectRoute(requestFor(wan, { revenueRub: kieCost, durationSeconds: 5 }), now);
    expect(equal.ordered.some((candidate) => candidate.leg.relay === 'Kie')).toBe(true);

    const loss = selectRoute(
      requestFor(wan, { revenueRub: kieCost - 0.01, durationSeconds: 5 }),
      now,
    );
    expect(
      loss.rejected.some(
        (rejection) =>
          isCostLeg(rejection.leg) &&
          rejection.leg.relay === 'Kie' &&
          rejection.reason === 'loss_making',
      ),
    ).toBe(true);

    const unhealthy = selectRoute(
      requestFor(wan, {
        durationSeconds: 5,
        health: (identity) => (identity === executableIdentity(kie) ? 'unhealthy' : 'healthy'),
      }),
      now,
    );
    expect(
      unhealthy.rejected.some(
        (rejection) =>
          isCostLeg(rejection.leg) &&
          rejection.leg.relay === 'Kie' &&
          rejection.reason === 'unhealthy',
      ),
    ).toBe(true);

    const thinFallback = selectRoute(
      requestFor(wan, {
        durationSeconds: 5,
        health: (identity) => (identity === executableIdentity(kie) ? 'unhealthy' : 'healthy'),
      }),
      now,
    );
    const fallback = thinFallback.ordered.find((candidate) => candidate.leg.relay === 'OpenRouter');
    expect(fallback).toBeDefined();
    expect(1 - fallback!.landedRubTotal / (wan.credits * floorRub)).toBeCloseTo(0.016307, 5);

    expect(selectRoute(requestFor(fluxBand, { references: 0 }), now).ordered).toHaveLength(0);
    expect(
      selectRoute(
        { ...requestFor(fluxBand, { references: 0 }), hasOfficialLeg: true },
        now,
      ).rejected.some((rejection) => rejection.reason === 'official_leg_excluded'),
    ).toBe(true);
  });

  it('pins an EMPTY capability-unknown set against an independent leg enumeration', () => {
    // Rev. 22 is the signed 140-row export: Wan i2v 720p/1080p and the Gemini/GPT image
    // fallback configurations carry explicit reserve rows. The
    // enumeration is over the whole file on purpose:
    // a leg that stops being counted here is a leg that stopped being checked for a
    // capability gap.
    expect(catalogue.reduce((count, entry) => count + entry.legs.length, 0)).toBe(140);
    const unknown = activeEntries.flatMap((entry) =>
      entry.legs.flatMap((leg) => {
        const kind = independentUnknownKind(entry, leg);
        return kind ? [{ entry, leg, kind, label: legLabel(entry, leg) }] : [];
      }),
    );
    const modelAbsent = unknown.filter((item) => item.kind === 'model_absent');
    const gatewayAbsent = unknown.filter((item) => item.kind === 'gateway_absent');
    expect(modelAbsent).toHaveLength(CAPABILITY_UNKNOWN_MODEL_ABSENT);
    expect(gatewayAbsent).toHaveLength(CAPABILITY_UNKNOWN_GATEWAY_ABSENT);
    expect(unknown).toHaveLength(CAPABILITY_UNKNOWN_TOTAL);

    // Printed, not just counted: a leg that loses its contract names itself here.
    expect(modelAbsent.map((item) => item.label).sort()).toEqual([]);
    // If a leg loses its contract this fails even though the count still fits. The list
    // is empty since rev. 15 removed the phantom reserves (see
    // CAPABILITY_UNKNOWN_GATEWAY_ABSENT for the whole story).
    expect(gatewayAbsent.map((item) => item.label).sort()).toEqual([...UNNAMED_RELAY_LEGS]);

    // An empty set proves nothing on its own, so the no-silent-drop invariant is
    // asserted directly instead: EVERY active signed leg must come back from
    // selectRoute exactly once — ordered, or rejected under a named reason — and
    // none of them may be refused for a missing capability contract.
    const legTotal = activeEntries.reduce((count, entry) => count + entry.legs.length, 0);
    expect(activeEntries.length).toBeGreaterThan(0);
    expect(legTotal).toBeGreaterThan(0);
    let accounted = 0;
    for (const entry of activeEntries) {
      const decision = selectRoute(requestFor(entry), now);
      for (const leg of entry.legs) {
        const identity = executableIdentity(leg);
        const ordered = decision.ordered.filter(
          (candidate) => executableIdentity(candidate.leg) === identity,
        );
        const rejected = decision.rejected.filter(
          (rejection) => isCostLeg(rejection.leg) && executableIdentity(rejection.leg) === identity,
        );
        expect(
          ordered.length + rejected.length,
          `${legLabel(entry, leg)} must be ordered or rejected exactly once`,
        ).toBe(1);
        const missingContract = rejected.find(
          (rejection) =>
            rejection.reason === 'capability_unknown' &&
            rejection.unknownKind !== 'ambiguous_max_images',
        );
        // No exceptions remain: every signed leg has a named vendor since rev. 15, so
        // every one of them must have a capability contract. The guard is kept in this
        // shape so a future unnamed relay is refused rather than routed.
        if (!UNNAMED_RELAY_LEGS.includes(legLabel(entry, leg))) {
          expect(
            missingContract?.detail,
            `${legLabel(entry, leg)} has no capability contract`,
          ).toBeUndefined();
        }
        accounted += 1;
      }
    }
    expect(accounted).toBe(legTotal);
  });

  it('pins both former Group-B gaps as contracted, costed and cheapest', () => {
    const flux = activeEntries.find(
      (entry) => entry.modelId === 'flux-2-pro' && entry.mode === 't2i',
    );
    const gemini = activeEntries.find(
      (entry) =>
        entry.modelId === 'gemini-3-1-flash-image' && entry.rung === '1K' && entry.mode === 't2i',
    );
    if (!flux || !gemini) throw new Error('Group-B pinned entries are missing');
    for (const entry of [flux, gemini]) {
      const decision = selectRoute(requestFor(entry), now);
      const kie = decision.rejected.find(
        (rejection) => isCostLeg(rejection.leg) && rejection.leg.relay === 'Kie',
      );
      // Both Kie legs are the CHEAPER one finance signed; refusing them for a
      // missing contract is exactly the gap this change closed, and neither may
      // come back as `incapable` either.
      expect(kie, `${entryKey(entry)} Kie leg must no longer be refused`).toBeUndefined();
      expect(decision.ordered[0]?.leg.relay).toBe('Kie');
    }
  });

  it('passes the synthetic full matrix with independent leg accounting and a positive floor', () => {
    let nonEmpty = 0;
    let configurations = 0;
    const singleLegEntries = activeEntries.filter((entry) => entry.legs.length === 1);

    for (const entry of activeEntries) {
      for (const durationSeconds of durationBoundaries(entry)) {
        for (const references of referenceBoundaries(entry)) {
          for (const frames of [[], ['first'], ['first', 'last']] as const) {
            for (const audio of [false, true]) {
              configurations += 1;
              const decision = selectRoute(
                requestFor(entry, { durationSeconds, references, frames, audio }),
                now,
              );
              const ordered = decision.ordered.map((candidate) => candidate.leg);
              const rejected = decision.rejected.flatMap((rejection) =>
                isCostLeg(rejection.leg) ? [rejection.leg] : [],
              );
              const seen = [...ordered, ...rejected].map((leg) => executableIdentity(leg));
              expect([...seen].sort()).toEqual(
                entry.legs.map((leg) => executableIdentity(leg)).sort(),
              );
              expect(new Set(seen).size).toBe(seen.length);
              expect(
                decision.ordered.every(
                  (candidate, index, all) =>
                    index === 0 || all[index - 1]!.landedRubTotal <= candidate.landedRubTotal,
                ),
              ).toBe(true);
              expect(
                decision.rejected.every((rejection) =>
                  [
                    'incapable',
                    'capability_unknown',
                    'uncosted',
                    'loss_making',
                    'unhealthy',
                    'official_leg_excluded',
                  ].includes(rejection.reason),
                ),
              ).toBe(true);
              expect(
                decision.ordered.length > 0 ||
                  decision.rejected.some(
                    (rejection) => rejection.reason !== 'official_leg_excluded',
                  ),
              ).toBe(true);
              if (decision.ordered.length > 0) nonEmpty += 1;
            }
          }
        }
      }
    }

    expect(singleLegEntries.length).toBeGreaterThan(0);
    expect(configurations).toBeGreaterThan(0);
    expect(nonEmpty).toBeGreaterThanOrEqual(50);
  });

  it('is pure by source audit, deep-freeze safety, and deterministic output', () => {
    const source = readFileSync(new URL('./select-route.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      'Date.now(',
      'new Date(',
      'process.env',
      'Math.random(',
      "require('fs'",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    const entry = activeEntries.find((candidate) => candidate.modelId === 'wan-2-7')!;
    const mutable = requestFor(entry, { durationSeconds: 5 });
    const frozen = deepFreeze({
      ...mutable,
      entry: { ...entry, legs: entry.legs.map((leg) => ({ ...leg })) },
    });
    expect(() => selectRoute(frozen, now)).not.toThrow();
    expect(selectRoute(mutable, now)).toEqual(selectRoute(mutable, now));
  });

  it('pins and prints the complete deterministic offline disagreement sweep', () => {
    const models = new Map(seedModels.map((model) => [model.id, model]));
    const activeEntriesForSweep = sweepCases();
    expect(
      activePriceRows.every((row) =>
        activeEntriesForSweep.some((candidate) => sweepRowMatchesEntry(row, candidate.entry)),
      ),
    ).toBe(true);
    const casesWithModels = activeEntriesForSweep.map(({ row, entry }) => {
      const model = models.get(row.modelId);
      if (!model) throw new Error(`${priceRowKey(row)} seed model missing`);
      return { row, model, entry };
    });
    const entryKeys = casesWithModels.map(({ entry }) => entryKey(entry));
    expect(new Set(entryKeys).size).toBe(entryKeys.length);

    const disagreements: RouteDisagreementOracleEntry[] = [];
    const legacyNotKnowable: RouteDisagreementOracleEntry[] = [];
    for (const { row, model, entry } of casesWithModels) {
      const durationSeconds =
        routeContracts[modelIdForEntry(entry)]?.find((contract) => contract.duration)?.duration
          ?.default ?? null;
      const references = row.refsMin > 0 ? (row.refsMax ?? row.refsMin) : 0;
      const decision = selectRoute(
        requestFor(entry, {
          durationSeconds,
          references,
          audio: row.audio,
        }),
        now,
      );
      const newChoice = decision.ordered[0]?.leg.relay.toLowerCase() ?? null;
      const rawLegacyChoice = realGateway(model as unknown as BreakEvenModel);
      const legacyFallback = fallbackGatewayOf(model as unknown as BreakEvenModel);
      const legacyChoice = rawLegacyChoice || 'legacy_not_statically_knowable';

      if (!rawLegacyChoice) {
        legacyNotKnowable.push(
          oracleShape(
            row,
            entry,
            newChoice,
            legacyChoice,
            legacyFallback,
            'The legacy answer depends on request or environment state; no static gateway is invented for this report.',
          ),
        );
        continue;
      }

      const oldPrimaryRelay = legacyPrimaryRelay(rawLegacyChoice);
      if (newChoice !== oldPrimaryRelay) {
        const verdict = ROUTE_DISAGREEMENT_ORACLE.find(
          (finding) => finding.rowKey === priceRowKey(row) && finding.entry === entryKey(entry),
        )?.verdict;
        if (!verdict) {
          throw new Error(
            `${priceRowKey(row)} ${entryKey(entry)} is missing a hand-authored verdict`,
          );
        }
        disagreements.push(
          oracleShape(row, entry, newChoice, rawLegacyChoice, legacyFallback, verdict),
        );
      }
    }

    disagreements.sort((a, b) => a.rowKey.localeCompare(b.rowKey));
    legacyNotKnowable.sort((a, b) => a.rowKey.localeCompare(b.rowKey));
    console.info(
      `route-engine disagreement sweep ${JSON.stringify(
        { disagreements, legacyNotKnowable },
        null,
        2,
      )}`,
    );
    expect(disagreements).toEqual(ROUTE_DISAGREEMENT_ORACLE);
    expect(legacyNotKnowable).toEqual(LEGACY_NOT_STATICALLY_KNOWABLE_ORACLE);
  });
});
