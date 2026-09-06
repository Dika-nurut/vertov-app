/**
 * Concrete byteplus route-contracts — the first models moved into the
 * modelGatewayContractRegistry (execution plan Phase 1). Each contract is the
 * REAL accepted-parameter surface of one (modelId, gateway, inputMode) leg,
 * transcribed from the adapter body-builders that are today's effective truth
 * (packages/providers/byteplus/src/{openrouter,kie}-adapter.ts) and the paid
 * route tests (docs/platform/model-catalog.md), each carrying its
 * provenance.
 *
 * First batch (3 models) is deliberately the audio-unambiguous Wan/Seedance money
 * path from PR #64 — it exercises both a primary-OpenRouter case (Seedance) and a
 * primary-kie case (Wan), and both the 3-tier and 2-tier resolution shapes.
 * HappyHorse and the reference/image rows follow once their output-audio and
 * reference surfaces are pinned.
 *
 * NEUTRAL types live in `model-contract.ts`; this file is provider-co-located
 * DATA. Phase 2 rewires the adapters to read these instead of the mutable catalog.
 */

import {
  deriveCatalogCapabilities,
  type DurationParamContract,
  type ModelGatewayContract,
  type RegistryManagedCapabilityKey,
} from './model-contract';

const SEEDANCE_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
const SEEDANCE_DURATION_STEPS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] as const;
const WAN_ASPECTS = ['16:9', '9:16', '1:1'] as const;

/** Seedance duration on OpenRouter: buildOpenRouterVideoBody SNAPS every request
 * down to the menu (acceptsIntermediate:false) — the menu happens to be every
 * integer 4..15, so the snap is a no-op here, but the policy is faithful. */
const SEEDANCE_DURATION_OR: DurationParamContract = {
  kind: 'duration',
  steps: SEEDANCE_DURATION_STEPS,
  acceptsIntermediate: false,
  min: 4,
  max: 15,
  default: 5,
  onBelowMin: 'floor',
  onAboveMax: 'clamp',
};

/** Seedance duration on kie: buildSeedanceVideoBody forwards any integer in
 * [4, rowMax] verbatim (acceptsIntermediate:true), clamping only at the ceiling.
 * The exposed menu we advertise is Seedance's step list. */
const SEEDANCE_DURATION_KIE: DurationParamContract = {
  ...SEEDANCE_DURATION_OR,
  acceptsIntermediate: true,
};

/**
 * Seedance 2.0 (standard) — PRIMARY OpenRouter (`bytedance/seedance-2.0`, the
 * cheaper leg), FALLBACK kie on a submit failure. OR serializes generate_audio +
 * frame_images + snapped duration (buildOpenRouterVideoBody); kie accepts generic
 * image/video/audio references but not explicit first/last frames.
 */
const seedance20: ModelGatewayContract[] = [
  {
    modelId: 'seedance-2-0',
    gateway: 'openrouter',
    inputMode: 'video',
    role: 'primary',
    slug: 'bytedance/seedance-2.0',
    resolution: {
      kind: 'enum',
      values: ['480p', '720p', '1080p'],
      default: '720p',
      onInvalid: 'default',
    },
    aspectRatio: { kind: 'enum', values: SEEDANCE_ASPECTS, default: '16:9', onInvalid: 'omit' },
    duration: SEEDANCE_DURATION_OR,
    reference: {
      imageRole: 'frame',
      frameRoles: ['first', 'last'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: true },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-06-21',
      note: 'OpenRouter bytedance/seedance-2.0 live — generate_audio:true → AAC track',
    },
  },
  {
    modelId: 'seedance-2-0',
    gateway: 'kie',
    inputMode: 'video',
    role: 'fallback',
    slug: 'bytedance/seedance-2',
    resolution: {
      kind: 'enum',
      values: ['480p', '720p', '1080p'],
      default: '720p',
      onInvalid: 'default',
    },
    // kie forwards the aspect_ratio string UNCHANGED (asStr passthrough, no enum
    // validation) — defaults to 16:9 only when absent.
    aspectRatio: {
      kind: 'enum',
      values: SEEDANCE_ASPECTS,
      default: '16:9',
      onInvalid: 'passthrough',
    },
    duration: SEEDANCE_DURATION_KIE,
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
    },
    audio: { output: true, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-07-29',
      note: 'kie published API docs (2026-07-29): bytedance/seedance-2 accepts 9 image / 3 video / 3 audio references',
    },
  },
];

/** Seedance 2.0 Fast — same shape as standard but capped at 720p on both legs. */
const seedance20Fast: ModelGatewayContract[] = [
  {
    modelId: 'seedance-2-0-fast',
    gateway: 'openrouter',
    inputMode: 'video',
    role: 'primary',
    slug: 'bytedance/seedance-2.0-fast',
    resolution: { kind: 'enum', values: ['480p', '720p'], default: '720p', onInvalid: 'default' },
    aspectRatio: { kind: 'enum', values: SEEDANCE_ASPECTS, default: '16:9', onInvalid: 'omit' },
    duration: SEEDANCE_DURATION_OR,
    reference: {
      imageRole: 'frame',
      frameRoles: ['first', 'last'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: true },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-06-21',
      note: 'OpenRouter bytedance/seedance-2.0-fast live — native audio confirmed',
    },
  },
  {
    modelId: 'seedance-2-0-fast',
    gateway: 'kie',
    inputMode: 'video',
    role: 'fallback',
    slug: 'bytedance/seedance-2-fast',
    // kie fast has NO 1080p (live 422) — 480p/720p only.
    resolution: { kind: 'enum', values: ['480p', '720p'], default: '720p', onInvalid: 'default' },
    aspectRatio: {
      kind: 'enum',
      values: SEEDANCE_ASPECTS,
      default: '16:9',
      onInvalid: 'passthrough',
    },
    duration: SEEDANCE_DURATION_KIE,
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 9,
      maxVideos: 3,
      maxAudios: 3,
    },
    audio: { output: true, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-07-29',
      note: 'kie published API docs (2026-07-29): bytedance/seedance-2-fast accepts 9 image / 3 video / 3 audio references',
    },
  },
];

/**
 * Wan 2.7 — PRIMARY kie (`wan/2-7-text-to-video`, the cheaper leg), FALLBACK
 * OpenRouter. The kie primary is text-to-video only and emits audio it does not
 * let the caller toggle (output true / control false); the OpenRouter fallback is
 * the leg that actually wires frame_images + generate_audio, which is why the
 * product catalog still advertises frames even though the primary drops them.
 */
