import type { ContractGateway } from './model-contract';

/** The display-cased relay labels emitted by finance's cost export. */
export type FinanceRelay = 'Kie' | 'OpenRouter' | 'LaoZhang' | 'AtlasCloud';

/** Gateway keys accepted by the provider adapter registry. */
export type AdapterGateway = ContractGateway | 'openrouter-official';

/**
 * Finance relay labels are data, while adapter keys are dispatch names. Keep the
 * translation explicit so a new relay cannot silently fall through to Evolink.
 */
export const RELAY_TO_ADAPTER_GATEWAY: Readonly<Record<FinanceRelay, AdapterGateway>> = {
  Kie: 'kie',
  OpenRouter: 'openrouter',
  LaoZhang: 'laozhang',
  // Arrived with finance's rev. 12, which restored the AtlasCloud reserve on
  // gemini-omni-flash t2v. The adapter and the gateway key already existed; only
  // the translation was missing, which is precisely the silent fall-through this
  // map exists to prevent — the guard in select-route.test.ts caught it on import.
  // Note this makes the relay TRANSLATABLE, not reachable: no AtlasCloud leg is
  // wired in model-contract-byteplus.ts, so nothing can route to it yet.
  AtlasCloud: 'atlascloud',
};

const ADAPTER_GATEWAY_TO_RELAY: Readonly<Record<string, FinanceRelay>> = {
  kie: 'Kie',
  openrouter: 'OpenRouter',
  laozhang: 'LaoZhang',
  atlascloud: 'AtlasCloud',
};

/** Normalize one CSV relay for the capability registry join. */
export function contractGatewayForRelay(relay: string): ContractGateway | null {
  const gateway = relay.toLowerCase();
  if (
    gateway === 'kie' ||
    gateway === 'openrouter' ||
    gateway === 'laozhang' ||
    gateway === 'atlascloud'
  ) {
    return gateway;
  }
  return null;
}

/** Resolve one adapter gateway to the finance relay it can price. */
export function relayForAdapterGateway(gateway: string): FinanceRelay | null {
  return ADAPTER_GATEWAY_TO_RELAY[gateway.toLowerCase()] ?? null;
}

/**
 * Chains are adapter plans, not priced legs. Their order is part of the contract:
 * the official OpenRouter entry is capped insurance and is never a route candidate.
 */
export const CHAIN_RELAY_EXPANSIONS: Readonly<
  Record<'nanobanana' | 'geminiomni', readonly AdapterGateway[]>
> = {
  nanobanana: ['laozhang', 'kie', 'openrouter-official'],
  geminiomni: ['kie', 'atlascloud', 'openrouter-official'],
};

/**
 * Per-rung leg order, where finance's signed order disagrees with the chain's.
 *
 * {@link CHAIN_RELAY_EXPANSIONS} is ONE list shared by every model on the chain and by
 * every resolution rung. Finance signs per model AND per rung, and for
 * `gemini-3-1-flash-image` those two disagree in opposite directions, so no single list
 * can be right (rev. 13, `Маржа ноги` on the t2i legs):
 *
 * | rung | нога1              | нога2              |
 * |------|--------------------|--------------------|
 * | 1K   | Kie      **28,49%**| LaoZhang     1,67% |
 * | 2K   | LaoZhang **27,32%**| Kie         20,72% |
 * | 4K   | LaoZhang **40,30%**| Kie          2,31% |
 *
 * The chain runs LaoZhang first, so 1K sells at 1,67% — finance's reserve leg, live.
 * Flipping the chain to kie-first would fix 1K and take 4K from 40,30% to 2,31%, and it
 * would also move four other models that share the chain (gpt-image-2 measures 29,86–
 * 72,37% on LaoZhang and has no signed kie leg at all). Hence a table, not a flip.
 *
 * This is a slice of the Phase 3b route engine, not the engine: it reorders legs that are
 * already armed, wired and priced. It never adds a leg, never picks an unpriced one, and
 * the capped `openrouter-official` insurance leg is not nameable here — unnamed legs keep
 * their relative order after the named ones, so the last-resort leg stays last.
 */
export interface SignedLegOrder {
  readonly modelId: string;
  /** Price-key rung, upper-cased, or 'default' for a model with one rung. */
  readonly rung: string;
  /** Priced gateways, best margin first. */
  readonly order: readonly AdapterGateway[];
  /** The signed margin per gateway, so a drift is auditable against the export. */
  readonly signedMargin: Readonly<Partial<Record<AdapterGateway, number>>>;
  readonly sourceRef: string;
}

export const SIGNED_CHAIN_LEG_ORDER: readonly SignedLegOrder[] = [
  {
    modelId: 'gemini-3-1-flash-image',
    rung: '1K',
    order: ['kie', 'laozhang'],
    signedMargin: { kie: 0.2849, laozhang: 0.0167 },
    sourceRef: 'rev13:НОГИ (экспорт) gemini-3-1-flash-image|1K|t2i',
  },
  {
    modelId: 'gemini-3-1-flash-image',
    rung: '2K',
    order: ['laozhang', 'kie'],
    signedMargin: { laozhang: 0.2732, kie: 0.2072 },
    sourceRef: 'rev13:НОГИ (экспорт) gemini-3-1-flash-image|2K|t2i',
  },
  {
    modelId: 'gemini-3-1-flash-image',
    rung: '4K',
    order: ['laozhang', 'kie'],
    signedMargin: { laozhang: 0.403, kie: 0.0231 },
    sourceRef: 'rev13:НОГИ (экспорт) gemini-3-1-flash-image|4K|t2i',
  },
];

