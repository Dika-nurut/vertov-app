import type { InferInsertModel } from 'drizzle-orm';
import { models } from '../schema/models';

type ModelRow = InferInsertModel<typeof models>;

const BYTEPLUS_BASE = '/api/v3'; // resolved against BYTEPLUS_BASE_URL at runtime
const VOLC_BASE = '/api/v3';
const SEEDANCE_BOARD_SETTINGS = {
  durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  resolutions: ['480p', '720p', '1080p'],
  aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'],
};
const SEEDANCE_FAST_BOARD_SETTINGS = {
  ...SEEDANCE_BOARD_SETTINGS,
  // OpenRouter's current Fast schema stops at 720p; 1080p is standard-only.
  resolutions: ['480p', '720p'],
};
const BOARD_IMAGE_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

/**
 * Full ByteDance catalog seed (per stack-and-mvp-v2.md §1.3).
 * Active set: seedream-4-5, seedance-2-0, seedance-2-0-fast (2.0 minimum —
 * no Seedance 1.0 line, 2026-07-02).
 * Latency: image p50/p95 = 5000/12000; video fast = 120000/240000; video std = 240000/420000.
 * (Video p50s measured against live Seedance 2.0 via OpenRouter — ~3–5 min real;
 * drives the /generate ETA + progress pacing, NOT billing.)
 *
 * ## Sell prices live ONLY in the workbook (2026-07-28 phase 1.4; field purged
 * ## 2026-09-02, P-11b)
 *
 * There is no per-model credit rate here at all: a model with no active
 * `model_price_points` row is refused (`packages/credits/src/pricing.ts`), and
 * the cheapest-per-unit figure the UI sorts by (`minUnitCredits`) is projected
 * server-side from those same active rows. The legacy `creditCostPerUnit`
 * ceiling column was dropped (migration 0110) — the last reader treated it as
 * display-only, and it had drifted from the real rungs it was meant to bound.
 */