const wan27: ModelGatewayContract[] = [
  {
    modelId: 'wan-2-7',
    gateway: 'kie',
    inputMode: 'video',
    role: 'primary',
    slug: 'wan/2-7-text-to-video',
    resolution: { kind: 'enum', values: ['720p', '1080p'], default: '1080p', onInvalid: 'default' },
    // wanAspectRatio validates against {16:9,9:16,1:1} and falls back to 16:9 off-enum.
    aspectRatio: { kind: 'enum', values: WAN_ASPECTS, default: '16:9', onInvalid: 'default' },
    // kie forwards any integer 4..10 verbatim (5/7/9 delivered as asked); above 10 is
    // rejected (assertKieVideoDuration). Exposed menu is [4,6,8,10].
    duration: {
      kind: 'duration',
      steps: [4, 6, 8, 10],
      acceptsIntermediate: true,
      min: 4,
      max: 10,
      default: 5,
      onBelowMin: 'floor',
      onAboveMax: 'reject',
    },
    // Frames are served by a SECOND kie slug, `wan/2-7-image-to-video` — one gateway,
    // two endpoints, which this row's single `slug` field cannot express. Declared here
    // because the capability is real on this gateway as of 2026-08-11; before that a
    // keyframed Wan job was refused on kie and paid the dearer OpenRouter reserve.
    // `last` is listed as a slot the route HAS; a last-only job is still handed to the
    // reserve, which is the leg we have seen serve one.
    reference: {
      imageRole: 'frame',
      frameRoles: ['first', 'last'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: false },
    // The catalog's passthrough:['negative_prompt'] is a DEAD advert — the kie body
    // never sends it (Phase 4 de-advertises it); the truth is the route ignores it.
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-16',
      note: 'live-route-test-plan route #8 wan/2-7-text-to-video 720p/1080p h264+aac. The i2v sibling slug wan/2-7-image-to-video is wired from its captured spec (kie-specs/wan__2-7-image-to-video.md: named first_frame_url/last_frame_url, INTEGER duration, no aspect field) and is NOT yet confirmed by a paid call — one keyframe call settles it. Rates are the owner kie card 2026-08-02.',
    },
  },
  {
    modelId: 'wan-2-7',
    gateway: 'openrouter',
    inputMode: 'video',
    role: 'fallback',
    slug: 'alibaba/wan-2.7',
    resolution: { kind: 'enum', values: ['720p', '1080p'], default: '720p', onInvalid: 'default' },
    aspectRatio: { kind: 'enum', values: WAN_ASPECTS, default: '16:9', onInvalid: 'omit' },
    // OR reads caps.durations [4,6,8,10] and snaps every request to it.
    duration: {
      kind: 'duration',
      steps: [4, 6, 8, 10],
      acceptsIntermediate: false,
      min: 4,
      max: 10,
      default: 4,
      onBelowMin: 'floor',
      onAboveMax: 'clamp',
    },
    reference: {
      imageRole: 'frame',
      frameRoles: ['first', 'last'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: true },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-07-20',
      note: 'OpenRouter alibaba/wan-2.7 fallback leg — schema snapshot, re-pull before locking',
    },
  },
];

/**
 * Seedance 2.0 reference-to-video — the vendor route accepts image, video, and
 * audio references. The catalog deliberately withholds video-reference input until
 * trusted input duration exists to price its input+output-second billing; that is a
 * product/pricing restriction, not a vendor-route restriction.
 *
 * The OpenRouter legs point at the family slugs (`bytedance/seedance-2.0[-fast]`),
 * NOT dedicated `*-reference-to-video` slugs: OR folded the capability into the
 * family slugs and the dedicated ones 404 (audit 2026-08-31, O-5a). Runtime already
 * did this via openRouterVideoSlug's suffix-strip; the contract metadata now agrees.
 */
function seedanceReference(
  modelId: string,
  orSlug: string,
  kieSlug: string,
  resolutions: readonly string[],
  duration: DurationParamContract,
  kieDuration: DurationParamContract,
): ModelGatewayContract[] {
  return [
    {
      modelId,
      gateway: 'openrouter',
      inputMode: 'video',
      role: 'primary',
      slug: orSlug,
      resolution: { kind: 'enum', values: resolutions, default: '720p', onInvalid: 'default' },
      aspectRatio: { kind: 'enum', values: SEEDANCE_ASPECTS, default: '16:9', onInvalid: 'omit' },
      duration,
      reference: {
        imageRole: 'reference',
        frameRoles: [],
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
      },
      audio: { output: true, control: true },
      negativePrompt: false,
      provenance: {
        source: 'verified',
        date: '2026-08-31',
        note: `OpenRouter ${orSlug} live — typed input_references (9 img / 3 vid / 3 aud). OR folded reference-to-video into the family slug (dedicated *-reference-to-video slugs 404 from the endpoints API as of 2026-08-31); adapter strips the suffix (openRouterVideoSlug) and hits this same slug.`,
      },
    },
    {
      modelId,
      gateway: 'kie',
      inputMode: 'video',
      role: 'fallback',
      slug: kieSlug,
      resolution: { kind: 'enum', values: resolutions, default: '720p', onInvalid: 'default' },
      aspectRatio: {
        kind: 'enum',
        values: SEEDANCE_ASPECTS,
        default: '16:9',
        onInvalid: 'passthrough',
      },
      duration: kieDuration,
      reference: {
        imageRole: 'reference',
        frameRoles: [],
        maxImages: 9,
        maxVideos: 3,
        maxAudios: 3,
      },
      audio: { output: true, control: false },
      negativePrompt: false,
      provenance: {
        source: 'snapshot',
        date: '2026-07-29',
        note: `kie published API docs (2026-07-29): ${kieSlug} accepts 9 image / 3 video / 3 audio references`,
      },
    },
  ];
}

const seedance20Reference = seedanceReference(
  'seedance-2-0-reference-to-video',
  'bytedance/seedance-2.0',
  'bytedance/seedance-2',
  ['480p', '720p', '1080p'],
  SEEDANCE_DURATION_OR,
  SEEDANCE_DURATION_KIE,
);

const seedance20FastReference = seedanceReference(
  'seedance-2-0-fast-reference-to-video',
  'bytedance/seedance-2.0-fast',
  'bytedance/seedance-2-fast',
  ['480p', '720p'],
  SEEDANCE_DURATION_OR,
  SEEDANCE_DURATION_KIE,
);