/**
 * Configurations finance signs as having no second leg.
 *
 * This is deliberately a small, hand-curated slice of the export rather than a second
 * routing engine: it stops runtime and margin governance from treating a reserve-less
 * price as if it could safely serve a different output. The source binding test keeps
 * this table tied to `cost-legs.csv`; a status change in either direction must be a
 * deliberate change to both the signed data and this runtime guard.
 */
export interface SingleLegConfiguration {
  readonly modelId: string;
  /** Finance's price-key rung; quality tiers such as GPT Image 2 remain `default`. */
  readonly rung: string;
  // `refs-2-8` is a reference BAND, not a modality — the export keys a row by it the
  // same way it keys one by a mode, and rev. 19 signs flux 2K under it, so the union
  // has to admit it or the table cannot quote the row.
  readonly mode: 't2i' | 'i2i' | 't2v' | 'i2v' | 'r2v' | 'refs-2-8';
  /** The relay finance signs as leg 1; a reserve-less row still has a real serving door. */
  readonly gateway: AdapterGateway;
  readonly sourceRef: string;
}

export const SINGLE_LEG_CONFIGURATIONS: readonly SingleLegConfiguration[] = [
  {
    modelId: 'flux-2-pro',
    rung: '2K',
    mode: 't2i',
    gateway: 'kie',
    sourceRef: 'Сетка FX стр.104',
  },
  // The two configurations we sold uncosted until rev. 19 signed them. Same flat 15
  // credits as 2K text-to-image because kie bills the image and does not meter the
  // input, and depth 1 for a reason that is arithmetic rather than policy: OpenRouter
  // bills per MEGAPIXEL and 2K is four times the area, so no reserve clears any floor.
  {
    modelId: 'flux-2-pro',
    rung: '2K',
    mode: 'i2i',
    gateway: 'kie',
    sourceRef: 'Сетка FX стр.105',
  },
  {
    modelId: 'flux-2-pro',
    rung: '2K',
    mode: 'refs-2-8',
    gateway: 'kie',
    sourceRef: 'Сетка FX стр.106',
  },
  {
    modelId: 'gemini-3-pro-image',
    rung: '1K',
    mode: 't2i',
    gateway: 'laozhang',
    sourceRef: 'Сетка FX стр.34',
  },
  {
    modelId: 'gemini-3-pro-image',
    rung: '1K',
    mode: 'i2i',
    gateway: 'laozhang',
    sourceRef: 'Сетка FX стр.95',
  },
  {
    modelId: 'gemini-3-pro-image',
    rung: '2K',
    mode: 't2i',
    gateway: 'laozhang',
    sourceRef: 'Сетка FX стр.46',
  },
  // Rev. 21 moves Wan i2v 720p/1080p to ladder depth 2: Kie is the signed primary
  // and OpenRouter is the signed reserve on export rows 93–96 (Сетка FX стр.77/78).
  // They therefore must not be treated as reserve-less configurations here.
  {
    modelId: 'seedance-2-0-reference-to-video',
    rung: '4K',
    mode: 'r2v',
    gateway: 'kie',
    sourceRef: 'Сетка FX стр.66',
  },
  {
    modelId: 'seedance-2-0',
    rung: '4K',
    mode: 't2v',
    gateway: 'kie',
    sourceRef: 'Сетка FX стр.15',
  },
];

function normalizedSingleLegRung(modelId: string, rung: string | undefined): string {
  // GPT Image 2's low/medium/high values are the quality column under one finance
  // `default` rung. Keeping that normalization here prevents the runtime request
  // alias from missing the signed configuration it actually prices.
  if (modelId === 'gpt-image-2' && ['low', 'medium', 'high'].includes(rung ?? '')) {
    return 'default';
  }
  return rung ?? 'default';
}

export function isSingleLegConfiguration(
  modelId: string,
  rung: string | undefined,
  mode: string | undefined,
): boolean {
  const normalizedRung = normalizedSingleLegRung(modelId, rung);
  return SINGLE_LEG_CONFIGURATIONS.some(
    (configuration) =>
      configuration.modelId === modelId &&
      configuration.rung === normalizedRung &&
      (mode === undefined || configuration.mode === mode),
  );
}

/**
 * `undefined` is the only wildcard here, and 'any' is deliberately NOT one.
 *
 * The string means two opposite things depending on who says it. On a price row it means
 * "this row serves every mode", so the margin gate must widen — it converts its own 'any'
 * to `undefined` before calling in. Out of `priceModeForRequest` it means "the model's
 * contract could not be read" (pricing-mode.ts:53), which is the reverse: nothing is
 * known, so nothing may be suppressed. Accepting 'any' as a wildcard here would let an
 * unreadable contract strip a reserve that finance did sign — Wan 2.7 at 720p is the live
 * shape, and rev. 21 gives both i2v and t2v the same two-leg ladder.
 */

