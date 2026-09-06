import { byteplusRouteContracts } from '@seed/shared';
import { OFFICIAL_LEG_GATEWAY } from '@seed/shared/official-leg-cost';
import {
  isSingleLegConfiguration,
  orderLegsBySignedOrder,
  singleLegGateway,
  signedChainLegOrder,
} from '@seed/shared/relay-gateway';
import { BytePlusAdapter } from './adapter';
import { BytePlusClient } from './client';
import { EvolinkAdapter } from './evolink-adapter';
import { EvolinkClient } from './evolink-client';
import { AtlasCloudAdapter } from './atlascloud-adapter';
import { AtlasCloudClient } from './atlascloud-client';
import {
  OpenRouterAdapter,
  OpenRouterClient,
  openRouterImageRouteHasSizeControl,
} from './openrouter-adapter';
import { LaozhangAdapter, LaozhangClient } from './laozhang-adapter';
import { KieAdapter, KieClient } from './kie-adapter';
import { GptprotoAdapter } from './gptproto-adapter';
import { GptprotoClient } from './gptproto-client';
import { NanoBananaAdapter } from './nano-banana-adapter';
import { FallbackChainAdapter } from './fallback-chain-adapter';
import { ServingLegAdapter } from './serving-leg';
import { OfficialOpenRouterFallbackAdapter } from './official-fallback-adapter';
import { officialLegBudget } from './official-leg-budget';
import { CircuitBreakerAdapter } from './circuit-breaker-adapter';
import { StubBytePlusAdapter } from './stub';
import { MockGatewayAdapter } from './mock';
import { JournaledAdapter } from './journaled-adapter';
import { workflowImageControls } from './types';
import type { AttemptJournalPort, ProviderAdapter, WorkflowSpec } from './types';

export * from './types';
export { BytePlusClient } from './client';
export { BytePlusAdapter } from './adapter';
export { EvolinkClient } from './evolink-client';
export { EvolinkAdapter } from './evolink-adapter';
export { AtlasCloudClient } from './atlascloud-client';
export { AtlasCloudAdapter, buildAtlasRequest, imageSizeToPixels } from './atlascloud-adapter';
export { StubBytePlusAdapter } from './stub';
export {
  MockGatewayAdapter,
  parseMockDirective,
  mockErrorFor,
  mockPhaseFor,
  type MockOutcome,
  type MockDirective,
  type MockGatewayOptions,
  type MockCorpusClip,
} from './mock';
export {
  OpenRouterAdapter,
  OpenRouterClient,
  MAX_IMAGE_BATCH,
  buildOpenRouterImageBody,
  buildOpenRouterVideoBody,
  openRouterVideoSlug,
  openRouterImageSlug,
  openRouterImageRouteHasSizeControl,
} from './openrouter-adapter';
export { LaozhangAdapter, LaozhangClient, buildLaozhangImageBody } from './laozhang-adapter';
export { GptprotoAdapter, buildGptprotoImageBody, GP_BATCH_PREFIX } from './gptproto-adapter';
export { GptprotoClient } from './gptproto-client';
export {
  KieAdapter,
  KieClient,
  KIE_CREDIT_USD_RATE,
  KIE_CREDIT_USD_RATE_SOURCE,
  buildKieImageBody,
  buildKieVideoBody,
  buildKieVeoBody,
  kieModelSlug,
} from './kie-adapter';
export { NanoBananaAdapter } from './nano-banana-adapter';
export { FallbackChainAdapter } from './fallback-chain-adapter';
export { ServingLegAdapter, withServingLeg, SERVED_BY, FALLBACK_DEPTH } from './serving-leg';
export { OfficialOpenRouterFallbackAdapter } from './official-fallback-adapter';
export {
  setOfficialLegBudget,
  officialLegBudget,
  type OfficialLegBudget,
  type OfficialLegReservationOutcome,
  type OfficialLegReservationRequest,
} from './official-leg-budget';
export { CircuitBreakerAdapter } from './circuit-breaker-adapter';
export { JournaledAdapter, type JournaledAdapterOptions } from './journaled-adapter';
export { serializeSeedream } from './serializers/seedream';
export { serializeSeedance } from './serializers/seedance';
export { SsrfError, isBlockedIp, assertUrlPublic, guardedRequest, safeLookup } from './net-guard';
export { egressDispatcher, resetEgressDispatcherForTest } from './egress';

export type Gateway =
  | 'atlascloud'
  | 'openrouter'
  | 'nanobanana'
  | 'geminiomni'
  | 'kie'
  | 'gptproto'
  | 'stub'
  | 'mock';