/**
 * Veo 3.1 family (Quality / Fast / Lite) — kie-ONLY (single vendor, no fallback;
 * owner 2026-07-19). kie's dedicated /veo/generate: FIRST_AND_LAST_FRAMES_2_VIDEO
 * with 1–2 frame images, 720p/1080p delivered inline (4K rejected — unwired,
 * unpriced), duration floored to 4s and rejected above 8s, and aspect_ratio SNAPPED
 * to the nearer of {16:9, 9:16} (omniAspectRatio). Audio is model-managed output
 * with no generate_audio toggle. Identical param surface across the three tiers.
 */
function veoContract(modelId: string, slug: string): ModelGatewayContract[] {
  return [
    {
      modelId,
      gateway: 'kie',
      inputMode: 'video',
      role: 'primary',
      slug,
      // buildKieVeoBody delivers 720p/1080p inline; 4K is REJECTED (needs the
      // /veo/get-4k-video two-step, and has no price row) rather than silently
      // downgraded — a per-value guard. Other off-menu resolutions default to 720p.
      resolution: {
        kind: 'enum',
        values: ['720p', '1080p'],
        default: '720p',
        onInvalid: 'default',
        reject: ['4k', '4K'],
      },
      // omniAspectRatio maps any ratio to the nearer of 16:9 / 9:16.
      aspectRatio: { kind: 'enum', values: ['16:9', '9:16'], default: '16:9', onInvalid: 'snap' },
      duration: {
        kind: 'duration',
        steps: [4, 6, 8],
        acceptsIntermediate: true,
        min: 4,
        max: 8,
        default: 8,
        onBelowMin: 'floor',
        onAboveMax: 'reject',
      },
      reference: {
        imageRole: 'frame',
        frameRoles: ['first', 'last'],
        maxImages: 0,
        maxVideos: 0,
        maxAudios: 0,
      },
      audio: { output: true, control: false },
      negativePrompt: false,
      provenance: {
        source: 'verified',
        date: '2026-07-19',
        note: `kie /veo/generate ${slug} live — 720p/1080p inline, FIRST_AND_LAST_FRAMES`,
      },
    },
  ];
}

const veo31 = veoContract('veo-3-1', 'veo3');
const veo31Fast = veoContract('veo-3-1-fast', 'veo3_fast');
const veo31Lite = veoContract('veo-3-1-lite', 'veo3_lite');

/**
 * Grok Imagine video — kie-ONLY, text-to-video only (buildGrokVideoBody rejects any
 * conditioning). 480p/720p (1080p mapped down), aspect snapped to {16:9, 9:16}, the
 * single 6s length (floored to 6, rejected above), no audio. The catalog records the
 * pure-t2v shape as `frames: []`.
 */
const grokImagine: ModelGatewayContract[] = [
  {
    modelId: 'grok-imagine-video',
    gateway: 'kie',
    inputMode: 'video',
    role: 'primary',
    slug: 'grok-imagine/text-to-video',
    resolution: { kind: 'enum', values: ['480p', '720p'], default: '720p', onInvalid: 'default' },
    aspectRatio: { kind: 'enum', values: ['16:9', '9:16'], default: '16:9', onInvalid: 'snap' },
    duration: {
      kind: 'duration',
      steps: [6],
      acceptsIntermediate: false,
      min: 6,
      max: 6,
      default: 6,
      onBelowMin: 'floor',
      onAboveMax: 'reject',
    },
    reference: { imageRole: 'none', frameRoles: [], maxImages: 0, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-16',
      note: 'live-route-test-plan GROK route grok-imagine/text-to-video (paid)',
    },
  },
];

/**
 * Kling v3.0 Standard — OpenRouter-only (single vendor; kie/DashScope fallback not
 * wired). buildOpenRouterVideoBody snaps duration to [5,10] and omits an off-menu
 * aspect. The catalog USED to advertise negative_prompt via passthrough, but the OR
 * body never serializes it — that dead control is de-advertised in this same change
 * (DoD 4), so the contract records negativePrompt:false. `snapshot` provenance: schema
 * only, not paid-verified (DashScope-direct pricing was unfetchable this session).
 */
const klingV30Std: ModelGatewayContract[] = [
  {
    modelId: 'kling-v3-0-std',
    gateway: 'openrouter',
    inputMode: 'video',
    role: 'primary',
    slug: 'kwaivgi/kling-v3.0-std',
    resolution: { kind: 'enum', values: ['720p'], default: '720p', onInvalid: 'default' },
    aspectRatio: {
      kind: 'enum',
      values: ['16:9', '9:16', '1:1'],
      default: '16:9',
      onInvalid: 'omit',
    },
    duration: {
      kind: 'duration',
      steps: [5, 10],
      acceptsIntermediate: false,
      min: 5,
      max: 10,
      default: 5,
      onBelowMin: 'floor',
      onAboveMax: 'clamp',
    },
    reference: {
      imageRole: 'frame',
      frameRoles: ['first', 'last'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: true },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-07-20',
      note: 'OpenRouter kwaivgi/kling-v3.0-std — schema snapshot, not paid-verified',
    },
  },
];

/**
 * IMAGE models — first batch, the "clean" OpenRouter-only ones with NO negativePrompt
 * and NO output-size controls (the current OR endpoint exposes neither, so
 * resolutions/aspect_ratios are the empty menu the seed records). Their only real knobs
 * are `n` (count, billed by unitsForGenerationModel) + reference stills. Seedream is
 * deliberately NOT here — its negativePrompt is route-dependent + preset-coupled and
 * needs an owner decision (see the plan's IMAGE-SIDE SCOPE FINDING).
 */
const EMPTY_MENU = { kind: 'enum', values: [] as const, default: '', onInvalid: 'omit' } as const;

function imageOnlyContract(
  modelId: string,
  slug: string,
  maxRefs: number,
  provNote: string,
): ModelGatewayContract[] {
  return [
    {
      modelId,
      gateway: 'openrouter',
      inputMode: 'image',
      role: 'primary',
      slug,
      // No output-size control on the OR image endpoint → empty menus (matches seed).
      resolution: { ...EMPTY_MENU },
      aspectRatio: { ...EMPTY_MENU },
      reference: {
        imageRole: 'reference',
        frameRoles: [],
        maxImages: maxRefs,
        maxVideos: 0,
        maxAudios: 0,
      },
      audio: { output: false, control: false },
      negativePrompt: false,
      provenance: { source: 'verified', date: '2026-07-02', note: provNote },
    },
  ];
}