export const seedModels: ModelRow[] = [
  // === Image — Seedream family ===
  {
    id: 'seedream-3-0',
    provider: 'byteplus',
    family: 'seedream',
    variant: '3.0',
    kind: 'image',
    isActive: false,
    tierMin: 'free',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '2048x2048',
    providerModelId: 'seedream-3-0',
    providerEndpoint: `${BYTEPLUS_BASE}/images/generations`,
  },
  {
    id: 'seedream-4-5',
    provider: 'byteplus',
    family: 'seedream',
    // Displayed label is `${family} ${variant}` → "Seedream 4.5". The model IS
    // 4.5 (provider id doubao-seedream-4.5 / OpenRouter bytedance-seed/seedream-4.5).
    // Row id renamed to 'seedream-4-5' 2026-07-25 (previously keyed by the old
    // 4.0-era id; the parked stub row that held this id was deleted in the same
    // change).
    variant: '4.5',
    kind: 'image',
    // RETIRED 2026-08-10 by owner ruling: only the Seedream 5.0 family ships. The row is
    // deactivated, not deleted — existing jobs, the public gallery and job history all
    // resolve this id, and migrations here are forward-only. The cost export still prices
    // seedream-4-5, which is fine: finance may cost a model we no longer sell.
    isActive: false,
    tierMin: 'free',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '4096x4096',
    providerModelId: 'doubao-seedream-4.5',
    providerEndpoint: `${BYTEPLUS_BASE}/images/generations`,
    // Kie serves Seedream 4.5 natively (seedream/4.5-text-to-image +
    // seedream/4.5-edit, both $0.0325/img; slugs verified against kie docs
    // 2026-07-25). OpenRouter remains the distinct availability fallback.
    fallbackGateway: 'openrouter',
    // edit: Seedream 4.x does instruction-based editing natively (SeedEdit
    // lineage) — both gateways route ref-image requests to the edit variant.
    // negativePrompt: the MODEL honours a `negative_prompt` field, but the ACTIVE
    // OpenRouter route never serializes it (only evolink does, and evolink is down),
    // so the control was removed 2026-07-20 — see the capabilities note below.
    // Owner ruling 2026-07-28: kie is the intended cheaper primary; OpenRouter
    // remains the availability fallback while BytePlus direct is down.
    capabilities: {
      multi_image: true,
      reference: true,
      edit: true,
      maxRefs: 14,
      resolutions: ['2K', '4K'],
      aspect_ratios: BOARD_IMAGE_ASPECT_RATIOS,
      // negativePrompt REMOVED 2026-07-20 (DoD 4): it was a dead control on the active
      // OpenRouter route — buildOpenRouterImageBody never serializes negative_prompt (only
      // the evolink-adapter does, and BytePlus/evolink is down). So the UI was advertising a
      // control OR silently drops. Removing it is functionally a no-op (OR ignored it anyway;
      // GenerateClient only sets it when supportsNegativePrompt). RE-ADD when BytePlus/evolink
      // is restored (it becomes the primary again and DOES honor negative_prompt), or if the
      // OR image adapter is wired to forward it.
      forceGateway: 'kie',
      priceUsdPerUnit: 0.0325,
      fallbackUsdPerUnit: 0.04,
    },
  },
  // Seedream 5.0 Lite — kie gateway, same routing dodge as the pro row below.
  // Schema verified against kie's docs (seedream/5-lite-*) 2026-07-24:
  //   `quality` basic=2K/high=3K/ultra=4K is the only resolution lever;
  //   `image_urls` (i2i sibling slug) and 8 aspect ratios. kie bills FLAT
  //   $0.0275/image at any quality → no price-point rows needed, the flat
  //   10-credit rate IS the parametric price (workbook v3: Тарифы!E92).
  {
    id: 'seedream-5-0-lite',
    provider: 'byteplus',
    family: 'seedream',
    variant: '5.0-lite',
    kind: 'image',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '4096x4096',
    providerModelId: 'seedream-5-0-lite',
    providerEndpoint: '/api/v1/jobs/createTask',
    capabilities: {
      forceGateway: 'kie',
      reference: true,
      // Implied by maxRefs 10 and by the route contract (kie's i2i slug takes an
      // `image_urls` ARRAY); the key was simply omitted. Adding it is inert — every
      // consumer reads it only as a fallback for an absent maxRefs, which this row has.
      multi_image: true,
      maxRefs: 10,
      resolutions: ['2K', '3K', '4K'],
      default_resolution: '2K',
      aspect_ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      priceUsdPerUnit: 0.0275,
    },
  },
  // Seedream 5.0 Pro — owner-mandated palette model (2026-07-14), routed via the
  // kie.ai GATEWAY, never BytePlus direct. `provider:'byteplus'` is kept only to
  // avoid an enum migration — it is NOT the gateway (same dodge as the
  // OpenRouter rows below); `capabilities.forceGateway:'kie'` does the routing,
  // and the id must stay slash-free or jobs-routes infers OpenRouter from it.
  // Schema verified against kie's own OpenAPI docs, 2026-07-16 — see
  // docs/strategy/vitrina-prompt-research/06-kie-wiring-verification.md §1:
  //   `image_urls` maxItems 10 → capabilities.reference:true flips the client's
  //   imageRefCapable gate; `quality` basic=1K/high=2K is the only resolution
  //   lever and 2K is the documented ceiling (NOT 4K, unlike the lite row above).
  // Enabled 2026-07-24 (owner): kie price verified $0.035/1K, $0.07/2K;
  // priceUsdPerUnit carries the worst SKU (2K). The real price is the parametric
  // pair from v14 «Сетка FX!AA40/AA41» (1K = 16cr, 2K = 29cr), and an unpriced
  // request is REFUSED rather than billed at any flat rate.
  {
    id: 'seedream-5-0-pro',
    provider: 'byteplus',
    family: 'seedream',
    variant: '5.0-pro',
    kind: 'image',
    isActive: true,
    tierMin: 'creator',
    // Legacy ceiling — the dearest rung actually sold, which since rev. 10's
    // reference band is the 2K multi-reference configuration (38), not the plain 2K
    // render (31). It is not a sell price; it exists so an unrelated legacy display
    // cannot quote under what the resolver charges.
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '2048x2048',
    providerModelId: 'seedream-5-0-pro',
    providerEndpoint: '/api/v1/jobs/createTask',
    capabilities: {
      forceGateway: 'kie',
      reference: true,
      // Implied by maxRefs 10 and by the route contract (kie's i2i slug takes an
      // `image_urls` ARRAY); the key was simply omitted. Adding it is inert — every
      // consumer reads it only as a fallback for an absent maxRefs, which this row has.
      multi_image: true,
      maxRefs: 10,
      resolutions: ['1K', '2K'],
      default_resolution: '1K',
      aspect_ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      priceUsdPerUnit: 0.07,
    },
  },

  // === Image edit ===
  {
    id: 'seededit-v3-0',
    provider: 'byteplus',
    family: 'seedream',
    variant: 'seededit-v3.0',
    kind: 'image-edit',
    isActive: false,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '2048x2048',
    providerModelId: 'seededit-v3-0',
    providerEndpoint: `${BYTEPLUS_BASE}/images/edits`,
  },

  // === Video — Seedance family ===
  {
    id: 'seedance-1-0-lite',
    provider: 'byteplus',
    family: 'seedance',
    variant: '1.0-lite',
    kind: 'video',
    isActive: false,
    tierMin: 'free',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 15,
    maxResolution: '720p',
    providerModelId: 'seedance-1-0-lite',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
  },
  {
    // Deactivated 2026-07-02 — no Seedance 1.0 line, 2.0 minimum. Preset
    // packs that referenced this row now point at 'seedance-2-0-fast'.
    id: 'seedance-1-0-pro-fast',
    provider: 'byteplus',
    family: 'seedance',
    variant: '1.0-pro-fast',
    kind: 'video',
    isActive: false,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-2.0-fast-text-to-video',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
  },
  {
    id: 'seedance-1-0-pro',
    provider: 'byteplus',
    family: 'seedance',
    variant: '1.0-pro',
    kind: 'video',
    isActive: false,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 240000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-1-0-pro',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
  },
  {
    id: 'seedance-1-5-pro',
    provider: 'byteplus',
    family: 'seedance',
    variant: '1.5-pro',
    kind: 'video',
    isActive: false,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 240000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-1-5-pro',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
  },
  {
    id: 'seedance-2-0',
    provider: 'byteplus',
    family: 'seedance',
    variant: '2.0',
    kind: 'video',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 240000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-2.0-text-to-video',
    // OpenRouter stays PRIMARY (cheaper); kie wired as availability FALLBACK on an OR
    // SUBMIT failure (CircuitBreakerAdapter falls back on any submit error, not just
    // an outage; a post-submit OR failure refunds, it does not re-run on kie). Owner
    // 2026-07-20; kie slugs paid-verified, see kie-adapter.ts.
    fallbackGateway: 'kie',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
    // forceGateway: BytePlus direct down 2026-07-02 — pinned to OpenRouter
    // (`bytedance/seedance-2.0`, verified live, ~2x cheaper than Volcengine
    // direct too) as primary until BytePlus is restored. Remove once back.
    capabilities: {
      ...SEEDANCE_BOARD_SETTINGS,
      audio: true,
      frames: ['first', 'last'],
      forceGateway: 'openrouter',
      default_resolution: '480p',
      // PRIMARY leg = OpenRouter `bytedance/seedance-2.0`, worst SOLD rung 1080p
      // $0.340/s (model-catalog.md §3). Was absent entirely — one of the five
      // models invisible to the margin guard (data audit §3-B8).
      priceUsdPerUnit: 0.34,
      // FALLBACK leg = kie `bytedance/seedance-2` 1080p $0.51/s (model-catalog.md
      // §3): 50% dearer than the primary, so failover must be checked, not assumed.
      fallbackUsdPerUnit: 0.51,
    },
  },
  {
    id: 'seedance-2-0-fast',
    provider: 'byteplus',
    family: 'seedance',
    variant: '2.0-fast',
    kind: 'video',
    // DEC-2: affordable in-Старт default video (180кр/s → 720кр at the 4s floor,
    // within the 1200кр/cycle Старт allowance). Activated so it shows in /v1/models.
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 15,
    maxResolution: '720p',
    providerModelId: 'seedance-2-0-fast',
    // OpenRouter stays PRIMARY (cheaper); kie wired as availability FALLBACK on an OR
    // SUBMIT failure (CircuitBreakerAdapter falls back on any submit error, not just
    // an outage; a post-submit OR failure refunds, it does not re-run on kie). Owner
    // 2026-07-20; kie slugs paid-verified, see kie-adapter.ts.
    fallbackGateway: 'kie',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
    // Seedance 2.0 Fast emits native audio (verified live via OpenRouter
    // 2026-06-21: generate_audio:true → AAC track in the output).
    // forceGateway: BytePlus direct down 2026-07-02 — pinned to OpenRouter
    // (`bytedance/seedance-2.0-fast`, verified live) as primary until BytePlus
    // is restored. Remove once back.
    capabilities: {
      ...SEEDANCE_FAST_BOARD_SETTINGS,
      audio: true,
      frames: ['first', 'last'],
      forceGateway: 'openrouter',
      default_resolution: '480p',
      // PRIMARY leg = OpenRouter, worst SOLD rung 720p $0.121/s (model-catalog.md
      // §3; 1080p/4K are not sold on this row). Was absent (data audit §3-B8).
      priceUsdPerUnit: 0.121,
      // FALLBACK leg = kie `bytedance/seedance-2-fast` 720p $0.165/s.
      fallbackUsdPerUnit: 0.165,
    },
  },
  {
    // Reference-to-video (previz cast lock): up to 9 reference stills carry the
    // character/location across shots. Image and audio references stay enabled;
    // video-reference attachment is deliberately unavailable on both routes.
    // Kie documents that field, but OpenRouter is this row's primary and has not
    // verified it; do not advertise it until routing can select the safe leg.
    id: 'seedance-2-0-reference-to-video',
    provider: 'byteplus',
    family: 'seedance',
    variant: '2.0-reference',
    kind: 'video',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 240000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-2.0-reference-to-video',
    // OpenRouter stays PRIMARY (cheaper); kie wired as availability FALLBACK on an OR
    // SUBMIT failure (CircuitBreakerAdapter falls back on any submit error, not just
    // an outage; a post-submit OR failure refunds, it does not re-run on kie). Owner
    // 2026-07-20; kie slugs paid-verified, see kie-adapter.ts.
    fallbackGateway: 'kie',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
    // forceGateway: BytePlus direct down 2026-07-02 — already OpenRouter-
    // primary per the comment above; pinned explicitly rather than relying on
    // the env default. Remove once BytePlus is confirmed back.
    capabilities: {
      ...SEEDANCE_BOARD_SETTINGS,
      audio: true,
      reference: true,
      multi_image: true,
      maxRefs: 9,
      maxVideoRefs: 0,
      maxAudioRefs: 3,
      // Common-denominator reference guard: Kie rejects any reference side
      // above 6000px (observed 2026-07-29). OpenRouter has no published larger
      // limit in the captured contract, so keep the safer fallback ceiling until
      // a paid route probe proves a wider shared capability.
      referenceMaxDimension: 6000,
      forceGateway: 'openrouter',
      // PRIMARY leg = OpenRouter, which bills r2v OUTPUT at the t2v ladder
      // (model-catalog.md:71) — worst sold rung 1080p $0.340/s. Was absent (§3-B8).
      priceUsdPerUnit: 0.34,
      // FALLBACK leg = kie. Conservatively the t2v 1080p rate $0.51/s: kie's
      // with-video rates ($0.31/s @1080p) apply to (input+output) seconds, which we
      // do not bill and cannot attest, so the output-only ladder is the safe basis.
      fallbackUsdPerUnit: 0.51,
    },
  },
  {
    id: 'seedance-2-0-fast-reference-to-video',
    provider: 'byteplus',
    family: 'seedance',
    variant: '2.0-fast-reference',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 15,
    maxResolution: '720p',
    providerModelId: 'seedance-2.0-fast-reference-to-video',
    // OpenRouter stays PRIMARY (cheaper); kie wired as availability FALLBACK on an OR
    // SUBMIT failure (CircuitBreakerAdapter falls back on any submit error, not just
    // an outage; a post-submit OR failure refunds, it does not re-run on kie). Owner
    // 2026-07-20; kie slugs paid-verified, see kie-adapter.ts.
    fallbackGateway: 'kie',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
    // audio: Seedance 2.0 Fast supports native audio (verified live 2026-06-21).
    // forceGateway: BytePlus direct down 2026-07-02 — pinned to OpenRouter as
    // primary until BytePlus is restored. Remove once back.
    capabilities: {
      ...SEEDANCE_FAST_BOARD_SETTINGS,
      audio: true,
      reference: true,
      multi_image: true,
      maxRefs: 9,
      maxVideoRefs: 0,
      maxAudioRefs: 3,
      // Same common-denominator cap as the standard reference route; see the
      // production O-6 pre-reservation guard and its dated evidence.
      referenceMaxDimension: 6000,
      forceGateway: 'openrouter',
      // PRIMARY leg = OpenRouter, r2v output billed at the t2v ladder — worst sold
      // rung 720p $0.121/s. Was absent (data audit §3-B8).
      priceUsdPerUnit: 0.121,
      // FALLBACK leg = kie t2v 720p $0.165/s, same conservative basis as the
      // full-size twin above.
      fallbackUsdPerUnit: 0.165,
    },
  },
  {
    id: 'seedance-2-0-standard',
    provider: 'byteplus',
    family: 'seedance',
    variant: '2.0-standard',
    kind: 'video',
    isActive: false,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 240000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 15,
    maxResolution: '1080p',
    providerModelId: 'seedance-2-0-standard',
    providerEndpoint: `${BYTEPLUS_BASE}/videos/generations`,
  },

  // === OpenRouter multi-engine catalog (curated first batch, 2026-06-30) ===
  // These rows route through the OpenRouter GATEWAY (not BytePlus): the slug-
  // shaped `providerModelId` ('vendor/model') is used verbatim by the adapter,
  // and jobs-routes forces `__gateway:'openrouter'` for any slash-bearing id.
  // `provider:'byteplus'` is kept only to avoid an enum migration — it is NOT
  // the gateway (see research/archive/openrouter-model-expansion-2026-06-30.md §1).
  //
  // All seeded `isActive:false` pending owner review. `capabilities` is synced
  // from the live OpenRouter capability schema (scripts/sync-openrouter-models.ts):
  //   resolutions/aspect_ratios/durations = the rendered UI option space (S4),
  //   frames = i2v anchor slots ([] = t2v-only), audio = native-audio support,
  //   passthrough = vendor extras, priceUsdPerUnit = worst SKU we offer (USD),
  //   read by the margin guardrail test (apps/api/__tests__/model-margin...).
  // Margin discipline vs priceUsdPerUnit lives in the workbook guardrail tests
  // (worst-case credit revenue rate: Creator sub ≈ 0.331 ₽/cr, ~80 ₽/$).
  {
    id: 'veo-3-1-fast',
    provider: 'byteplus',
    family: 'Veo',
    variant: '3.1 Fast',
    kind: 'video',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 8,
    maxResolution: '1080p',
    providerModelId: 'google/veo-3.1-fast',
    providerEndpoint: '/videos',
    // Routed to kie (owner directive 2026-07-19) — see veo-3-1 note. kie-only.
    gatewayOverride: 'kie',
    capabilities: {
      audio: true,
      reference: false,
      // First/last-frame conditioning IS delivered on kie: buildKieVeoBody submits
      // generationType FIRST_AND_LAST_FRAMES_2_VIDEO with the frame image(s)
      // (docs.kie.ai veo/generate, wired 2026-07-19).
      frames: ['first', 'last'],
      durations: [4, 6, 8],
      // 720p and 1080p both delivered inline on /veo/generate (live-verified
      // 2026-07-19). 4K is priced but inactive until its two-step delivery path
      // is wired, so it is not advertised.
      resolutions: ['720p', '1080p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16'],
      // kie's veo route has no negativePrompt/personGeneration/enhancePrompt params
      // (owner ruling 2026-07-19: drop rather than advertise-and-silently-ignore).
      passthrough: [],
      // COGS on the routed Kie leg is $0.325/clip @1080p. This legacy capability
      // field remains normalized to the 8s reference ($0.325/8) for the margin
      // model; customer billing uses the finance-signed clip price point.
      priceUsdPerUnit: 0.040625,
    },
  },
  {
    id: 'veo-3-1',
    provider: 'byteplus',
    family: 'Veo',
    variant: '3.1',
    kind: 'video',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 300000,
    maxDurationSeconds: 8,
    maxResolution: '1080p',
    providerModelId: 'google/veo-3.1',
    providerEndpoint: '/videos',
    // Routed to kie (owner directive 2026-07-19): the parametric price was computed
    // off kie COGS. gatewayOverride='kie' beats the slash-id⇒OpenRouter inference
    // (jobs-routes.ts) — the ONLY way to reroute a slash id. Live-smoked through the
    // kie adapter 2026-07-19 (real generation, correct slug/endpoint). kie-only: no
    // fallbackGateway (no OR failover, owner) — a kie outage fails the job, not a
    // dear-vendor loss. Prod applies via /admin/models PATCH (onConflict preserves it).
    gatewayOverride: 'kie',
    capabilities: {
      audio: true,
      reference: false,
      // First/last-frame conditioning IS delivered on kie: buildKieVeoBody submits
      // generationType FIRST_AND_LAST_FRAMES_2_VIDEO with the frame image(s)
      // (docs.kie.ai veo/generate, wired 2026-07-19).
      frames: ['first', 'last'],
      durations: [4, 6, 8],
      // 720p and 1080p both delivered inline on /veo/generate (live-verified
      // 2026-07-19). 4K is priced but inactive until its two-step delivery path
      // is wired, so it is not advertised.
      resolutions: ['720p', '1080p'],
      default_resolution: '1080p',
      aspect_ratios: ['16:9', '9:16'],
      // kie's veo route has no negativePrompt/personGeneration/enhancePrompt params
      // (owner ruling 2026-07-19: drop rather than advertise-and-silently-ignore).
      passthrough: [],
      // COGS on the routed Kie leg is $1.275/clip @1080p. This legacy capability
      // field remains normalized to the 8s reference for the margin model;
      // customer billing uses the finance-signed clip price point.
      priceUsdPerUnit: 0.159375,
    },
  },
  {
    id: 'veo-3-1-lite',
    provider: 'byteplus',
    family: 'Veo',
    variant: '3.1 Lite',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 90000,
    expectedLatencyMsP95: 180000,
    maxDurationSeconds: 8,
    maxResolution: '1080p',
    providerModelId: 'google/veo-3.1-lite',
    providerEndpoint: '/videos',
    // Routed to kie (owner directive 2026-07-19) — see veo-3-1 note. kie-only.
    gatewayOverride: 'kie',
    capabilities: {
      audio: true,
      reference: false,
      // First/last-frame conditioning IS delivered on kie: buildKieVeoBody submits
      // generationType FIRST_AND_LAST_FRAMES_2_VIDEO with the frame image(s)
      // (docs.kie.ai veo/generate, wired 2026-07-19).
      frames: ['first', 'last'],
      durations: [4, 6, 8],
      // 720p and 1080p both delivered inline on /veo/generate (live-verified
      // 2026-07-19). 4K is priced but inactive until its two-step delivery path
      // is wired, so it is not advertised.
      resolutions: ['720p', '1080p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16'],
      // kie's veo route has no negativePrompt/personGeneration/enhancePrompt params
      // (owner ruling 2026-07-19: drop rather than advertise-and-silently-ignore).
      passthrough: [],
      // COGS on the routed Kie leg is $0.175/clip @1080p. This legacy capability
      // field remains normalized to the 8s reference for the margin model;
      // customer billing uses the finance-signed clip price point.
      priceUsdPerUnit: 0.021875,
    },
  },
  {
    id: 'grok-imagine-video',
    provider: 'byteplus',
    family: 'Grok',
    variant: 'Imagine',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 90000,
    expectedLatencyMsP95: 180000,
    maxDurationSeconds: 6,
    maxResolution: '720p',
    providerModelId: 'x-ai/grok-imagine-video',
    providerEndpoint: '/videos',
    // Routed to kie (owner directive 2026-07-19) — see veo-3-1 note. kie-only.
    // grok's 24/45-token price only clears on the cheap kie leg ($0.008–0.015/s).
    gatewayOverride: 'kie',
    capabilities: {
      audio: false,
      reference: false,
      // grok is wired text-to-video only (buildGrokVideoBody). kie DOES publish a
      // grok-imagine/image-to-video slug (single-image i2v); re-add frames:['first']
      // once that route is wired. 1080p is not a grok option — 480p/720p only.
      frames: [],
      durations: [6],
      resolutions: ['480p', '720p'],
      default_resolution: '480p',
      aspect_ratios: ['16:9', '9:16'],
      passthrough: [],
      // Cost on the ROUTED kie leg: worst sold rung 720p $0.015/s (480p is $0.008/s),
      // owner list 2026-07-25 via model-catalog.md §3. Was 0.05 — a conservative
      // placeholder from before the per-resolution rates were known.
      priceUsdPerUnit: 0.015,
    },
  },
  {
    id: 'happyhorse-1-1',
    provider: 'byteplus',
    family: 'HappyHorse',
    variant: '1.1',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 10,
    maxResolution: '1080p',
    providerModelId: 'alibaba/happyhorse-1.1',
    // OpenRouter stays PRIMARY (cheaper); kie wired as availability FALLBACK on an OR
    // SUBMIT failure (CircuitBreakerAdapter falls back on any submit error, not just
    // an outage; a post-submit OR failure refunds, it does not re-run on kie). Owner
    // 2026-07-20; kie slugs paid-verified, see kie-adapter.ts.
    fallbackGateway: 'kie',
    providerEndpoint: '/videos',
    capabilities: {
      audio: false,
      reference: false,
      frames: ['first'],
      durations: [4, 6, 8, 10],
      resolutions: ['720p', '1080p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16', '1:1'],
      passthrough: [],
      // Owner-confirmed 2026-07-24: we SELL 1080p, so the worst SKU is the
      // 1080p rate $0.1278/s (not the old 720p-only 0.0988).
      // PRIMARY leg = OpenRouter `alibaba/happyhorse-1.1`, worst sold rung 1080p
      // $0.1278/s.
      //
      // The kie fallback leg was UNCOSTED until 2026-08-04 because kie published it
      // only in kie-CREDITS with no citable USD conversion. The owner's pricing
      // screen closes that: kie lists 1080p at 29 credits/s = $0.145 and 720p at
      // 22.5 = $0.1125, which fixes the kie credit at $0.005 — confirmed on 14
      // independent rows and consistent with the seedance card (208 cr = $1.04).
      // See vendor-api/kie-pricing-video.md. $0.145 is the 1080p rate, matching the
      // 1080p reference config this row is scored at (274 credits / 5 s) → 19.6%,
      // a thin but real fallback, no longer a hole.
      priceUsdPerUnit: 0.1278,
      fallbackUsdPerUnit: 0.145,
    },
  },
  {
    // WITHDRAWN 2026-08-04 — finance ruling Q8, and the harder reason underneath it.
    //
    // Q8: 1.0 costs 32.6% more than 1.1 for the same output and has no second leg, and
    // we do not charge more for an older version of the same model. 1.1 serves t2v, i2v
    // and r2v at both rungs, cheaper — nothing is lost by removing this.
    //
    // The harder reason: the price export no longer carries a t2v row for 1.0 at all,
    // only the two video-edit rows. A live model whose selected mode has no signed
    // price is the middle state — a picker offering something the price table does not
    // price. Video-edit is the one mode 1.0 serves that 1.1 does not, and there is no
    // `happyhorse-1-0-video-edit` entry to attach it to yet; when there is, this comes
    // back with the prices already correct.
    id: 'happyhorse-1-0',
    provider: 'byteplus',
    family: 'HappyHorse',
    variant: '1.0',
    kind: 'video',
    isActive: false,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 10,
    maxResolution: '1080p',
    providerModelId: 'alibaba/happyhorse-1.0',
    providerEndpoint: '/videos',
    capabilities: {
      audio: false,
      reference: false,
      frames: ['first'],
      durations: [4, 6, 8, 10],
      resolutions: ['720p', '1080p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16', '1:1'],
      passthrough: [],
      // Owner-confirmed 2026-07-24: we SELL 1080p, so the worst SKU is the
      // 1080p rate $0.1694/s (1.0 is pricier than 1.1 at 1080p).
      priceUsdPerUnit: 0.1694,
    },
  },
  {
    id: 'sora-2-pro',
    provider: 'byteplus',
    family: 'Sora',
    variant: '2 Pro',
    kind: 'video',
    isActive: false, // owner drop 2026-07-16
    tierMin: 'creator',
    unitKind: 'second',
    expectedLatencyMsP50: 180000,
    expectedLatencyMsP95: 420000,
    maxDurationSeconds: 20,
    maxResolution: '1080p',
    providerModelId: 'openai/sora-2-pro',
    providerEndpoint: '/videos',
    capabilities: {
      audio: true,
      reference: false,
      // t2v-only: no first/last frame conditioning.
      frames: [],
      durations: [4, 8, 12, 16, 20],
      resolutions: ['720p', '1080p'],
      aspect_ratios: ['16:9', '9:16'],
      passthrough: ['quality', 'style'],
      // Real paid test call 2026-07-02 (4s @ 1080p via OpenRouter):
      // providerCostUsd=2 → $0.50/s, NOT the $0.30/s 720p-only figure this was
      // priced against. Our UI allows 1080p (resolutions above), so this is
      // the true worst-case SKU. Margin guardrail still clears 30% at $0.50/s.
      priceUsdPerUnit: 0.5,
    },
  },
  // Fallback: fal.ai `fal-ai/kling-video/v3/standard/image-to-video` — real
  // page fetched 2026-07-02, $0.084(no audio)/$0.126(audio) — exact price
  // parity with OpenRouter, confirmed directly (not subagent-sourced).
  {
    id: 'kling-v3-0-std',
    provider: 'byteplus',
    family: 'Kling',
    variant: 'v3.0',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 10,
    maxResolution: '720p',
    providerModelId: 'kwaivgi/kling-v3.0-std',
    providerEndpoint: '/videos',
    capabilities: {
      audio: true,
      reference: false,
      frames: ['first', 'last'],
      durations: [5, 10],
      resolutions: ['720p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16', '1:1'],
      // No `negative_prompt`: the OpenRouter body-builder never serializes it, so the
      // Board must not advertise it (DoD 4, registry negativePrompt:false). Dropped
      // 2026-07-20; `cfg_scale` stays (a real Kling lever, kept for future wiring).
      passthrough: ['cfg_scale'],
      priceUsdPerUnit: 0.126,
    },
  },
  // Fallback: NOT wired yet, flagged not hidden. DashScope Intl direct is the
  // real cost-optimal target (20-47% cheaper per prior research) but its
  // pricing console wasn't fetchable directly this session (blocked/JS-
  // rendered) and going direct needs a new adapter — no shortcut here. kie.ai
  // also carries Wan 2.7 (`market/wan/2-7-text-to-video`, real slug confirmed
  // 2026-07-02, ~$0.08/s per a real paid job from the prior session) but our
  // KieAdapter is image-only today — video support isn't built. OpenRouter is
  // the only genuinely working source right now; the cheaper options are real
  // engineering work, not a documentation gap.
  {
    id: 'wan-2-7',
    provider: 'byteplus',
    family: 'Wan',
    variant: '2.7',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    // Legacy per-second ceiling: the dearest rung is now 1080p i2v at 321 credits
    // over 5 seconds → ceil(64.2) = 65.
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 10,
    maxResolution: '1080p',
    providerModelId: 'alibaba/wan-2.7',
    providerEndpoint: '/videos',
    // Routed kie-PRIMARY with OpenRouter FALLBACK (owner directive 2026-07-20).
    // kie is cheaper than the OpenRouter leg it fronts — 720p $0.08/s vs ~$0.10/s
    // (both live-verified against docs/platform/model-catalog.md;
    // Alibaba-direct measured $0.10/$0.15 on 2026-07-20, NOT cheaper, so not chosen).
    // gatewayOverride='kie' beats the slash-id⇒OpenRouter inference (jobs-routes.ts).
    // Unlike veo/grok (kie-only), Wan KEEPS an OpenRouter fallback for SUBMIT-time
    // failures: a frame-bearing job the kie t2v route rejects, or a kie submit
    // outage, re-runs on OpenRouter (CircuitBreakerAdapter.generate) instead of
    // failing. NOTE the fallback covers submit only — a kie failure AFTER submit
    // (poll/asset stage) refunds the job, it does NOT re-run on OpenRouter. Also
    // requires KIE_API_KEY armed in prod (already true — veo/grok are kie-pinned);
    // an unarmed kie throws at adapter construction before the fallback is built.
    // Prod applies via /admin/models PATCH; seed onConflict COALESCE preserves an
    // admin re-route.
    gatewayOverride: 'kie',
    fallbackGateway: 'openrouter',
    capabilities: {
      audio: true,
      reference: false,
      frames: ['first', 'last'],
      durations: [4, 6, 8, 10],
      resolutions: ['720p', '1080p'],
      default_resolution: '720p',
      aspect_ratios: ['16:9', '9:16', '1:1'],
      // No `negative_prompt`: it was an advertised-but-dead control — neither the kie
      // primary (buildWanVideoBody) nor the OpenRouter fallback serializes it, so the
      // Board must not offer it (DoD 4, registry says negativePrompt:false). Dropped
      // 2026-07-20; `prompt_extend` stays (a real Wan lever, kept for future wiring).
      passthrough: ['prompt_extend'],
      // Worst SKU we expose on the kie primary route: 1080p = $0.12/s (720p is
      // $0.08/s). price-breakeven.ts reads this as the fail-closed COGS ceiling, so
      // it must be the WORST case, not the cheapest tier. (Was 0.1 for OpenRouter.)
      priceUsdPerUnit: 0.12,
      // FALLBACK leg = OpenRouter `alibaba/wan-2.7` $0.15/s @1080p (model-catalog.md
      // §3) — 25% dearer than the kie primary, and the reason failover needs its own
      // margin check.
      fallbackUsdPerUnit: 0.15,
    },
  },
  // Fallback: fal.ai `fal-ai/flux-2-pro` — real page fetched 2026-07-02,
  // identical formula ($0.03 first MP + $0.015/additional MP) — exact price
  // parity with OpenRouter, confirmed directly.
  {
    id: 'flux-2-pro',
    provider: 'byteplus',
    family: 'FLUX',
    variant: '2 Pro',
    kind: 'image',
    isActive: true,
    tierMin: 'creator',
    // Dearest priced rung: the 2K row, signed in rev. 13 at 15/1 and on sale since
    // rev. 14. The ceiling is a MARGIN-REPORT input, not a sales one.
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '2048x2048',
    providerModelId: 'black-forest-labs/flux.2-pro',
    providerEndpoint: '/images',
    // kie PRIMARY, OpenRouter FALLBACK (owner ruling 2026-08-04). kie is $0.025/img
    // at the 1K tier we sell vs OpenRouter's $0.03 — 41.6% margin against 26.0% at
    // our 13-credit price. The fallback carries a thinner margin and that is fine:
    // the fallback floor is 0%, not 25% (ruling R-1) — refusing to fail over would
    // turn a vendor outage into ours.
    //
    // Until 2026-08-04 this row had NEITHER field set, so the slash-form
    // providerModelId inferred OpenRouter and kie was never called — while the
    // finance workbook had already made kie the primary leg and derived a proposed
    // 11-credit price from it. That price is only sound once this routing exists;
    // applying it on the OpenRouter leg alone would have sold flux at 12.5%.
    gatewayOverride: 'kie',
    fallbackGateway: 'openrouter',
    capabilities: {
      reference: true,
      multi_image: true,
      edit: true,
      maxRefs: 8,
      // Two rungs since rev. 14, and the DECLARED list is what `priceSelectorFromParams`
      // keys the price on — a rung named here must have an active price row with the same
      // name or the charge is refused. Both do (1K = 11, 2K = 15). The OpenRouter fallback
      // leg exposes no size control; kie, the primary, does, and its enum stops at 2K.
      resolutions: ['1K', '2K'],
      default_resolution: '1K',
      // Also empty only because the registry named OpenRouter the primary route until
      // 2026-08-10. The leg we actually charge is kie, whose text-to-image endpoint takes
      // a 7-value aspect enum, and `buildKieImageBody` has always forwarded it. Corrected
      // together with the role, since `deriveCatalogCapabilities` reads both scalar menus
      // off the same primary.
      aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
      // Cost on the ROUTED PRIMARY leg, which became kie on 2026-08-04: $0.025/img
      // at the 1K tier `buildKieImageBody` pins. This is the number the margin
      // guardrail must read — it checks the leg we actually call, and the previous
      // value (0.03) was OpenRouter's, which is now the fallback.
      //
      // OpenRouter bills $0.03/MEGAPIXEL, not per image, and at the vendor default
      // ~1MP that lands on the same $0.03 — which is why the two were never
      // distinguished. They must be from here on: kie prices per image per tier
      // (1K $0.025 / 2K $0.035), so the two legs no longer scale the same way.
      // The size control arrived in rev. 14, and all three were re-derived together as
      // that comment required: 2K is $0,035 MEASURED (7 kie credits at $0,005, calibrated
      // off the signed 1K leg), `buildKieImageBody` now reads the requested rung, and the
      // rungs are priced 11 and 15. This scalar stays the 1K rate — it is the guardrail's
      // per-image input and the cheap rung is what a bare request buys.
      priceUsdPerUnit: 0.025,
      // The OpenRouter fallback leg, so the guardrail scores it instead of listing
      // flux as an uncosted gap: $0.03/MP at the ~1MP vendor default = 26.0%.
      fallbackUsdPerUnit: 0.03,
    },
  },
  // === Recraft — vector/typography specialist, fills a real gap (Seedream/
  // Nano Banana/Flux are all weak at SVG output and legible in-image text).
  // OpenRouter primary confirmed 2026-07-02 via REAL paid calls (not estimated):
  // recraft-v4 billed $0.04/img, recraft-v4-vector billed $0.08/img — both
  // match fal.ai's official price exactly (fal.ai page fetched directly,
  // $0.04 confirmed), so no markup either way. Fallback: fal.ai
  // (`fal-ai/recraft/v4/text-to-image`), same price, NOT yet paid-call-tested
  // by us (page-price only) — verify before leaning on it under real load.
  // kie.ai checked and ruled out: only utility endpoints (crisp-upscale,
  // background-removal), no full text-to-image generation.
  {
    id: 'recraft-v4',
    provider: 'byteplus',
    family: 'Recraft',
    variant: '4',
    kind: 'image',
    isActive: true,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '1024x1024',
    providerModelId: 'recraft/recraft-v4',
    providerEndpoint: '/images',
    capabilities: {
      reference: true,
      maxRefs: 1,
      resolutions: [],
      aspect_ratios: [],
      priceUsdPerUnit: 0.04,
    },
  },
  {
    id: 'recraft-v4-vector',
    provider: 'byteplus',
    family: 'Recraft',
    variant: '4 Vector',
    kind: 'image',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '1024x1024',
    providerModelId: 'recraft/recraft-v4-vector',
    providerEndpoint: '/images',
    // vector: SVG output (resolution-independent), not a raster raster like
    // the rest of the catalog — downstream consumers should treat the asset
    // as scalable, not fixed-pixel.
    capabilities: {
      reference: true,
      maxRefs: 1,
      resolutions: [],
      aspect_ratios: [],
      vector: true,
      priceUsdPerUnit: 0.08,
    },
  },
  // === Nano Banana family — direct via laozhang.ai/kie.ai, NOT OpenRouter ===
  // Verified 2026-07-02: OpenRouter just passes through Google's own list price
  // (e.g. billed $0.241344 for one 4K gemini-3-pro-image call); laozhang.ai's
  // own pricing API confirms a flat $0.09/generation for the same model,
  // regardless of resolution — ~63% cheaper. `providerModelId` has NO slash
  // (so it does NOT get force-routed to OpenRouter). O-1 (2026-09-02): routing
  // is explicit gatewayOverride:'laozhang' + fallbackGateway:'kie' pins
  // (except the two documented chain-label rows below), admin-visible in
  // /admin/models. `provider:'byteplus'` is the same enum
  // placeholder already used for the OpenRouter rows above — not the gateway.
  {
    id: 'gemini-2-5-flash-image',
    provider: 'byteplus',
    family: 'Nano Banana',
    variant: '2.5 Flash',
    kind: 'image',
    isActive: true,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 5000,
    expectedLatencyMsP95: 12000,
    maxResolution: '1024x1024',
    providerModelId: 'gemini-2.5-flash-image',
    providerEndpoint: '/v1/chat/completions',
    // O-1 (2026-09-02): the real (primary, fallback) pair the 'nanobanana'
    // chain used to build, as first-class routing pins — visible and
    // editable in /admin/models. The laozhang primary is text-to-image
    // only; the kie fallback serves i2i with ≤3 refs. The capped
    // official-OpenRouter tail this family never opted into is gone with
    // the alias (openrouterFallbackSlug absent → it was already inert).
    gatewayOverride: 'laozhang',
    fallbackGateway: 'kie',
    capabilities: {
      reference: true,
      multi_image: true,
      edit: true,
      maxRefs: 3,
      // Gemini 2.5 is fixed at 1K but accepts an explicit aspect ratio.
      resolutions: [],
      aspect_ratios: BOARD_IMAGE_ASPECT_RATIOS,
      // laozhang.ai dashboard-confirmed 2026-07-02 (was $0.04 via OpenRouter).
      priceUsdPerUnit: 0.02,
      // FALLBACK leg = kie `google/nano-banana` $0.02/img (owner list 2026-07-25) —
      // the 2nd leg of the `nanobanana` chain, same rate as the laozhang primary.
      fallbackUsdPerUnit: 0.02,
      // 3rd leg opt-in (migration 0067). Google's own OpenRouter listing, used
      // only when BOTH relays are down. No `officialUsdPerUnit` = no costed rung
      // = the leg REFUSES this row; finance's cap cannot meter what we cannot
      // price (Ask 8, 2026-08-02). Add a per-rung figure here to switch it on.
      openrouterFallbackSlug: 'google/gemini-2.5-flash-image',
    },
  },
  {
    id: 'gemini-3-pro-image',
    provider: 'byteplus',
    family: 'Nano Banana',
    variant: '3 Pro',
    displayName: 'Nano Banana Pro',
    kind: 'image',
    isActive: true,
    tierMin: 'creator',
    unitKind: 'image',
    expectedLatencyMsP50: 20000,
    expectedLatencyMsP95: 45000,
    maxResolution: '4096x4096',
    providerModelId: 'gemini-3-pro-image',
    providerEndpoint: '/v1beta/models/gemini-3-pro-image:generateContent',
    capabilities: {
      reference: true,
      multi_image: true,
      edit: true,
      maxRefs: 8,
      resolutions: ['1K', '2K', '4K'],
      default_resolution: '1K',
      aspect_ratios: BOARD_IMAGE_ASPECT_RATIOS,
      // O-1 (2026-09-02): stays on the legacy 'nanobanana' chain label —
      // deliberately, one of only two rows. This is the only family row with a
      // COSTED official-OpenRouter leg (officialUsdPerUnit 4K = the one figure we
      // hold a real invoice for) AND a signed single-leg configuration set on
      // laozhang (SINGLE_LEG_CONFIGURATIONS). A static (laozhang, kie) pair would
      // strand the paid insurance tail those capabilities arm. Revisit only when
      // the official leg is re-signed or the single-leg rulings lapse.
      forceGateway: 'nanobanana',
      // laozhang.ai dashboard + a real OpenRouter invoice both confirmed
      // 2026-07-02 ($0.241344 billed by OpenRouter for one 4K generation vs
      // laozhang's flat $0.09 — same price regardless of resolution).
      priceUsdPerUnit: 0.09,
      // FALLBACK leg = kie `nano-banana-pro` $0.12/img at 4K (model-catalog.md §4),
      // 33% dearer than the laozhang primary this row is scored on.
      fallbackUsdPerUnit: 0.12,
      // 3rd leg opt-in (migration 0067) — Google's own OpenRouter listing.
      openrouterFallbackSlug: 'google/gemini-3-pro-image',
      // THIRD-leg rate, per RUNG (not a scalar like the two above): OpenRouter
      // passes Google's resolution-tiered list price straight through. $0.241344
      // for one 4K generation is the only figure we hold a real OpenRouter
      // invoice for — it sells at −54.8% margin, which is why finance capped the
      // leg's loss rather than pricing it in (Ask 8, 2026-08-02). 1K and 2K have
      // no invoiced figure, so those rungs are REFUSED on this leg.
      officialUsdPerUnit: { '4K': 0.241344 },
    },
  },
  {
    id: 'gemini-3-1-flash-image',
    provider: 'byteplus',
    family: 'Nano Banana',
    variant: '3.1 Flash',
    kind: 'image',
    isActive: true,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 6000,
    expectedLatencyMsP95: 15000,
    maxResolution: '4096x4096',
    providerModelId: 'gemini-3.1-flash-image',
    providerEndpoint: '/v1/chat/completions',
    capabilities: {
      reference: true,
      multi_image: true,
      edit: true,
      maxRefs: 3,
      resolutions: ['1K', '2K', '4K'],
      default_resolution: '1K',
      aspect_ratios: BOARD_IMAGE_ASPECT_RATIOS,
      // O-1 (2026-09-02): stays on the legacy 'nanobanana' chain label —
      // deliberately, one of only two rows. Finance signs the leg ORDER per
      // rung for this SKU (SIGNED_CHAIN_LEG_ORDER: 1K runs kie first at
      // 28,49%, 2K/4K run laozhang first) — no static (primary, fallback) pair
      // is finance-faithful across the rungs, and the per-request reorder is
      // exactly what the alias's FallbackChainAdapter provides. A static pair
      // would sell 1K at laozhang's 1,67% margin.
      forceGateway: 'nanobanana',
      priceUsdPerUnit: 0.055,
      // FALLBACK leg = kie `nano-banana-2` $0.04/img (owner correction 2026-07-28).
      // The base row previously carried $0.09 — the 4K rate — as if it applied to
      // every tier, which is what forced the 1K price to 28. With the real flat
      // fallback rate the ladder starts at 23, so the customer pays ~18% less at 1K.
      // This is data-audit finding §3-A1: the guard scored the laozhang price above
      // and never saw the kie leg at all, so −9.4% @4K read as +33%. Both legs are
      // checked now, and the 4K tier's own price (50) covers the dearer 4K rung.
      fallbackUsdPerUnit: 0.04,
      // 3rd leg opt-in (migration 0067). Uncosted on that leg → refused there.
      openrouterFallbackSlug: 'google/gemini-3.1-flash-image',
    },
  },
  {
    id: 'gemini-3-1-flash-lite-image',
    provider: 'byteplus',
    family: 'Nano Banana',
    variant: '3.1 Flash Lite',
    kind: 'image',
    isActive: true,
    tierMin: 'free',
    unitKind: 'image',
    expectedLatencyMsP50: 4000,
    expectedLatencyMsP95: 10000,
    maxResolution: '1024x1024',
    providerModelId: 'gemini-3.1-flash-lite-image',
    providerEndpoint: '/v1/chat/completions',
    // Owner ruling 2026-09-02 (O-1 follow-up): pinned to KIE — finance's нога1
    // ($0.02, 32.5% margin). While the row rode the 'nanobanana' alias and then a
    // laozhang pin, it sold on LaoZhang at 15.6% — below the 25% floor — because
    // the chain runs LaoZhang first while finance signed Kie first. Kie is also
    // the CHEAPER leg (owner-confirmed, PAID 2026-07-25), so this is both the
    // margin fix and the better unit economics; LaoZhang becomes the reserve.
    // The maxRefs comment above records the now-irrelevant laozhang ref limit.
    gatewayOverride: 'kie',
    fallbackGateway: 'laozhang',
    capabilities: {
      reference: true,
      multi_image: true,
      edit: true,
      // kie's nano-banana-2-lite doc (owner-supplied 2026-07-24) allows up to
      // 10 image_urls; the kie adapter already slices at 10 for this row.
      maxRefs: 10,
      // Flash Lite is fixed at 1K but supports the Board ratio set.
      resolutions: [],
      aspect_ratios: BOARD_IMAGE_ASPECT_RATIOS,
      // PRIMARY leg = kie `nano-banana-2-lite` $0.02/img (owner-confirmed, PAID
      // 2026-07-25).
      priceUsdPerUnit: 0.02,
      // RESERVE leg = LaoZhang $0.025/img (the conservative basis the primary
      // used to carry).
      fallbackUsdPerUnit: 0.025,
      // 3rd leg opt-in (migration 0067). Uncosted on that leg → refused there.
      openrouterFallbackSlug: 'google/gemini-3.1-flash-lite-image',
    },
  },
  // GPT Image 2 (real OpenAI model, shipped ~Apr 2026) — same reseller-arbitrage
  // shape as Nano Banana: laozhang.ai primary ($0.03/req, 2 real paid calls +
  // C2PA-signature-verified 2026-07), kie.ai fallback (docs-confirmed slugs,
  // price soft ~$0.03, not billing-log-verified — see research/ai-model-
  // sourcing-strategy-2026-07.md §8). Reuses the 'nanobanana' gateway/circuit
  // breaker — it's the shared laozhang/kie pair, not model-specific despite
  // the name. The laozhang PRIMARY is text-to-image only (rejects refs), but the kie
  // FALLBACK serves gpt-image-2-image-to-image with ≤8 input references — so the
  // product DOES accept references (see the capabilities note below).
  {
    id: 'gpt-image-2',
    provider: 'byteplus',
    family: 'GPT Image',
    variant: '2',
    kind: 'image',
    isActive: true,
    tierMin: 'start',
    unitKind: 'image',
    expectedLatencyMsP50: 8000,
    expectedLatencyMsP95: 20000,
    maxResolution: '3840x2160',
    providerModelId: 'gpt-image-2',
    providerEndpoint: '/v1/images/generations',
    // O-1 (2026-09-02): the real (primary, fallback) pair the 'nanobanana'
    // chain used to build, as first-class routing pins — visible and
    // editable in /admin/models. The capped official-OpenRouter tail was
    // already inert on this row (openrouterFallbackSlug absent → refused).
    gatewayOverride: 'laozhang',
    fallbackGateway: 'kie',
    capabilities: {
      // GPT Image 2 accepts up to 8 input references on BOTH routes: the laozhang
      // PRIMARY serves i2i via OpenAI /v1/images/edits (multipart, refs ≤8 —
      // PAID-verified 2026-07-20, multi-image confirmed), and the kie fallback via
      // gpt-image-2-image-to-image (input_urls). Corrected 2026-07-20 (was maxRefs:0,
      // which under-advertised a real capability; the primary was wrongly throwing).
      reference: true,
      multi_image: true,
      maxRefs: 8,
      // quality (low/medium/high) — the vendor's OWN values, not 1K/2K/4K (owner
      // ruling, pricing-correct-catalogue-build.md phase 1.1). Wired into both the
      // laozhang PRIMARY and kie FALLBACK request bodies 2026-07-28 (laozhang-adapter.ts,
      // kie-adapter.ts) and modelled in model-contract-byteplus.ts. Every Board
      // aspect maps to a concrete valid size; arbitrary dimensions stay unoffered.
      resolutions: ['low', 'medium', 'high'],
      default_resolution: 'low',
      aspect_ratios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'],
      // Real paid calls confirmed ~$0.03/req at default size; priced at the
      // doc's conservative worst-case ($0.04-0.05 for high-quality/large size,
      // not billing-log-confirmed) so the margin guardrail holds either way.
      priceUsdPerUnit: 0.05,
      // FALLBACK leg = kie `gpt-image-2-*` $0.08/img at the `high` tier
      // (model-catalog.md §4; 1K $0.03 / 2K $0.05 / 4K $0.08) — the worst rung this
      // row now sells since phase 1.1 wired the quality axis.
      fallbackUsdPerUnit: 0.08,
    },
  },
  // Gemini Omni Flash (Google, announced 2026-06-30 — 2 days before this
  // row was added). Conversational multi-turn video: text/image/video/audio
  // in, video out, character+scene consistency across edit turns — a real
  // capability gap vs Veo/Sora (one-shot generation only). Direct Google
  // access is RU-signup-blocked (same as Veo/Sora); not on OpenRouter yet
  // (too new) or laozhang.ai (checked, not there — an "omni-flash" hit there
  // is Alibaba's unrelated qwen3-omni-flash).
  // Primary: kie.ai `gemini-omni-video` — cheapest real number found
  // ($0.063-0.079/s per the owner's own account pricing dashboard, flat
  // across 720p/1080p, pricier only at 4K), but NOT billing-invoice-verified
  // — a real test call hit 402 insufficient-credits on our account balance.
  // Fallback: AtlasCloud `google/gemini-omni-flash/*-developer` — real,
  // confirmed live via our own AtlasCloud API key ($0.112/s base_price,
  // matches a real observed $0.45/4s@1080p almost exactly), already an
  // active, proven vendor relationship. Routing is the explicit
  // gatewayOverride:'kie' + fallbackGateway:'atlascloud' pair (O-1, 2026-09-02 —
  // was the 'geminiomni' chain label). Text-to-video upgrades to image-to-video when a
  // reference image is attached (same pattern as our Seedance rows).
  {
    id: 'gemini-omni-flash',
    provider: 'byteplus',
    family: 'Gemini Omni',
    variant: 'Flash',
    kind: 'video',
    isActive: true,
    tierMin: 'start',
    unitKind: 'second',
    expectedLatencyMsP50: 120000,
    expectedLatencyMsP95: 240000,
    maxDurationSeconds: 10,
    maxResolution: '720p',
    providerModelId: 'gemini-omni-flash-text-to-video',
    providerEndpoint: '/videos',
    // O-1 (2026-09-02): the real (primary, fallback) pair the 'geminiomni'
    // chain used to build, as first-class routing pins — visible and
    // editable in /admin/models. The alias's official-OpenRouter tail was
    // already inert on this row (video is refused by the official leg's own
    // servability gate; no openrouterFallbackSlug → refused anyway).
    gatewayOverride: 'kie',
    fallbackGateway: 'atlascloud',
    capabilities: {
      audio: true,
      // Kie primary always handles audio as part of the Omni output and does
      // not expose an enable/disable request field.
      audioControl: false,
      // Generic image references, not positional first/last frames. `reference:true`
      // exposes the same generic conditioning channel in Generate/Boards that the
      // Kie/Atlas schemas consume. The product deliberately withholds video/audio
      // reference ports and any multi-reference price band; this is a pricing and
      // routing boundary, not a first-frame claim.
      reference: true,
      // kie's plural image_urls input is generic conditioning, not a positional frame.
      maxVideoRefs: 0,
      maxAudioRefs: 0,
      durations: [4, 6, 8, 10],
      // EMPTY on purpose, and `maxResolution: '720p'` above carries the product.
      // Owner ruling 2026-08-09: omni is a 720p product — we sell one output and the
      // customer has no lever. An empty list is precisely that contract, and it is the
      // reading `priceSelectorFromParams` depends on: it pins the price key to 'default',
      // which is the band finance's export signs (`cost-legs.csv` row 33/34). Naming
      // '720p' here instead would orphan the price row from the signed leg.
      // The old «Kie exposes no resolution control» note WAS wrong (kie really exposes
      // 720p/1080p/4k) but the conclusion holds for a different reason: we do not sell
      // them. The bug this replaced lived in the UI, which read an empty list as missing
      // metadata and offered 480p/1080p anyway — fixed in GenerateClient, not here.
      resolutions: [],
      // kie live-422-verified required enum (2026-07-17).
      aspect_ratios: ['16:9', '9:16'],
      // Worst-case = the fallback's real confirmed price (AtlasCloud
      // $0.112/s), not kie.ai's cheaper but billing-unverified number.
      // Cost on the ROUTED kie leg: $0.079/s (PAID 2026-07-25, model-catalog.md §3).
      // Was 0.112 — the AtlasCloud FALLBACK rate, which named the wrong leg and
      // overstated the primary by 42%.
      priceUsdPerUnit: 0.079,
      // FALLBACK leg = AtlasCloud $0.112/s (PAID, real generation), the 2nd leg of
      // the `geminiomni` chain.
      fallbackUsdPerUnit: 0.112,
    },
  },

  // === Voice — Doubao / Seed-TTS family (parked) ===
  {
    id: 'doubao-tts-zh',
    provider: 'volcengine',
    family: 'doubao-tts',
    variant: 'zh',
    kind: 'voice',
    isActive: false,
    tierMin: 'start',
    unitKind: '1k_chars',
    expectedLatencyMsP50: 2000,
    expectedLatencyMsP95: 5000,
    providerModelId: 'doubao-tts-zh',
    providerEndpoint: `${VOLC_BASE}/tts`,
  },
  {
    id: 'doubao-tts-en',
    provider: 'volcengine',
    family: 'doubao-tts',
    variant: 'en',
    kind: 'voice',
    isActive: false,
    tierMin: 'start',
    unitKind: '1k_chars',
    expectedLatencyMsP50: 2000,
    expectedLatencyMsP95: 5000,
    providerModelId: 'doubao-tts-en',
    providerEndpoint: `${VOLC_BASE}/tts`,
  },
  {
    id: 'seed-tts',
    provider: 'byteplus',
    family: 'seed-tts',
    variant: 'multilingual',
    kind: 'voice',
    isActive: false,
    tierMin: 'creator',
    unitKind: '1k_chars',
    expectedLatencyMsP50: 2000,
    expectedLatencyMsP95: 5000,
    providerModelId: 'seed-tts',
    providerEndpoint: `${BYTEPLUS_BASE}/audio/tts`,
  },
];