export interface AdapterEnv {
  BYTEPLUS_MODE?: string;
  BYTEPLUS_BASE_URL?: string;
  BYTEPLUS_API_KEY?: string;
  ATLASCLOUD_MODE?: string;
  ATLASCLOUD_BASE_URL?: string;
  ATLASCLOUD_API_KEY?: string;
  OPENROUTER_MODE?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  /** Nano Banana family primary (laozhang.ai) — direct Gemini image access,
   * ~50-63% cheaper than the OpenRouter route (verified 2026-07-02). */
  LAOZHANG_MODE?: string;
  LAOZHANG_BASE_URL?: string;
  LAOZHANG_API_KEY?: string;
  /** Nano Banana family fallback (kie.ai) — circuit-breaker target when
   * laozhang.ai fails, see NanoBananaAdapter. */
  KIE_MODE?: string;
  KIE_BASE_URL?: string;
  KIE_API_KEY?: string;
  /** Gemini-image third relay (gptproto.com) — NB Pro $0.0804 1K/2K (vendor
   * page 2026-09-03). Candidate leg for the nano-banana family. */
  GPTPROTO_MODE?: string;
  GPTPROTO_BASE_URL?: string;
  GPTPROTO_API_KEY?: string;
  /** @deprecated No global default provider; routing is per-model. */
  PROVIDER_GATEWAY?: string;
  /** Deployment stage. When `production`, the dev-only mock/stub gateways are
   * fail-closed unless ALLOW_MOCK_IN_PROD is explicitly armed (see BL-11). */
  NODE_ENV?: string;
  /** Explicit, loud escape hatch to permit the zero-spend mock gateway in a
   * production NODE_ENV. Anything other than '1'/'true' keeps the guard on. */
  ALLOW_MOCK_IN_PROD?: string;
  /** Safe submit refusal is on unless this is explicitly false/off. */
  ROUTE_ENGINE_AT_MOST_ONCE_SUBMIT?: string;
}

export interface AdapterOptions {
  attemptJournal?: AttemptJournalPort;
  safeAtMostOnce?: boolean;
}

export interface AdapterRouteRequest {
  modelId: string;
  rung?: string;
  mode?: string;
}

function safeAtMostOnce(env: AdapterEnv, options: AdapterOptions): boolean {
  if (options.safeAtMostOnce !== undefined) return options.safeAtMostOnce;
  const value = (env.ROUTE_ENGINE_AT_MOST_ONCE_SUBMIT ?? '').toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(value);
}

function journalLeaf(
  gateway: string,
  adapter: ProviderAdapter,
  env: AdapterEnv,
  options: AdapterOptions,
): ProviderAdapter {
  if (!options.attemptJournal) return adapter;
  return new JournaledAdapter(gateway, adapter, options.attemptJournal, {
    safeAtMostOnce: safeAtMostOnce(env, options),
  });
}

/**
 * BL-11 fail-closed guard: the mock (and bare stub) gateways hand out free,
 * fake assets with no provider spend — fine in dev/CI, a revenue/credit
 * backdoor if `AI_PROVIDER=mock` ever leaks into a production NODE_ENV. Mock is
 * permitted UNLESS we're in production without the explicit `ALLOW_MOCK_IN_PROD`
 * escape hatch.
 */
export function isMockProviderAllowed(env: AdapterEnv = process.env as AdapterEnv): boolean {
  const isProd = (env.NODE_ENV ?? '').toLowerCase() === 'production';
  if (!isProd) return true;
  const hatch = (env.ALLOW_MOCK_IN_PROD ?? '').toLowerCase();
  return hatch === '1' || hatch === 'true';
}

/** Thrown by {@link getAdapter} when the mock gateway is refused in production. */
export class MockProviderForbiddenError extends Error {
  constructor() {
    super(
      'mock provider is forbidden when NODE_ENV=production ' +
        '(set ALLOW_MOCK_IN_PROD=1 to override — this serves FREE fake assets)',
    );
    this.name = 'MockProviderForbiddenError';
  }
}

/**
 * Thrown by {@link getAdapter} when a production job would be served by the
 * stub adapter — i.e. the requested gateway is not live-armed (`*_MODE`/`_KEY`
 * missing). A silent stub in prod hands out free fake assets while committing
 * REAL credits, so an unarmed gateway must fail the job loudly instead.
 */
export class StubProviderForbiddenError extends Error {
  constructor(gateway: string) {
    super(
      `gateway '${gateway}' is not live-armed and NODE_ENV=production — refusing ` +
        'to serve stub fake assets for a paid job (arm its *_MODE=live + *_API_KEY, ' +
        'or set ALLOW_MOCK_IN_PROD=1 to override)',
    );
    this.name = 'StubProviderForbiddenError';
  }
}

const ATLASCLOUD_DEFAULT_BASE = 'https://api.atlascloud.ai/api/v1';
const OPENROUTER_DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const LAOZHANG_DEFAULT_BASE = 'https://api.laozhang.ai';
const KIE_DEFAULT_BASE = 'https://api.kie.ai';
const GPTPROTO_DEFAULT_BASE = 'https://gptproto.com';

/**
 * Build the LaoZhang adapter, or the stub when not armed for live use. The
 * image path is inline and its synthetic `lz-img-*` id cannot be polled, so
 * this key is deliberately absent from RESUMABLE_GATEWAYS (see there).
 */
function makeLaozhangAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const mode = (env.LAOZHANG_MODE ?? 'stub').toLowerCase();
  if (mode !== 'live' || !env.LAOZHANG_API_KEY) return new StubBytePlusAdapter();
  const baseUrl = env.LAOZHANG_BASE_URL ?? LAOZHANG_DEFAULT_BASE;
  return journalLeaf(
    'laozhang',
    new LaozhangAdapter(new LaozhangClient({ baseUrl, apiKey: env.LAOZHANG_API_KEY })),
    env,
    options,
  );
}

/**
 * Build the OpenRouter adapter, or the stub when not armed for live use.
 * Unlike the LLM features (live whenever the key exists — pennies), video
 * spend is real money, so this gateway requires the explicit
 * OPENROUTER_MODE=live opt-in on top of the key.
 */
function makeOpenRouterAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const mode = (env.OPENROUTER_MODE ?? 'stub').toLowerCase();
  if (mode !== 'live' || !env.OPENROUTER_API_KEY) return new StubBytePlusAdapter();
  const baseUrl = env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE;
  return journalLeaf(
    'openrouter',
    new OpenRouterAdapter(new OpenRouterClient({ baseUrl, apiKey: env.OPENROUTER_API_KEY })),
    env,
    options,
  );
}

/**
 * Build the AtlasCloud adapter, or the gateway-agnostic stub when AtlasCloud
 * is not configured for live use. Stub mode (or a missing key) keeps dev/test
 * at zero provider spend.
 */
function makeAtlasAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const mode = (env.ATLASCLOUD_MODE ?? 'stub').toLowerCase();
  if (mode !== 'live' || !env.ATLASCLOUD_API_KEY) return new StubBytePlusAdapter();
  const baseUrl = env.ATLASCLOUD_BASE_URL ?? ATLASCLOUD_DEFAULT_BASE;
  return journalLeaf(
    'atlascloud',
    new AtlasCloudAdapter(new AtlasCloudClient({ baseUrl, apiKey: env.ATLASCLOUD_API_KEY })),
    env,
    options,
  );
}

/**
 * Build the Evolink (or direct BytePlus Ark) adapter, or the stub when the
 * gateway is not configured for live use.
 */
function makeEvolinkAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const mode = (env.BYTEPLUS_MODE ?? 'stub').toLowerCase();
  if (mode !== 'live' || !env.BYTEPLUS_API_KEY) return new StubBytePlusAdapter();
  const baseUrl = env.BYTEPLUS_BASE_URL ?? 'https://ark.ap-southeast.bytepluses.com/api/v3';
  if (/evolink/i.test(baseUrl)) {
    return journalLeaf(
      'evolink',
      new EvolinkAdapter(new EvolinkClient({ baseUrl, apiKey: env.BYTEPLUS_API_KEY })),
      env,
      options,
    );
  }
  return journalLeaf(
    'evolink',
    new BytePlusAdapter(new BytePlusClient({ baseUrl, apiKey: env.BYTEPLUS_API_KEY })),
    env,
    options,
  );
}

/**
 * LEGACY chain alias (O-1, 2026-09-02): keep resolving for in-flight jobs queued
 * before the seed moved the Nano Banana family to explicit
 * gatewayOverride:'laozhang' + fallbackGateway:'kie' pairs. New rows must not use
 * it; the admin picker no longer offers it. Serves the same legs the seed pair
 * does, PLUS the capped official-OpenRouter insurance tail when the row opts in —
 * which is why legacy rows keep resolving here until the alias is retired.
 *
 * Build the Nano Banana family adapter — laozhang.ai (primary, direct Gemini
 * access) with kie.ai as a circuit-breaker fallback. If kie.ai isn't
 * live-configured, runs laozhang bare (no silent stub-as-fallback — a
 * misconfigured fallback must not turn into a free-asset backdoor on a
 * primary outage; the job just fails normally, same as any single-adapter
 * gateway would on a provider outage).
 */
// Build the ordered leg list from whatever is live-configured, then wrap in a
// chain. Only genuinely-live adapters become legs — a stub is NEVER a fallback
// (that would hand out free assets on an outage). See docs/platform/backend-providers.md §B3.
// NOTE: an empty chain (no armed leg) returns the zero-spend stub. This is a
// KNOWN pre-existing gap for nano-banana/gemini-omni (a fully-unarmed chain would
// fabricate in prod), deliberately NOT hardened here: throwing at leaf construction
// runs BEFORE getAdapterWithFallback wires the model-level fallback and before the
// worker binds a resume token, so it would defeat a configured armed fallback and
// strand paid resume work (Codex 2026-07-19). The kie-only grok/veo path is fully
// protected instead by makeKieAdapter's KieUnarmedError (no fallback to defeat).
function chainOrSingle(
  legs: { name: string; adapter: ProviderAdapter }[],
  reorder?: (
    legs: readonly { name: string; adapter: ProviderAdapter }[],
    spec: WorkflowSpec,
  ) => readonly { name: string; adapter: ProviderAdapter }[],
): ProviderAdapter {
  if (legs.length === 0) return new StubBytePlusAdapter();
  // A collapsed chain must still name its leg. Returning the bare adapter here
  // dropped the only `servedBy` stamp on the path, so a chain armed with just
  // the official-OpenRouter leg reported itself as plain 'openrouter' and the
  // ~2.7x last-resort leg went uncounted in exactly the outage configuration it
  // exists for. See ServingLegAdapter for why this is not a 1-leg chain.
  if (legs.length === 1) return new ServingLegAdapter(legs[0]!.name, legs[0]!.adapter);
  return new FallbackChainAdapter(legs, reorder);
}