/**
 * FLUX.2 Pro — OpenRouter (the menu-defining route) plus the kie leg finance
 * costs as лег 1. kie's route matches OpenRouter's in the dimension the product
 * sells: `buildKieImageBody` sends `input_urls` as an array (1-8 images), per
 * the vendor's own OpenAPI capture (`kie-specs/flux2__pro-image-to-image.md`,
 * required field, `maxItems: 8`, worked two-image example).
 *
 * CORRECTED 2026-08-09: this contract previously pinned `maxImages: 1` because
 * the adapter threw above one reference image, on an assumption about
 * `input_urls`'s shape that was never checked against the spec captured 14
 * minutes earlier in the same session. The adapter now sends the spec's array
 * shape and the `refs-2-8` band carries a signed kie leg at 41.55% margin
 * (`packages/db/seed/cost-legs.csv`). No paid two-reference probe is on record
 * yet — a definitive kie rejection still falls over to OpenRouter via
 * `CircuitBreakerAdapter` (see `isAmbiguousSubmitError` in
 * `packages/providers/byteplus/src/types.ts`), but that covers a clean
 * submit-time 4xx only, not an accepted-then-failed task or a silent
 * fewer-than-requested-images response — see the adapter's own comment.
 */
const flux2Pro: ModelGatewayContract[] = [
  // ROLES CORRECTED 2026-08-10. The OpenRouter leg carried `role: 'primary'` from before
  // the owner ruling of 2026-08-04 that made kie the charged primary — the seed row has
  // said `gatewayOverride: 'kie'`, `fallbackGateway: 'openrouter'` ever since. The stale
  // role was harmless while flux sold one rung with no size control; it stopped being
  // harmless in rev. 14, because `deriveCatalogCapabilities` takes the SCALAR MENUS from
  // the primary route, and OpenRouter exposes none. Leaving it would have advertised no
  // rung ladder at all on a model that now sells two.
  ...imageOnlyContract(
    'flux-2-pro',
    'black-forest-labs/flux.2-pro',
    8,
    'OpenRouter black-forest-labs/flux.2-pro — $0.03/MP paid; no size controls',
  ).map((route) => ({ ...route, role: 'fallback' as const })),
  {
    modelId: 'flux-2-pro',
    gateway: 'kie',
    inputMode: 'image',
    role: 'primary',
    slug: 'flux-2/pro-text-to-image',
    // kie's `resolution` is REQUIRED and enumerates 1K|2K at different prices
    // ($0.025 vs a MEASURED $0.035). Both rungs are sold since rev. 14, which re-banded
    // the cheap one `default` → `1K` so it could sit beside `2K`; `buildKieImageBody`
    // reads the caller's rung instead of the '1K' it used to pin. The enum stops at 2K —
    // kie has no 4K tier — and an off-menu ask lands on the cheap rung, which is what a
    // bare request is priced at.
    resolution: { kind: 'enum', values: ['1K', '2K'], default: '1K', onInvalid: 'default' },
    aspectRatio: {
      kind: 'enum',
      values: ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'],
      default: '1:1',
      onInvalid: 'omit',
    },
    // 8 references, matching the vendor's own maxItems. CORRECTED 2026-08-09: this
    // was pinned to 1 because `kie-adapter.ts` refused above one reference, on an
    // assumption about `input_urls`'s shape that was never checked against the spec
    // captured 14 minutes earlier in the same session. The adapter now sends the
    // spec's array shape; see its comment for the servability reasoning.
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 8, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-09',
      note: 'kie OpenAPI docs in-repo: kie-specs/flux2__pro-image-to-image.md (input_urls REQUIRED array, maxItems 8, worked two-image example) and flux2__pro-text-to-image.md (aspect_ratio 7-value enum, resolution 1K|2K required, no negative_prompt). No paid probe contradicts the spec, but none confirms it either — a definitive submit-time 4xx still falls over to OpenRouter via CircuitBreakerAdapter, but an accepted-then-failed task or a silent partial-image response would not. One paid two-reference call settles the remaining risk.',
    },
  },
];
const recraftV4 = imageOnlyContract(
  'recraft-v4',
  'recraft/recraft-v4',
  1,
  'OpenRouter recraft/recraft-v4 — $0.04/img PAID (matches fal.ai)',
);
const recraftV4Vector = imageOnlyContract(
  'recraft-v4-vector',
  'recraft/recraft-v4-vector',
  1,
  'OpenRouter recraft/recraft-v4-vector — $0.08/img PAID (SVG output)',
);

/**
 * Nano-Banana / GPT-Image family — the `forceGateway:'nanobanana'` image models served
 * by the laozhang→kie→OR chain (laozhang PRIMARY). All CLEAN (no negativePrompt). Modeled
 * on the primary (laozhang) route; the kie/OR fallback legs + their downgrade policy are a
 * follow-up (Phase-3-style). Resolution is the quality tier where the model exposes one
 * (1K/2K/4K) else the empty menu; aspect is the Board ratio set (gpt-image-2 exposes
 * neither and takes no refs).
 */
const BOARD_IMAGE_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;

function nanobananaImageContract(
  modelId: string,
  slug: string,
  resolutions: readonly string[],
  aspects: readonly string[],
  maxRefs: number,
  provNote: string,
): ModelGatewayContract[] {
  return [
    {
      modelId,
      gateway: 'laozhang',
      inputMode: 'image',
      role: 'primary',
      slug,
      resolution:
        resolutions.length > 0
          ? { kind: 'enum', values: resolutions, default: resolutions[0]!, onInvalid: 'omit' }
          : { ...EMPTY_MENU },
      aspectRatio:
        aspects.length > 0
          ? { kind: 'enum', values: aspects, default: '1:1', onInvalid: 'omit' }
          : { ...EMPTY_MENU },
      reference:
        maxRefs > 0
          ? {
              imageRole: 'reference',
              frameRoles: [],
              maxImages: maxRefs,
              maxVideos: 0,
              maxAudios: 0,
            }
          : { imageRole: 'none', frameRoles: [], maxImages: 0, maxVideos: 0, maxAudios: 0 },
      audio: { output: false, control: false },
      negativePrompt: false,
      provenance: { source: 'verified', date: '2026-07-02', note: provNote },
    },
  ];
}

