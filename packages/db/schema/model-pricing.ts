import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { unitKindEnum } from './enums';
import { models } from './models';

export interface PerItemPriceTerm {
  included: number;
  creditsPerExtra: number;
}

/**
 * Parametric credit table — one row per priced
 * (model × resolution × videoInput × audio) combination. The vendor prices
 * these dimensions very differently, so the flat `models.creditCostPerUnit`
 * path under-/over-charges (cheap configs like seedance 480p overpay 2–4×).
 * This table lets the charge be a function of the request's real dimensions.
 *
 * Price math stores no floats:
 *   per-second/image: tokens = ceil(base_credits × billableUnits / base_units)
 *   per-clip:          tokens = base_credits for any positive billableUnits
 *   plus, on either:   per_item_add_on × generated_image_count
 * where `base_credits` is the workbook ladder value for a base-duration render
 * (`base_units` = that base duration in seconds for video, or 1 for images),
 * and `billableUnits` is the request's billed unit count (output seconds for
 * video, image count for images). `per_item_add_on` is zero for nullable
 * `per_item` rows without a vendor item term. See `computeUnits`/`priceTokens`
 * in `@seed/credits` (`packages/credits/src/pricing.ts`) and the resolver in
 * `apps/api/src/pricing-resolver.ts`.
 *
 * ROLLOUT: rows land `is_active = false` and the charge path only uses a row once
 * it is flipped active. A model with no active row is REFUSED, not flat-charged
 * (`price_unavailable`, `packages/credits/src/pricing.ts`): the old flat fallback
 * is resolution-blind, which is how a 480p Seedance clip was billed 1600 credits
 * against a published 128. Every sellable model × reachable param combination
 * must therefore carry an active row. With-video rows remain inactive until
 * trusted input duration exists; the resolver refuses that unpriced mode.
 * Seed data + drift guard live in `packages/db/seed/price-points.ts` +
 * `packages/db/__tests__`.
 */
export const modelPricePoints = pgTable(
  'model_price_points',
  {
    id: text('id').primaryKey(),
    modelId: text('model_id')
      .notNull()
      .references(() => models.id, { onDelete: 'cascade' }),
    // Discrete resolution/quality step ('480p','720p','1080p','4K','1K','2K',
    // 'low','medium','high', …). Not a multiplier — each step is its own priced
    // row (veo 720p≠1080p≠4K). 'default' is the sentinel for models with no
    // resolution dimension, so the unique key never sees NULLs.
    resolution: text('resolution').notNull().default('default'),
    // Reserved selector for future trusted with-video billing. No such rows are
    // active/seeded until finance and server-side duration provenance are ready.
    videoInput: boolean('video_input').notNull().default(false),
    // Audio identifies the finance configuration. Where it is not a user-facing
    // lever, the resolver accepts exactly one active state and refuses ambiguity.
    audio: boolean('audio').notNull().default(false),
    unitKind: unitKindEnum('unit_kind').notNull(),
    /**
     * The price does NOT scale with the request's unit count — one charge for the
     * whole job. Veo is sold this way because that is how the vendor bills it: one
     * price per clip at 4, 6 or 8 seconds.
     *
     * This is a column rather than a `clip` value on `unit_kind` for a concrete
     * reason: Postgres refuses to USE a new enum value in the transaction that
     * added it, and Drizzle applies every pending migration in ONE transaction. The
     * enum shape therefore could not bootstrap a fresh database — CI and any new
     * environment would fail on first migrate, which is exactly where it was caught.
     * Flatness is also a property of the TARIFF, not of the unit: Veo is still sold
     * in seconds to the customer, it simply does not cost more to make it longer.
     */
    flatRate: boolean('flat_rate').notNull().default(false),
    // Workbook ladder credits for a base-duration render at this config. This is
    // the drift-guarded, finance-frozen value (CI: price-points-drift.test.ts).
    baseCredits: integer('base_credits').notNull(),
    // Base duration (seconds) the ladder credits are quoted at, for per-second
    // scaling; 1 for per-image and per-clip models.
    baseUnits: integer('base_units').notNull().default(1),
    // Optional additive vendor charge for items beyond the included count. The
    // kernel applies this per generated image when the row is an image point.
    // NOT applied on a banded row (`refs_min > 0`): a band is one flat price for
    // the whole band, so adding a per-image term on top would charge for the very
    // references the band already covers.
    perItem: jsonb('per_item').$type<PerItemPriceTerm | null>(),
    /**
     * Generation mode this row prices. `'any'` — the value every pre-existing row
     * takes — matches whatever the request is, so adding this column changed no
     * price; a specific mode outranks it (see the kernel's specificity rule).
     *
     * Finance began pricing modes separately in rev. 10: on some models an
     * image-to-video shot costs more than the same clip from text, because the
     * cheap gateway will not serve it from a frame and the job runs on the dearer
     * leg alone. A key with no mode column charges the t2v price for both.
     *
     * A CHECK rather than a Postgres enum, for the reason the `flat_rate` comment
     * records: an enum value cannot be USED in the transaction that adds it, and
     * Drizzle applies every pending migration in one transaction. Without the
     * check a typo like `it2v` is an active row nothing can ever select.
     */
    mode: text('mode').notNull().default('any'),
    /**
     * Reference band: this row prices a request carrying `refs_min`..`refs_max`
     * input images (`refs_max` NULL = unbounded). Defaults 0/NULL match any count,
     * which is what every pre-existing row means.
     *
     * The band is FLAT — finance signs one price for the whole band, taken at the
     * worst count in it. That is why it is a band and not another `per_item`: a
     * per-extra term meets a band at its floor and then walks past its ceiling.
     */
    refsMin: integer('refs_min').notNull().default(0),
    refsMax: integer('refs_max'),
    // Provenance: workbook cell the base_credits came from (e.g.
    // 'Параметрика!C15'), so an auditor can trace every row to the source sheet.
    sourceRef: text('source_ref'),
    // Rollout gate — the reseed lands rows inactive; flip per-model to take over.
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('model_price_points_config_uq').on(
      t.modelId,
      t.resolution,
      t.videoInput,
      t.audio,
      t.mode,
      t.refsMin,
    ),
    index('model_price_points_model_idx').on(t.modelId),
    // Integrity floor: the rational price formula ceil(base_credits×units/base_units)
    // only makes sense for strictly-positive inputs. A zero/negative row would zero
    // or invert the charge — the DB refuses it at write time, and the resolver
    // defensively treats any that slipped through as "no usable point" → refusal.
    // Clip rows do not divide by base_units, but still store the finance-signed
    // quantity (1) so the column never carries a sentinel.
    check('model_price_points_base_credits_positive', sql`${t.baseCredits} > 0`),
    check('model_price_points_base_units_positive', sql`${t.baseUnits} > 0`),
    check('model_price_points_refs_min_nonneg', sql`${t.refsMin} >= 0`),
    check(
      'model_price_points_refs_band_sane',
      sql`${t.refsMax} IS NULL OR ${t.refsMax} >= ${t.refsMin}`,
    ),
    check(
      'model_price_points_mode_known',
      sql`${t.mode} IN ('any','t2v','i2v','r2v','video-edit','t2i','i2i')`,
    ),
  ],
);