/**
 * Whether a chain leg may serve this request's rung.
 *
 * `fallbackCanHonorRung` was only ever consulted by `getAdapterWithFallback`, and the
 * chain families never reach it: `gpt-image-2` and every gemini row carry
 * `capabilities.forceGateway` with NO `models.fallback_gateway`, so the worker calls
 * `getAdapterWithFallback('nanobanana', undefined, …)`, which returns `getAdapter` before
 * any fallback leg is built. The chain was assembled here instead, by single-leg
 * signature alone, with nothing checking that a reserve can express the rung the customer
 * paid for. gpt-image-2 was covered only by accident — finance signs its one band as
 * single-leg, which drops kie for an unrelated reason.
 *
 * The PRIMARY leg is exempt: it is where the sold rungs live, and an empty chain degrades
 * to the zero-spend stub (see `chainOrSingle`), which is worse than any rung mismatch.
 */
function chainLegServesRung(gateway: string, request: AdapterRouteRequest | undefined): boolean {
  if (!request) return true;
  const inputMode = request.mode ? inputModeForRoute(request.mode) : null;
  const isPrimary = (byteplusRouteContracts[request.modelId] ?? []).some(
    (candidate) =>
      candidate.gateway === gateway &&
      candidate.role === 'primary' &&
      (!inputMode || candidate.inputMode === inputMode),
  );
  return isPrimary || fallbackCanHonorRung(gateway, request);
}

function singleLegChainGateway(request: AdapterRouteRequest | undefined): string | null {
  if (!request || !isSingleLegConfiguration(request.modelId, request.rung, request.mode)) {
    return null;
  }
  // The adapter chain has no mode dimension of its own, but construction has the
  // canonical priced mode on the route request. Passing it through still matters: a
  // configuration can be reserve-less in one mode and not in another at the same rung,
  // and dropping the mode would strip a reserve finance did sign. Wan was the live
  // example until rev. 21 put i2v on the same two-leg ladder as t2v; the mode axis
  // stays because the shape recurs, not because Wan still shows it.
  return singleLegGateway(request.modelId, request.rung, request.mode);
}

/**
 * The official-OpenRouter last-resort leg. Two arming conditions, BOTH required:
 *
 *  - OpenRouter is live-armed (key + `OPENROUTER_MODE=live`), and
 *  - a loss-budget counter has been registered (`setOfficialLegBudget`, done by
 *    the worker at boot against the `official_leg_spend` table).
 *
 * The budget requirement is fail-closed by design: finance's 2026-08-02 ruling
 * (Ask 8) allows this leg only *inside* a metered ₽ cap, so a process that
 * cannot meter it does not get the leg at all — the chain is simply 2-leg there.
 * The leg then applies its own per-row opt-in and per-rung cost gates
 * ({@link OfficialOpenRouterFallbackAdapter}).
 */
function officialOpenRouterLeg(
  env: AdapterEnv,
  options: AdapterOptions = {},
): { name: string; adapter: ProviderAdapter } | null {
  if ((env.OPENROUTER_MODE ?? 'stub').toLowerCase() !== 'live' || !env.OPENROUTER_API_KEY) {
    return null;
  }
  const budget = officialLegBudget();
  if (!budget) return null;
  const baseUrl = env.OPENROUTER_BASE_URL ?? OPENROUTER_DEFAULT_BASE;
  return {
    name: OFFICIAL_LEG_GATEWAY,
    adapter: journalLeaf(
      OFFICIAL_LEG_GATEWAY,
      new OfficialOpenRouterFallbackAdapter(
        new OpenRouterAdapter(new OpenRouterClient({ baseUrl, apiKey: env.OPENROUTER_API_KEY })),
        budget,
      ),
      env,
      options,
    ),
  };
}