const gemini25FlashImage: ModelGatewayContract[] = [
  ...nanobananaImageContract(
    'gemini-2-5-flash-image',
    'gemini-2.5-flash-image',
    [],
    BOARD_IMAGE_ASPECTS,
    3,
    'laozhang gemini-2.5-flash-image — $0.02/img dashboard; 1K fixed, aspect only',
  ),
  {
    modelId: 'gemini-2-5-flash-image',
    gateway: 'kie',
    inputMode: 'image',
    role: 'fallback',
    slug: 'google/nano-banana',
    // Kie’s base Nano Banana route is 1K-fixed and exposes no resolution menu;
    // the edit sibling is selected by buildKieImageBody when references exist.
    resolution: { ...EMPTY_MENU },
    // The vendor exposes a wider 11-value menu; the product sells the same
    // six Board ratios as the LaoZhang primary, so the contract intentionally
    // projects the sold subset.
    aspectRatio: { kind: 'enum', values: BOARD_IMAGE_ASPECTS, default: '1:1', onInvalid: 'omit' },
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 3, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-05',
      note: 'kie google/nano-banana + google/nano-banana-edit; owner list $0.02/img for t2i and edit; exact fallback rows signed in Vertov rev.22',
    },
  },
];
/**
 * The kie SECOND leg of the `nanobanana` chain (laozhang → kie → official). These
 * are the legs finance already costs — for two rungs they are the cheaper one, for
 * the rest they are the availability reserve. The registry records their vendor
 * contracts so route selection can distinguish a costed, executable fallback from a
 * missing capability.
 *
 * They are added as `role: 'fallback'` on purpose: `role` is what
 * deriveCatalogCapabilities projects into the PRODUCT menu (scalar menus come from
 * the primary), and laozhang stays the chain primary. selectRoute never reads
 * `role` — it orders purely by landed cost — so recording these as fallbacks costs
 * nothing in routing and avoids silently rewriting the advertised catalogue.
 *
 * `onInvalid` follows the shipped kie-image house pattern ('omit'), which is also
 * literally what `buildKieImageBody` does: it spreads `aspect_ratio`/`resolution`
 * into the body only when the caller supplied one. The kie image legs perform no
 * client-side enum validation, so `onInvalid` is documentation here — selectRoute
 * only ever refuses on `onInvalid:'reject'`, which none of these declare.
 */
const KIE_NANO_BANANA_2_ASPECTS = [
  '1:1',
  '2:3',
  '3:2',
  '1:4',
  '4:1',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '1:8',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
  'auto',
] as const;
/** nano-banana-pro's enum is the same set MINUS the four extreme strips. */
const KIE_NANO_BANANA_PRO_ASPECTS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  'auto',
] as const;

const gemini3ProImage: ModelGatewayContract[] = [
  ...nanobananaImageContract(
    'gemini-3-pro-image',
    'gemini-3-pro-image',
    ['1K', '2K', '4K'],
    BOARD_IMAGE_ASPECTS,
    8,
    'laozhang gemini-3-pro-image — $0.09/img flat PAID (OR invoice cross-checked)',
  ),
  {
    modelId: 'gemini-3-pro-image',
    gateway: 'kie',
    inputMode: 'image',
    role: 'fallback',
    slug: 'nano-banana-pro',
    resolution: { kind: 'enum', values: ['1K', '2K', '4K'], default: '1K', onInvalid: 'omit' },
    aspectRatio: {
      kind: 'enum',
      values: KIE_NANO_BANANA_PRO_ASPECTS,
      default: '1:1',
      onInvalid: 'omit',
    },
    // 8 = kie's own `image_input` maxItems AND the adapter's slice — they agree.
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 8, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: 'kie OpenAPI docs in-repo: kie-specs/google__pro-image-to-image.md — model `nano-banana-pro`, image_input maxItems 8, resolution 1K|2K|4K (default 1K), 11-value aspect enum, no negative_prompt',
    },
  },
];
const gemini31FlashImage: ModelGatewayContract[] = [
  ...nanobananaImageContract(
    'gemini-3-1-flash-image',
    'gemini-3.1-flash-image',
    ['1K', '2K', '4K'],
    BOARD_IMAGE_ASPECTS,
    3,
    'laozhang gemini-3.1-flash-image — $0.055/img',
  ),
  {
    modelId: 'gemini-3-1-flash-image',
    gateway: 'kie',
    inputMode: 'image',
    role: 'fallback',
    slug: 'nano-banana-2',
    resolution: { kind: 'enum', values: ['1K', '2K', '4K'], default: '1K', onInvalid: 'omit' },
    aspectRatio: {
      kind: 'enum',
      // kie's own note: 1:4, 4:1, 1:8 and 8:1 are unsupported AT 2K/4K. The
      // catalogue offers none of the four, so no priced request can hit that hole.
      values: KIE_NANO_BANANA_2_ASPECTS,
      default: 'auto',
      onInvalid: 'omit',
    },
    // kie documents `image_input` maxItems 14, but buildKieImageBody slices this
    // family at 8 — so 8 is what the leg can actually deliver without silently
    // dropping references. Recorded conservatively; raising it needs the adapter first.
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 8, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: "kie OpenAPI docs in-repo: kie-specs/google__nanobanana2.md — model `nano-banana-2`, resolution 1K|2K|4K (default 1K), 15-value aspect enum (default auto), no negative_prompt. maxImages 8 is the adapter slice, NOT the spec's maxItems 14.",
    },
  },
];
const gemini31FlashLiteImage: ModelGatewayContract[] = [
  ...nanobananaImageContract(
    'gemini-3-1-flash-lite-image',
    'gemini-3.1-flash-lite-image',
    [],
    BOARD_IMAGE_ASPECTS,
    // 10 refs per kie's nano-banana-2-lite doc (owner-supplied 2026-07-24); the
    // kie leg already slices at 10. Parity with the seed catalog (maxRefs 10).
    10,
    'laozhang gemini-3.1-flash-lite-image — $0.025/img; 1K fixed, aspect only',
  ),
  {
    modelId: 'gemini-3-1-flash-lite-image',
    gateway: 'kie',
    inputMode: 'image',
    role: 'fallback',
    slug: 'nano-banana-2-lite',
    // The lite spec has NO `resolution` field at all (it is 1K-fixed), and the
    // adapter never sends one for this row — the empty menu the seed also records.
    resolution: { ...EMPTY_MENU },
    aspectRatio: {
      kind: 'enum',
      // Same 15-value set as nano-banana-2 (the lite spec lists it in a different
      // order; the accepted SET is what a contract records).
      values: KIE_NANO_BANANA_2_ASPECTS,
      default: 'auto',
      onInvalid: 'omit',
    },
    // 10 = kie's `image_urls` maxItems AND the adapter's lite slice AND the seed cap.
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 10,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: 'kie OpenAPI docs in-repo: kie-specs/google__nano-banana-2-lite.md — model `nano-banana-2-lite`, image_urls maxItems 10, no resolution field, 15-value aspect enum (default auto), no negative_prompt',
    },
  },
];
/**
 * GPT Image 2 — laozhang PRIMARY and kie FALLBACK BOTH serve up to 8 references.
 * laozhang: text-to-image via `/v1/images/generations`, image-to-image via the OpenAI
 * `/v1/images/edits` multipart route (both PAID-verified 2026-07-20 — edits returned a
 * real C2PA image). kie fallback: `gpt-image-2-image-to-image`, input_urls ≤8 +
 * aspect_ratio. References are thus a PRIMARY control (no failover downgrade). The
 * primary sells OpenAI's `quality` tiers (low/medium/high); kie's captured contract
 * exposes resolution (1K/2K/4K) instead, so its costed reserve is deliberately unarmed
 * until the owner approves a quality-to-resolution mapping. All Board aspect ratios map
 * to concrete valid OpenAI sizes on the primary; arbitrary dimensions remain unadvertised.
 */
