import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pool } from '../src/index';
import { models } from '../schema/models';
import { modelPricePoints } from '../schema/model-pricing';
import { creditPacks } from '../schema/billing';
import { subscriptionsCatalog } from '../schema/subscriptions-catalog';
import { presetPacks } from '../schema/preset-packs';
import { seedModels } from '../seed/models';
import { buildPricePointRows } from '../seed/price-points';
import { seedCreditPacks } from '../seed/credit-packs';
import { seedSubscriptionTiers } from '../seed/subscription-catalog';
import { buildPresetPackRows } from '../seed/preset-packs';
import { seedPublicGallery } from './seed-public-gallery';
import { assistTierStates } from '../schema/assist-tiers';

// «Сценарий» assist text tiers — the admin ON/OFF rows, all ACTIVE by default.
// onConflictDoNothing so a routine reseed NEVER silently re-enables a tier the
// admin deliberately switched off (same doctrine as the models seed's COALESCE
// guard for admin-set routing pins).
await db
  .insert(assistTierStates)
  .values([{ tierId: 'economy' }, { tierId: 'standard' }, { tierId: 'max' }])
  .onConflictDoNothing();

await db
  .insert(models)
  .values(seedModels)
  .onConflictDoUpdate({
    target: models.id,
    set: {
      provider: sql`excluded.provider`,
      family: sql`excluded.family`,
      variant: sql`excluded.variant`,
      displayName: sql`excluded.display_name`,
      kind: sql`excluded.kind`,
      isActive: sql`excluded.is_active`,
      tierMin: sql`excluded.tier_min`,
      unitKind: sql`excluded.unit_kind`,
      expectedLatencyMsP50: sql`excluded.expected_latency_ms_p50`,
      expectedLatencyMsP95: sql`excluded.expected_latency_ms_p95`,
      maxDurationSeconds: sql`excluded.max_duration_seconds`,
      maxResolution: sql`excluded.max_resolution`,
      providerModelId: sql`excluded.provider_model_id`,
      providerEndpoint: sql`excluded.provider_endpoint`,
      capabilities: sql`excluded.capabilities`,
      // Seed supplies the DEFAULT fallback route; an admin-set fallback
      // (PATCH /v1/admin/models/:id) always wins over a reseed.
      fallbackGateway: sql`COALESCE(${models.fallbackGateway}, excluded.fallback_gateway)`,
      rightsModerationProvider: sql`excluded.rights_moderation_provider`,
      // Routing pins apply the seed default the FIRST time (DB value NULL) but
      // PRESERVE a deliberate operator override set via /admin/models. COALESCE keeps
      // the existing non-null value and fills only a null from the seed — so a deploy
      // establishes the intended route (e.g. veo/grok → kie) with no manual click, yet
      // a routine reseed never silently reverts an admin's re-route. (Before: these two
      // were omitted → the seed default never reached existing prod rows at all.)
      // CAVEAT: because null means "take the seed default", clearing an override back to
      // NULL is NOT durable across a reseed — to durably route a model elsewhere (or off
      // kie, e.g. during a kie outage) set the target gateway EXPLICITLY in /admin/models
      // rather than clearing to null. For veo/grok this is protective: null ⇒ slash-id ⇒
      // OpenRouter, which is below break-even, so re-pinning kie is the safe default.
      gatewayOverride: sql`coalesce(${models.gatewayOverride}, excluded.gateway_override)`,
      fallbackGateway: sql`coalesce(${models.fallbackGateway}, excluded.fallback_gateway)`,
    },
  });

// Parametric price points (model × resolution × videoInput × audio × mode × refs
// band — the last two joined the identity in 0077 and MUST be in the conflict
// target: without them Postgres cannot match the unique constraint at all and the
// upsert fails outright, and if it could, two mode variants of one configuration
// would overwrite each other). Rows land
// inactive; onConflict refreshes the frozen ladder values for INACTIVE rows only.
// An ACTIVE row is a live billing price: a reseed must NEVER silently change what
// an active config charges (no reapproval, no margin check, no effective-date). So
// the update is gated on `is_active = false` — changing an active price requires a
// deliberate deactivate → reseed → reactivate (or a migration), not a routine reseed.
await db
  .insert(modelPricePoints)
  .values(buildPricePointRows())
  .onConflictDoUpdate({
    target: [
      modelPricePoints.modelId,
      modelPricePoints.resolution,
      modelPricePoints.videoInput,
      modelPricePoints.audio,
      modelPricePoints.mode,
      modelPricePoints.refsMin,
    ],
    set: {
      unitKind: sql`excluded.unit_kind`,
      // Without this a reseed leaves an existing row prorating a price that is meant to
      // be charged once — the same class as forgetting base_credits, and invisible
      // because both values stay individually plausible.
      flatRate: sql`excluded.flat_rate`,
      baseCredits: sql`excluded.base_credits`,
      baseUnits: sql`excluded.base_units`,
      perItem: sql`excluded.per_item`,
      // `refs_max` is refreshable; `mode` and `refs_min` are the identity itself.
      refsMax: sql`excluded.refs_max`,
      sourceRef: sql`excluded.source_ref`,
    },
    where: sql`${modelPricePoints.isActive} = false`,
  });