/**
 * Return the finance-signed first relay for a reserve-less configuration.
 * Unknown or conflicting matches return null: runtime construction must keep the
 * normal chain rather than guess a relay that finance did not sign.
 */
export function singleLegGateway(
  modelId: string,
  rung: string | undefined,
  mode?: string,
): AdapterGateway | null {
  const normalizedRung = normalizedSingleLegRung(modelId, rung);
  const matches = SINGLE_LEG_CONFIGURATIONS.filter(
    (configuration) =>
      configuration.modelId === modelId &&
      configuration.rung === normalizedRung &&
      (mode === undefined || configuration.mode === mode),
  );
  const gateways = new Set(matches.map((configuration) => configuration.gateway));
  return gateways.size === 1 ? matches[0]!.gateway : null;
}

/**
 * The signed order for one (model, rung), or null to keep the chain's own order.
 *
 * Returning null is the safe default: an unknown model or an unrung request runs exactly
 * the path it ran before this table existed.
 */
export function signedChainLegOrder(
  modelId: string,
  rung: string | undefined,
): readonly AdapterGateway[] | null {
  const key = (rung ?? 'default').toUpperCase();
  return (
    SIGNED_CHAIN_LEG_ORDER.find((r) => r.modelId === modelId && r.rung.toUpperCase() === key)
      ?.order ?? null
  );
}

/**
 * Apply a signed order to armed legs. Named legs come first in the signed order; every
 * other leg (notably the capped `openrouter-official` insurance) keeps its relative
 * position after them. A named leg that is not armed is simply absent — this reorders,
 * it never conjures a leg.
 */
export function orderLegsBySignedOrder<T extends { name: string }>(
  legs: readonly T[],
  order: readonly AdapterGateway[] | null,
): readonly T[] {
  if (!order || legs.length < 2) return legs;
  const rank = (name: string) => {
    const i = order.indexOf(name.toLowerCase() as AdapterGateway);
    return i === -1 ? order.length : i;
  };
  // Stable sort: legs outside `order` all share rank `order.length` and so keep their
  // original relative order, which is what pins the last-resort leg last.
  return [...legs]
    .map((leg, i) => ({ leg, i }))
    .sort((a, b) => rank(a.leg.name) - rank(b.leg.name) || a.i - b.i)
    .map((x) => x.leg);
}

/** Adapter gateways with executable paths but no signed cost rows. */
export const UNCOSTED_ADAPTER_GATEWAYS = {
  // AtlasCloud left this set on 2026-08-09: finance's rev. 12 signed its
  // gemini-omni-flash t2v leg at $0.112/s, so it now HAS a row in cost-legs.csv.
  // It is still not reachable — no contract is wired — but that is a capability
  // gap, tracked by CAPABILITY_UNKNOWN_GATEWAY_ABSENT, not a costing gap.
  evolink: {
    reason: 'Evolink has an adapter but no row in seed/cost-legs.csv.',
  },
} as const;

/** Live arming state for the gateways that have a Phase 3a finance relay. */
export interface GatewayArming {
  kie: boolean;
  laozhang: boolean;
  openrouter: boolean;
  atlascloud: boolean;
}

export type GatewayArmingEnv = Readonly<Record<string, string | undefined>>;

function liveArmed(env: GatewayArmingEnv, modeKey: string, keyKey: string): boolean {
  return (env[modeKey] ?? '').toLowerCase() === 'live' && Boolean(env[keyKey]);
}

/** Read only the explicit live-mode + API-key gates; a missing key is unarmed. */
export function gatewayArmingFromEnv(env: GatewayArmingEnv): GatewayArming {
  return {
    kie: liveArmed(env, 'KIE_MODE', 'KIE_API_KEY'),
    laozhang: liveArmed(env, 'LAOZHANG_MODE', 'LAOZHANG_API_KEY'),
    openrouter: liveArmed(env, 'OPENROUTER_MODE', 'OPENROUTER_API_KEY'),
    atlascloud: liveArmed(env, 'ATLASCLOUD_MODE', 'ATLASCLOUD_API_KEY'),
  };
}

/** Whether a known priced leaf is armed. Unknown/legacy names stay visible to
 * older callers; they are not silently treated as one of these four relays. */
export function isGatewayArmed(gateway: string, arming: GatewayArming): boolean {
  switch (gateway.toLowerCase()) {
    case 'kie':
      return arming.kie;
    case 'laozhang':
      return arming.laozhang;
    case 'openrouter':
    case 'openrouter-official':
      return arming.openrouter;
    case 'atlascloud':
      return arming.atlascloud;
    default:
      return true;
  }
}

/** The official fallback is intentionally absent from ContractGateway. */
export const OFFICIAL_OPENROUTER_CONTRACT_GAP =
  'openrouter-official is a capped insurance leg and has no ContractGateway member.';