const GPT_IMAGE_2_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const;
const gptImage2: ModelGatewayContract[] = [
  {
    modelId: 'gpt-image-2',
    gateway: 'laozhang',
    inputMode: 'image',
    role: 'primary',
    slug: 'gpt-image-2',
    resolution: {
      kind: 'enum',
      values: ['low', 'medium', 'high'],
      default: 'low',
      onInvalid: 'omit',
    },
    aspectRatio: { kind: 'enum', values: GPT_IMAGE_2_ASPECTS, default: '1:1', onInvalid: 'omit' },
    // laozhang serves up to 8 references via /v1/images/edits (buildable multipart) —
    // the leg that makes gpt-image-2 i2i real ON the cheaper primary (was wrongly thrown).
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 8, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-20',
      note: 'laozhang gpt-image-2 — t2i /v1/images/generations + i2i /v1/images/edits, PAID (C2PA); multi-image verified (3 refs → 200); cap 8 matches kie fallback + OpenAI edit limit',
    },
  },
  {
    modelId: 'gpt-image-2',
    gateway: 'kie',
    inputMode: 'image',
    role: 'fallback',
    slug: 'gpt-image-2-image-to-image',
    // CORRECTED 2026-08-11. This menu read ['low','medium','high'] — copied from the
    // laozhang PRIMARY above, where those are real: laozhang forwards them to OpenAI's
    // native endpoint, which sells quality TIERS. kie is a different API surface and its
    // captured spec (kie-specs/gpt__gpt-image-2-*.md) contains no `quality` property at
    // all; its one size control is `resolution`, enumerated 1K|2K|4K.
    //
    // The lie was load-bearing. We sell this model at low/medium/high (13/21/33 credits),
    // so `fallbackCanHonorRung` saw the requested rung inside the declared menu and built
    // the kie reserve — which then received a field it does not know and no size at all,
    // and by its own spec renders 1K when none is given. A customer who paid 33 for
    // `high` and failed over got kie's cheapest rung.
    //
    // Declaring the truth is the whole fix: 'high' is not in this menu, so the reserve is
    // no longer built for a rung it cannot express, and the job fails instead of quietly
    // downgrading. Wiring kie as a real gpt-image-2 reserve means deciding how a quality
    // TIER maps onto a pixel SIZE — a product decision, not a transcription, and one the
    // spec constrains further (a 1:1 request cannot go 4K at all).
    resolution: {
      kind: 'enum',
      values: ['1K', '2K', '4K'],
      default: '1K',
      onInvalid: 'omit',
    },
    aspectRatio: { kind: 'enum', values: GPT_IMAGE_2_ASPECTS, default: '1:1', onInvalid: 'omit' },
    // kie serves up to 8 input references (input_urls) — the leg that makes gpt-image-2 refs real.
    reference: { imageRole: 'reference', frameRoles: [], maxImages: 8, maxVideos: 0, maxAudios: 0 },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-28',
      note: 'kie gpt-image-2-image-to-image — input_urls ≤8 + aspect_ratio + resolution (1K|2K|4K); quality-to-resolution mapping is intentionally not approved',
    },
  },
];

/**
 * Gemini-Omni Flash — kie PRIMARY (`gemini-omni-video`, the shared createTask path),
 * AtlasCloud availability fallback. Kie accepts generic image references only; it has
 * no positional first/last-frame parameter. Kie exposes NO resolution control (empty menu → its own default),
 * REQUIRES an aspect from {16:9,9:16} (live 422 verified — omniAspectRatio snaps), emits
 * audio it can't toggle, and stringifies the duration.
 */