await db
  .insert(creditPacks)
  .values(seedCreditPacks)
  .onConflictDoUpdate({
    target: creditPacks.id,
    set: {
      credits: sql`excluded.credits`,
      priceRub: sql`excluded.price_rub`,
      title: sql`excluded.title`,
      description: sql`excluded.description`,
      isActive: sql`excluded.is_active`,
      sortOrder: sql`excluded.sort_order`,
    },
  });

await db
  .insert(subscriptionsCatalog)
  .values(seedSubscriptionTiers)
  .onConflictDoUpdate({
    target: subscriptionsCatalog.tier,
    set: {
      priceRub: sql`excluded.price_rub`,
      creditsPerCycle: sql`excluded.credits_per_cycle`,
      title: sql`excluded.title`,
      description: sql`excluded.description`,
      isActive: sql`excluded.is_active`,
      sortOrder: sql`excluded.sort_order`,
    },
  });

await db
  .insert(presetPacks)
  .values(buildPresetPackRows())
  .onConflictDoUpdate({
    target: [presetPacks.slug, presetPacks.locale],
    set: {
      title: sql`excluded.title`,
      description: sql`excluded.description`,
      modelId: sql`excluded.model_id`,
      promptTemplate: sql`excluded.prompt_template`,
      paramsJson: sql`excluded.params_json`,
      samplePreviewUrl: sql`excluded.sample_preview_url`,
      // Витрина packs the wall from these; omitting them here would leave every
      // already-seeded row null forever (a reseed takes the conflict path), and
      // the section would silently hide itself.
      previewWidth: sql`excluded.preview_width`,
      previewHeight: sql`excluded.preview_height`,
      sortOrder: sql`excluded.sort_order`,
      isActive: sql`excluded.is_active`,
      category: sql`excluded.category`,
      inputKind: sql`excluded.input_kind`,
      mergeMode: sql`excluded.merge_mode`,
      slots: sql`excluded.slots`,
      negativePrompt: sql`excluded.negative_prompt`,
      tags: sql`excluded.tags`,
      badge: sql`excluded.badge`,
      fallbackModelIds: sql`excluded.fallback_model_ids`,
      previewKind: sql`excluded.preview_kind`,
      modality: sql`excluded.modality`,
      seriesCount: sql`excluded.series_count`,
      referenceAssetUrls: sql`excluded.reference_asset_urls`,
    },
  });

const { rows } = await pool.query<{ active: string; total: string }>(
  `SELECT COUNT(*) FILTER (WHERE is_active) AS active, COUNT(*) AS total FROM models`,
);
const r = rows[0];
const { rows: packRows } = await pool.query<{ active: string; total: string }>(
  `SELECT COUNT(*) FILTER (WHERE is_active) AS active, COUNT(*) AS total FROM credit_packs`,
);
const p = packRows[0];
const { rows: presetRows } = await pool.query<{ total: string }>(
  `SELECT COUNT(*) AS total FROM preset_packs`,
);
const pp = presetRows[0];

// Curated public showcase demo content — without this a fresh deploy shows an
// empty "Витрина наполняется…" card. Rows only; run `node scripts/upload-demo-assets.mjs`
// once to populate the matching image bytes in MinIO.
const demoCount = await seedPublicGallery();

console.log(
  `seed: ${r?.total ?? '?'} models (${r?.active ?? '?'} active), ${p?.total ?? '?'} packs (${p?.active ?? '?'} active), ${pp?.total ?? '?'} preset packs, ${demoCount} showcase demo items`,
);
await pool.end();