// Nano Banana / GPT-Image family: laozhang (cheapest) → kie → official OpenRouter
// (pricier but reliable — survives a Google/OpenAI ban wave that kills BOTH relays).
function makeNanoBananaAdapter(
  env: AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter {
  const legs: { name: string; adapter: ProviderAdapter }[] = [];
  const singleLegGateway = singleLegChainGateway(request);
  const include = (gateway: string) =>
    (singleLegGateway === null || singleLegGateway === gateway) &&
    chainLegServesRung(gateway, request);
  if (
    include('laozhang') &&
    (env.LAOZHANG_MODE ?? 'stub').toLowerCase() === 'live' &&
    env.LAOZHANG_API_KEY
  ) {
    legs.push({
      name: 'laozhang',
      adapter: journalLeaf(
        'laozhang',
        new LaozhangAdapter(
          new LaozhangClient({
            baseUrl: env.LAOZHANG_BASE_URL ?? LAOZHANG_DEFAULT_BASE,
            apiKey: env.LAOZHANG_API_KEY,
          }),
        ),
        env,
        options,
      ),
    });
  }
  if (include('kie') && (env.KIE_MODE ?? 'stub').toLowerCase() === 'live' && env.KIE_API_KEY) {
    legs.push({
      name: 'kie',
      adapter: journalLeaf(
        'kie',
        new KieAdapter(
          new KieClient({
            baseUrl: env.KIE_BASE_URL ?? KIE_DEFAULT_BASE,
            apiKey: env.KIE_API_KEY,
          }),
        ),
        env,
        options,
      ),
    });
  }
  const official = singleLegGateway === null ? officialOpenRouterLeg(env, options) : null;
  if (official) legs.push(official);
  // The construction order above (laozhang → kie → official) is right for most of the
  // family, but finance signs margins per (model, RUNG) and gemini-3-1-flash-image
  // disagrees rung by rung — 1K is 28,5% on kie and 1,7% on laozhang, 4K is the reverse
  // at 40,3% vs 2,3%. Reorder per request instead of flipping a list that five models
  // share. Everything else falls through unchanged (signedChainLegOrder returns null).
  return chainOrSingle(legs, (armed, spec) =>
    orderLegsBySignedOrder(
      armed,
      signedChainLegOrder(spec.modelId, workflowImageControls(spec).resolution),
    ),
  );
}

/**
 * LEGACY chain alias (O-1, 2026-09-02): keep resolving for in-flight jobs queued
 * before the seed moved gemini-omni-flash to gatewayOverride:'kie' +
 * fallbackGateway:'atlascloud'. The seed pair serves the same two legs; this
 * alias additionally assembles the official-OpenRouter tail, which is INERT for
 * that row (video is refused by the official leg's own servability gate, and the
 * row carries no openrouterFallbackSlug), so behavior is identical.
 *
 * Gemini Omni Flash circuit breaker: kie.ai primary (cheapest real-verified
 * price, ~$0.06-0.08/s per the owner's own kie.ai account pricing dashboard —
 * NOT yet billing-invoice-confirmed, our balance was too low to complete a
 * real paid test), AtlasCloud fallback ($0.112/s, confirmed live via our own
 * AtlasCloud API key). Reuses the generic {@link NanoBananaAdapter}
 * circuit-breaker class — it's just (primary, fallback), not Nano-Banana-
 * specific despite the name.
 */
// Gemini Omni Flash video: kie → AtlasCloud → official OpenRouter (last resort,
// only for rows that carry an official slug — video rows may not, so it degrades
// to the kie→atlas 2-leg chain for those).
function makeGeminiOmniAdapter(
  env: AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter {
  const legs: { name: string; adapter: ProviderAdapter }[] = [];
  const singleLegGateway = singleLegChainGateway(request);
  const include = (gateway: string) =>
    (singleLegGateway === null || singleLegGateway === gateway) &&
    chainLegServesRung(gateway, request);
  if (include('kie') && (env.KIE_MODE ?? 'stub').toLowerCase() === 'live' && env.KIE_API_KEY) {
    legs.push({
      name: 'kie',
      adapter: journalLeaf(
        'kie',
        new KieAdapter(
          new KieClient({
            baseUrl: env.KIE_BASE_URL ?? KIE_DEFAULT_BASE,
            apiKey: env.KIE_API_KEY,
          }),
        ),
        env,
        options,
      ),
    });
  }
  if (
    include('atlascloud') &&
    (env.ATLASCLOUD_MODE ?? 'stub').toLowerCase() === 'live' &&
    env.ATLASCLOUD_API_KEY
  ) {
    legs.push({ name: 'atlascloud', adapter: makeAtlasAdapter(env, options) });
  }
  const official = singleLegGateway === null ? officialOpenRouterLeg(env, options) : null;
  if (official) legs.push(official);
  return chainOrSingle(legs);
}

/**
 * kie.ai as a STANDALONE gateway — for models that exist nowhere else in our
 * vendor set (Seedream 5.0 Pro, HappyHorse). Deliberately single-leg, not a
 * breaker chain: laozhang carries neither model, and AtlasCloud's request
 * builder is seedance/gemini-omni-specific, so chaining either would post a
 * body the fallback vendor cannot serve. A loud kie failure beats a silent
 * wrong-vendor request.
 *
 * FAIL-CLOSED in production: models are now pinned to kie as their PRIMARY charged
 * route (grok/veo `gatewayOverride:'kie'`, kie-only). If kie is unarmed there, the
 * job would fall through to the zero-spend stub and we'd CHARGE credits for a
 * fabricated asset — the same danger as the mock gateway, so it gets the same
 * `isMockProviderAllowed` guard. Dev/test still degrades to the stub. Kie is
 * admitted to RESUMABLE_GATEWAYS only when it is live-armed; an accepted Kie
 * task has a vendor id and can therefore be polled safely.
 */
export class KieUnarmedError extends Error {
  constructor() {
    super(
      'kie gateway is routed but UNARMED (KIE_MODE!=live or KIE_API_KEY missing) — ' +
        'refusing the zero-spend stub in production, which would charge for a fabricated asset ' +
        '(set ALLOW_MOCK_IN_PROD=1 to override — serves FREE fake assets)',
    );
    this.name = 'KieUnarmedError';
  }
}

function makeKieAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const apiKey = env.KIE_API_KEY;
  const live = (env.KIE_MODE ?? 'stub').toLowerCase() === 'live';
  if (!live || !apiKey) {
    // Unarmed: fail loud in production (never fabricate via the stub); dev/test stubs.
    // The `!apiKey` early-return also narrows apiKey to a string below.
    if (!isMockProviderAllowed(env)) throw new KieUnarmedError();
    return new StubBytePlusAdapter();
  }
  return journalLeaf(
    'kie',
    new KieAdapter(new KieClient({ baseUrl: env.KIE_BASE_URL ?? KIE_DEFAULT_BASE, apiKey })),
    env,
    options,
  );
}

/**
 * Build the GPTProto adapter, or the stub when not armed for live use. The
 * image path is async (durable prediction id), so the gateway IS resumable.
 */
function makeGptprotoAdapter(env: AdapterEnv, options: AdapterOptions = {}): ProviderAdapter {
  const mode = (env.GPTPROTO_MODE ?? 'stub').toLowerCase();
  if (mode !== 'live' || !env.GPTPROTO_API_KEY) return new StubBytePlusAdapter();
  const baseUrl = env.GPTPROTO_BASE_URL ?? GPTPROTO_DEFAULT_BASE;
  return journalLeaf(
    'gptproto',
    new GptprotoAdapter(new GptprotoClient({ baseUrl, apiKey: env.GPTPROTO_API_KEY })),
    env,
    options,
  );
}

/**
 * Resolve a {@link ProviderAdapter} for the requested gateway. This is the
 * per-job seam the worker calls — chosen by the model's routing pins
 * (capabilities.forceGateway, gatewayOverride, fallbackGateway) or the dev
 * dropdown (persisted in workflow.params.__gateway). There is NO global default
 * provider: every active model must declare explicit routing. An unconfigured/
 * unknown gateway falls back to the zero-spend stub in dev/test; in production
 * that fail-closed throws {@link StubProviderForbiddenError} instead of serving
 * fake assets.
 */
export function getAdapter(
  gateway: Gateway | string | undefined,
  env: AdapterEnv = process.env as AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter {
  if (!gateway) {
    throw new Error(
      'gateway_required: no explicit gateway and no global default provider is configured',
    );
  }
  const key = gateway.toLowerCase();
  if (key === 'mock' && !isMockProviderAllowed(env)) {
    // Fail closed: never construct the free-asset mock gateway in production
    // unless the operator armed the loud ALLOW_MOCK_IN_PROD escape hatch.
    throw new MockProviderForbiddenError();
  }
  const adapter = buildAdapter(key, env, options, request);
  if (adapter instanceof StubBytePlusAdapter && !isMockProviderAllowed(env)) {
    throw new StubProviderForbiddenError(key);
  }
  return adapter;
}

/** Unguarded gateway construction — internal. Callers that build fallback legs
 * use this so an unarmed fallback collapses to "no leg" (checked via
 * `instanceof StubBytePlusAdapter`) rather than throwing the way a stub PRIMARY
 * must in production. */
function buildAdapter(
  key: string,
  env: AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter {
  if (key === 'stub') return new StubBytePlusAdapter();
  if (key === 'mock') return new MockGatewayAdapter();
  if (key === 'atlascloud') return makeAtlasAdapter(env, options);
  if (key === 'openrouter') return makeOpenRouterAdapter(env, options);
  if (key === 'nanobanana') return makeNanoBananaAdapter(env, options, request);
  if (key === 'geminiomni') return makeGeminiOmniAdapter(env, options, request);
  if (key === 'laozhang') return makeLaozhangAdapter(env, options);
  if (key === 'kie') return makeKieAdapter(env, options);
  if (key === 'gptproto') return makeGptprotoAdapter(env, options);
  // Evolink / BytePlus-direct is no longer a supported gateway. Any stale
  // request that reaches here (including the old PROVIDER_GATEWAY=evolink default)
  // now fails loudly instead of silently routing to a dead provider.
  if (key === 'evolink') {
    throw new Error('evolink gateway is no longer supported; set explicit per-model routing');
  }
  throw new Error(`unknown gateway '${key}'`);
}

function inputModeForRoute(mode: string | undefined): 'image' | 'video' | null {
  if (mode === 't2i' || mode === 'i2i') return 'image';
  if (mode === 't2v' || mode === 'i2v' || mode === 'r2v' || mode === 'video-edit') return 'video';
  return null;
}

/**
 * "Finance signed one leg" only justifies dropping the reserve when the leg WE would
 * construct is that signed leg. Where the two diverge — and they do, in both directions
 * (see the pinned list in single-leg-configurations-vs-export.test.ts) — suppressing the
 * reserve strands the job on a vendor the export did not sign for this mode.
 *
 * wan-2-7 i2v is the case that proves it, and it cost a live feature on this branch
 * before deploy. The export signs OpenRouter as the sole i2v leg, correctly: kie's
 * `wan/2-7-image-to-video` route is not wired here, so `assertKieVideoTextToVideoOnly`
 * refuses any frame-bearing job rather than silently rendering plain t2v, and the model
 * row keeps an OpenRouter fallback for exactly that submit-time refusal. Reading depth 1
 * as "drop the reserve" while holding the model row's kie primary removed the rescue the
 * row was built around, and every first/last-frame wan job failed.
 */
function singleLegSuppressesReserve(primaryKey: string, request: AdapterRouteRequest): boolean {
  if (!isSingleLegConfiguration(request.modelId, request.rung, request.mode)) return false;
  const signed = singleLegGateway(request.modelId, request.rung, request.mode);
  // A conflict or an unnamed relay is not permission to strand the job.
  if (!signed) return false;
  // LaoZhang is reached through the nanobanana chain alias, so the row names the alias
  // while the export names the leaf it resolves to.
  // Both chain aliases have to be translated to the leaf they actually build, not just
  // nanobanana. `geminiomni` builds kie first; leaving it untranslated meant the literal
  // 'geminiomni' could never equal a signed 'kie'/'atlascloud', so a signed sole leg on
  // that family would keep its reserve. Inert today (no gemini-omni-flash row is signed
  // single-leg) and it fails in the safe direction, but the test suite's own
  // `runtimePrimaryLeaf` has always modelled the translation this code omitted.
  const constructed =
    primaryKey === 'nanobanana' ? 'laozhang' : primaryKey === 'geminiomni' ? 'kie' : primaryKey;
  return constructed === signed;
}

/** A reserve that renders its own default cannot serve a named non-default rung. */
function fallbackCanHonorRung(key: string, request: AdapterRouteRequest | undefined): boolean {
  if (!request?.rung || request.rung === 'default' || !request.mode) return true;
  const inputMode = inputModeForRoute(request.mode);
  if (!inputMode) return true;

  const routes = byteplusRouteContracts[request.modelId] ?? [];
  const route = routes.find(
    (candidate) => candidate.gateway === key && candidate.inputMode === inputMode,
  );
  // An uncontracted route keeps the pre-contract construction behaviour.
  if (!route) return true;

  const primaryDefault = routes.find(
    (candidate) => candidate.role === 'primary' && candidate.inputMode === inputMode,
  )?.resolution?.default;
  if (
    key === 'openrouter' &&
    inputMode === 'image' &&
    !openRouterImageRouteHasSizeControl(request.modelId)
  ) {
    // EMPTY_MENU means OpenRouter renders its vendor default. The primary contract's
    // default is the only named rung we can prove is that same delivered output.
    return request.rung === primaryDefault;
  }
  if (!route.resolution) return true;
  if (route.resolution.values.length > 0) return route.resolution.values.includes(request.rung);
  return request.rung === primaryDefault;
}

/** Build a fallback leg, or null when it must not serve: unarmed gateways
 * (stub is NEVER a fallback — docs/platform/backend-providers.md §B3) and the mock
 * gateway when the prod guard forbids it. */
function buildFallbackLeg(
  key: string,
  env: AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter | null {
  if (key === 'mock' && !isMockProviderAllowed(env)) return null;
  if (!fallbackCanHonorRung(key, request)) return null;
  const adapter = buildAdapter(key, env, options, request);
  return adapter instanceof StubBytePlusAdapter ? null : adapter;
}

/**
 * Resolve a {@link ProviderAdapter} for a model's (primary, fallback) gateway
 * pair — the general-purpose version of the hardcoded 'nanobanana'/'geminiomni'
 * breakers above. `fallbackGateway` comes from `models.fallback_gateway`
 * (admin-editable, see /admin/models); when unset or equal to the primary,
 * this is just {@link getAdapter} with no breaker wrapping. Used by the worker
 * for every job so ANY model can get automatic failover, not just the two
 * families with a bespoke adapter.
 */
export function getAdapterWithFallback(
  primaryGateway: Gateway | string | undefined,
  fallbackGateway: Gateway | string | null | undefined,
  env: AdapterEnv = process.env as AdapterEnv,
  options: AdapterOptions = {},
  request?: AdapterRouteRequest,
): ProviderAdapter {
  if (!primaryGateway) {
    throw new Error(
      'primary_gateway_required: no explicit primary gateway and no global default provider is configured',
    );
  }
  const primaryKey = primaryGateway.toLowerCase();
  if (request && singleLegSuppressesReserve(primaryKey, request)) {
    // Finance signs one leg for this exact configuration, so the breaker must not be
    // built: a primary outage FAILS the job, which is the intended outcome under the
    // ruling that a price is a promise about the OUTPUT. Serving a downgraded render
    // at the full price is the worse failure; flux 2K forced this branch (see the
    // exposure comment on openRouterImageRouteHasSizeControl in openrouter-adapter.ts).
    // The MODEL ROW still picks the door, deliberately. Letting the signed table pick it
    // instead was implemented on 2026-08-11 and reverted the same day: the four signed
    // configurations that disagree with their model row disagree in BOTH directions, and
    // on wan-2-7 i2v — live and selling — the export named OpenRouter while the row routed
    // to kie, so honouring the export would have silently rerouted paying traffic off the
    // leg our own COGS work chose. (Rev. 21 has since moved that row's signed primary to
    // kie, so the two now agree there; the reasoning stands on the divergences that
    // remain, and the ruling is not re-opened by one of its examples resolving.) A cost export is a statement about money, not a routing
    // instruction. The divergences are pinned instead, in
    // single-leg-configurations-vs-export.test.ts, and seedance 4K — the one case where
    // the disagreement would cost money — is held shut by UNDELIVERABLE_ON_ROUTE.
    return getAdapter(primaryGateway, env, options, request);
  }
  if (!fallbackGateway || fallbackGateway.toLowerCase() === primaryKey) {
    return getAdapter(primaryGateway, env, options, request);
  }
  const fallbackKey = fallbackGateway.toLowerCase();
  // A stub leg is never wired into the breaker: an unarmed fallback must
  // degrade to "primary only", not become a free-asset backdoor on an outage.
  const fallbackAdapter = buildFallbackLeg(fallbackKey, env, options, request);
  if (!fallbackAdapter) return getAdapter(primaryKey, env, options, request);
  return new CircuitBreakerAdapter(
    getAdapter(primaryKey, env, options, request),
    fallbackAdapter,
    primaryKey,
    fallbackKey,
  );
}

/**
 * The gateway keys {@link getAdapter} routes DETERMINISTICALLY to a specific
 * vendor family — i.e. every top-level {@link Gateway} the registry has an
 * explicit branch for. Deliberately excludes the default catch-all: an unknown
 * or removed key (a stale `wan::…`, a chain-leg-only `laozhang`, a typo) would
 * otherwise silently fall through `getAdapter` to a catch-all adapter and poll
 * a foreign provider id against the wrong endpoint. See {@link getResumeAdapter}.
 *
 * Kie is admitted because Phase 3a now has a durable accepted-handle journal:
 * a recovery row proves which vendor minted the async task id. Laozhang stays
 * excluded: its image path is inline and its synthetic handle id cannot be
 * polled, so there is no safe recovery adapter for it.
 */
const RESUMABLE_GATEWAYS: ReadonlySet<string> = new Set([
  'atlascloud',
  'openrouter',
  OFFICIAL_LEG_GATEWAY,
  'kie',
  'gptproto',
  'nanobanana',
  'geminiomni',
  'stub',
  'mock',
]);

/**
 * Resolve the adapter that must resume a persisted provider handle, bound to the
 * gateway that MINTED it (see {@link GenerationHandle.gateway}) — NOT to whatever
 * current routing resolves to. Returns `null` when the gateway is not a
 * deterministic top-level key, or when building it throws (e.g. the mock gateway
 * is fail-closed in production). A `null` result tells the worker the handle
 * cannot be safely re-polled, so it must submit a fresh generation instead
 * (company absorbs the prior provider cost — see docs/platform/provider-output-retry-billing.md).
 */
export function getResumeAdapter(
  gateway: string,
  env: AdapterEnv = process.env as AdapterEnv,
  options: AdapterOptions = {},
): ProviderAdapter | null {
  if (!RESUMABLE_GATEWAYS.has(gateway)) return null;
  if (gateway === OFFICIAL_LEG_GATEWAY) {
    return officialOpenRouterLeg(env, options)?.adapter ?? null;
  }
  // getAdapter intentionally returns a zero-spend stub in test/dev for an
  // unarmed Kie gateway. That is fine for a fresh dev job, but never safe for
  // a persisted provider handle: an accepted Kie id must be polled by Kie or
  // recovery must refuse. An armed Kie adapter is the narrow persistence-fail
  // recovery case permitted by the Phase 3a protocol.
  if (
    gateway === 'kie' &&
    ((env.KIE_MODE ?? 'stub').toLowerCase() !== 'live' || !env.KIE_API_KEY)
  ) {
    return null;
  }
  // Same rule as kie: an unarmed gptproto must never come back as a stub that
  // re-polls a real paid prediction id (the stub would resolve it to nothing and
  // could trigger a second paid submit upstream of the caller).
  if (
    gateway === 'gptproto' &&
    ((env.GPTPROTO_MODE ?? 'stub').toLowerCase() !== 'live' || !env.GPTPROTO_API_KEY)
  ) {
    return null;
  }
  try {
    return getAdapter(gateway, env, options);
  } catch {
    // e.g. MockProviderForbiddenError when mock is refused in production.
    return null;
  }
}