const geminiOmniFlash: ModelGatewayContract[] = [
  {
    modelId: 'gemini-omni-flash',
    gateway: 'kie',
    inputMode: 'video',
    role: 'primary',
    slug: 'gemini-omni-video',
    // NOT an empty menu. `kie-gemini-omni-video.md` (reader's note 2) records that this
    // route really does expose 720p/1080p/4k and that our old «exposes no resolution
    // control» comment was wrong against the vendor page. We still offer one rung —
    // 720p, per the owner's 2026-08-09 ruling — but the contract now says which rung
    // rather than pretending the axis does not exist, so a 1080p request is defaulted
    // deliberately instead of by accident.
    resolution: { kind: 'enum', values: ['720p'], default: '720p', onInvalid: 'default' },
    aspectRatio: { kind: 'enum', values: ['16:9', '9:16'], default: '16:9', onInvalid: 'snap' },
    duration: {
      kind: 'duration',
      steps: [4, 6, 8, 10],
      acceptsIntermediate: true,
      min: 4,
      max: 10,
      default: 4,
      onBelowMin: 'floor',
      onAboveMax: 'clamp',
    },
    reference: {
      // The docs permit multiple image_urls but state no maximum. A zero cap here
      // means unknown, not unsupported; Board keeps its existing unverified fallback.
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: true, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-29',
      note: 'kie published API docs (2026-07-29): image_urls[] only (no positional frames, video, or audio refs); PAID task 843f4114 + live aspect-required 422 (2026-07-17)',
    },
  },
  {
    modelId: 'gemini-omni-flash',
    gateway: 'atlascloud',
    inputMode: 'video',
    role: 'fallback',
    slug: 'google/gemini-omni-flash/text-to-video-developer',
    resolution: {
      kind: 'enum',
      // 720p ONLY, and narrower than the route on purpose (owner ruling 2026-08-09).
      // The `-developer` schema does advertise 1080p/4k, but Atlas's STANDARD omni
      // routes are 720p-only, so the higher rungs would exist on one leg of a two-leg
      // model and at a price finance never signed. A cap below the vendor's ceiling is
      // harmless headroom; a rung the catalogue sells but a leg cannot serve is the bug
      // (see model-contract-advertised.test.ts). We sell 720p, so we contract 720p.
      values: ['720p'],
      default: '720p',
      onInvalid: 'default',
    },
    aspectRatio: {
      kind: 'enum',
      values: ['16:9', '9:16'],
      default: '16:9',
      onInvalid: 'default',
    },
    duration: {
      kind: 'duration',
      steps: [4, 6, 8, 10],
      acceptsIntermediate: false,
      min: 4,
      max: 10,
      default: 8,
      onBelowMin: 'floor',
      onAboveMax: 'clamp',
    },
    reference: {
      // The image-to-video schema accepts generic reference images, not positional frames.
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 7,
      // The schemas publish no video-reference or audio-reference fields.
      maxVideos: 0,
      maxAudios: 0,
    },
    // `output: true` is NOT read off the schema — the schema has no audio field at all.
    // It is read off the configuration this leg is priced into: both omni t2v legs are
    // signed at `audio=да`, and Atlas's own catalogue calls the model «cinematic,
    // sound-enabled». A schema publishing no audio CONTROL is silent about audio
    // OUTPUT, and modelling silence as `false` would have this fallback contradict the
    // configuration it is a leg of. Matches the kie sibling above.
    audio: { output: true, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: 'Committed AtlasCloud schema capture: docs/platform/vendor-api/atlascloud-schemas/google-gemini-omni-flash-text-to-video-developer.json (cross-checked against google-gemini-omni-flash-image-to-video-developer.json); this route has NOT been exercised with a paid call.',
    },
  },
];

/**
 * HappyHorse 1.1 — OpenRouter PRIMARY (`alibaba/happyhorse-1.1`, paid-cheaper $0.099/s vs
 * kie $0.113/s), kie availability FALLBACK. First-frame i2v; 720p/1080p; [4,6,8,10]s.
 * AUDIO: modeled `output:false` to MATCH the committed catalog (audio:false) — but the kie
 * adapter comment + fal.ai docs say the model emits audio+video jointly. That discrepancy is
 * a CATALOG-ACCURACY question (audio is not a billing dimension, so it does not affect
 * billed==served); a paid check resolves whether to flip the catalog to audio:true +
 * audioControl:false. Zero behavior change here.
 */
const HAPPYHORSE_ASPECTS = ['16:9', '9:16', '1:1'] as const;
const HAPPYHORSE_STEPS = [4, 6, 8, 10] as const;

function happyhorseContract(
  modelId: string,
  orSlug: string,
  kieFallback: { slug: string } | null,
): ModelGatewayContract[] {
  const orRoute: ModelGatewayContract = {
    modelId,
    gateway: 'openrouter',
    inputMode: 'video',
    role: 'primary',
    slug: orSlug,
    resolution: { kind: 'enum', values: ['720p', '1080p'], default: '720p', onInvalid: 'default' },
    aspectRatio: { kind: 'enum', values: HAPPYHORSE_ASPECTS, default: '16:9', onInvalid: 'omit' },
    duration: {
      kind: 'duration',
      steps: HAPPYHORSE_STEPS,
      acceptsIntermediate: false,
      min: 4,
      max: 10,
      default: 4,
      onBelowMin: 'floor',
      onAboveMax: 'clamp',
    },
    reference: {
      imageRole: 'frame',
      frameRoles: ['first'],
      maxImages: 0,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false }, // catalog audio:false, but paid runs returned h264+aac — likely true, verify then flip
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-16',
      note: `OpenRouter ${orSlug} primary ($ = API); kie leg paid (task 40abde30 = HH 1.1 kie route); AUDIO OUTPUT modeled false but h264+aac observed — verify`,
    },
  };
  if (!kieFallback) return [orRoute];
  return [
    orRoute,
    {
      modelId,
      gateway: 'kie',
      inputMode: 'video',
      role: 'fallback',
      slug: kieFallback.slug,
      resolution: {
        kind: 'enum',
        values: ['720p', '1080p'],
        default: '720p',
        onInvalid: 'default',
      },
      // kie happyhorse i2v drops aspect (derived from source image); t2v takes it.
      aspectRatio: { kind: 'enum', values: HAPPYHORSE_ASPECTS, default: '16:9', onInvalid: 'omit' },
      // kie forwards a number 4..rowMax (floored 4, capped 10); no snap.
      duration: {
        kind: 'duration',
        steps: HAPPYHORSE_STEPS,
        acceptsIntermediate: true,
        min: 4,
        max: 10,
        default: 4,
        onBelowMin: 'floor',
        onAboveMax: 'clamp',
      },
      reference: {
        imageRole: 'frame',
        frameRoles: ['first'],
        maxImages: 0,
        maxVideos: 0,
        maxAudios: 0,
      },
      audio: { output: false, control: false },
      negativePrompt: false,
      provenance: {
        source: 'verified',
        date: '2026-07-16',
        note: `kie ${kieFallback.slug} — availability fallback (docs.kie.ai/38309290e0)`,
      },
    },
  ];
}

const happyhorse11 = happyhorseContract('happyhorse-1-1', 'alibaba/happyhorse-1.1', {
  slug: 'happyhorse-1-1/text-to-video',
});
// HappyHorse 1.0 — OpenRouter only (kie 1.0 has no real versioned slug; ledger).
const happyhorse10 = happyhorseContract('happyhorse-1-0', 'alibaba/happyhorse-1.0', null);

/**
 * Seedream 4.5 (catalog id `seedream-4-5`) — kie primary, OpenRouter fallback.
 * 1K/2K/4K quality tiers, Board aspect set, up to 14
 * reference stills. `negativePrompt:false` — the seed's negativePrompt advert was DEAD on
 * the OR route (never serialized) and was removed (DoD 4); re-add per-route when
 * BytePlus-direct (which DOES send negative_prompt) is restored.
 */
const seedream45: ModelGatewayContract[] = [
  {
    modelId: 'seedream-4-5',
    gateway: 'kie',
    inputMode: 'image',
    role: 'primary',
    slug: 'seedream/4.5-text-to-image',
    resolution: { kind: 'enum', values: ['1K', '2K', '4K'], default: '1K', onInvalid: 'omit' },
    aspectRatio: { kind: 'enum', values: BOARD_IMAGE_ASPECTS, default: '1:1', onInvalid: 'omit' },
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 14,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-02',
      note: 'kie seedream/4.5-text-to-image + seedream/4.5-edit — $0.0325/img PAID',
    },
  },
  {
    modelId: 'seedream-4-5',
    gateway: 'openrouter',
    inputMode: 'image',
    role: 'fallback',
    slug: 'bytedance-seed/seedream-4.5',
    resolution: { kind: 'enum', values: ['1K', '2K', '4K'], default: '1K', onInvalid: 'omit' },
    aspectRatio: { kind: 'enum', values: BOARD_IMAGE_ASPECTS, default: '1:1', onInvalid: 'omit' },
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 14,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'verified',
      date: '2026-07-28',
      note: 'OpenRouter bytedance-seed/seedream-4.5 — $0.04/img fallback',
    },
  },
];

/**
 * Seedream 5.0 Pro / Lite — kie-ONLY (single vendor; the catalog rows pin
 * `forceGateway:'kie'` and finance costs exactly one leg each). Both slugs split
 * text-to-image from image-to-image the way gpt-image-2 does, and both express the
 * output size ONLY through kie's `quality` word — neither has a `resolution` field:
 *   pro:  basic → 1K, high → 2K            (no 4K tier at all)
 *   lite: basic → 2K, high → 3K, ultra → 4K
 * `slug` names the t2i endpoint; `buildKieImageBody` branches to the `-image-to-image`
 * sibling whenever the request carries references, which is where the image cap lives.
 * kie bills FLAT per image at any quality, so the quality word is a pure delivery
 * lever with no COGS skew.
 */
const SEEDREAM_5_ASPECTS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const;

const seedream50Pro: ModelGatewayContract[] = [
  {
    modelId: 'seedream-5-0-pro',
    gateway: 'kie',
    inputMode: 'image',
    role: 'primary',
    slug: 'seedream/5-pro-text-to-image',
    // 1K/2K are the only tiers kie serves AND the only rungs finance prices, so no
    // off-menu value can reach this route; 'omit' matches the seedream-4.5 sibling.
    resolution: { kind: 'enum', values: ['1K', '2K'], default: '1K', onInvalid: 'omit' },
    // The vendor enum is the same 8 ratios on the pro and lite, t2i and i2i slugs;
    // listed here in the catalogue's display order so the projected menu matches
    // the committed seed row exactly.
    aspectRatio: { kind: 'enum', values: SEEDREAM_5_ASPECTS, default: '1:1', onInvalid: 'omit' },
    // 10 is the vendor cap, the adapter slice, AND the finance refs-2-10 band —
    // three independent sources agreeing, which is rare enough to note.
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 10,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: 'kie OpenAPI docs in-repo: kie-specs/seedream__5-pro-text-to-image.md (quality basic=1K|high=2K, 8-value aspect enum, no negative_prompt) + kie-specs/seedream__5-pro-image-to-image.md (image_urls maxItems 10)',
    },
  },
];

const seedream50Lite: ModelGatewayContract[] = [
  {
    modelId: 'seedream-5-0-lite',
    gateway: 'kie',
    inputMode: 'image',
    role: 'primary',
    slug: 'seedream/5-lite-text-to-image',
    resolution: { kind: 'enum', values: ['2K', '3K', '4K'], default: '2K', onInvalid: 'omit' },
    aspectRatio: { kind: 'enum', values: SEEDREAM_5_ASPECTS, default: '1:1', onInvalid: 'omit' },
    // kie documents `image_urls` maxItems 14 on the lite i2i slug, but
    // buildKieImageBody slices this row at 10 (and the catalog advertises 10), so 10
    // is what the leg can deliver without silently dropping references. Raising it
    // to the vendor's 14 needs the adapter changed first.
    reference: {
      imageRole: 'reference',
      frameRoles: [],
      maxImages: 10,
      maxVideos: 0,
      maxAudios: 0,
    },
    audio: { output: false, control: false },
    negativePrompt: false,
    provenance: {
      source: 'snapshot',
      date: '2026-08-04',
      note: "kie OpenAPI docs in-repo: kie-specs/seedream__5-lite-text-to-image.md (quality basic=2K|high=3K|ultra=4K, 8-value aspect enum, no negative_prompt) + kie-specs/seedream-5-lite-image-to-image.md (image_urls maxItems 14). maxImages 10 is the adapter slice, NOT the spec's 14.",
    },
  },
];

/** The byteplus models moved into the registry so far, keyed by catalog modelId. */
export const byteplusRouteContracts: Readonly<Record<string, readonly ModelGatewayContract[]>> = {
  'seedance-2-0': seedance20,
  'seedance-2-0-fast': seedance20Fast,
  'seedance-2-0-reference-to-video': seedance20Reference,
  'seedance-2-0-fast-reference-to-video': seedance20FastReference,
  'wan-2-7': wan27,
  'veo-3-1': veo31,
  'veo-3-1-fast': veo31Fast,
  'veo-3-1-lite': veo31Lite,
  'grok-imagine-video': grokImagine,
  'kling-v3-0-std': klingV30Std,
  'flux-2-pro': flux2Pro,
  'recraft-v4': recraftV4,
  'recraft-v4-vector': recraftV4Vector,
  'gemini-2-5-flash-image': gemini25FlashImage,
  'gemini-3-pro-image': gemini3ProImage,
  'gemini-3-1-flash-image': gemini31FlashImage,
  'gemini-3-1-flash-lite-image': gemini31FlashLiteImage,
  'gpt-image-2': gptImage2,
  'gemini-omni-flash': geminiOmniFlash,
  'happyhorse-1-1': happyhorse11,
  'happyhorse-1-0': happyhorse10,
  'seedream-4-5': seedream45,
  'seedream-5-0-pro': seedream50Pro,
  'seedream-5-0-lite': seedream50Lite,
};

/** Every byteplus contract, flattened. */
export function byteplusContractList(): ModelGatewayContract[] {
  return Object.values(byteplusRouteContracts).flatMap((routes) => [...routes]);
}

/** The catalog `capabilities` subset the registry expects for a covered model
 * (undefined for a model the registry does not yet own). */
export function catalogCapabilitiesForModel(
  modelId: string,
): Partial<Record<RegistryManagedCapabilityKey, unknown>> | undefined {
  const routes = byteplusRouteContracts[modelId];
  return routes ? deriveCatalogCapabilities(routes) : undefined;
}
