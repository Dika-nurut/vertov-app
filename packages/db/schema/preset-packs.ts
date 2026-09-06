import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** A fillable slot in a `slots`-mode promptTemplate ({key} placeholder). Kept in sync
 *  with PresetSlot in @seed/shared (db must not import shared → circular). */
export interface PresetPackSlot {
  key: string;
  label: string;
  required?: boolean;
  default?: string;
  placeholder?: string;
}

export const presetPacks = pgTable(
  'preset_packs',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    modelId: text('model_id').notNull(),
    promptTemplate: text('prompt_template').notNull(),
    paramsJson: jsonb('params_json').notNull().$type<Record<string, unknown>>().default({}),
    samplePreviewUrl: text('sample_preview_url').notNull().default(''),
    // Intrinsic dimensions of the preview poster. Nullable for older catalog rows.
    previewWidth: integer('preview_width'),
    previewHeight: integer('preview_height'),
    // Catalog facets (Phase 3): camera | effect | style | scene. The original
    // editorial packs are 'scene'; camera/effect rows are Seedance motion
    // presets with an input slot.
    category: text('category').notNull().default('scene'),
    // none → text-only prompt; image → the preset wants a user photo
    // («загрузите фото — мы сделаем crash zoom») and runs i2v.
    inputKind: text('input_kind').notNull().default('none'),
    // --- Real-product recipe fields (migration 0018). All additive/defaulted so
    // existing rows behave exactly as before. See @seed/shared mergePresetPrompt. ---
    // How promptTemplate combines with the user's prompt: replace|prefix|suffix|slots.
    // 'replace' keeps the legacy scene-pack behavior for untouched rows.
    mergeMode: text('merge_mode').notNull().default('replace'),
    // {key} slot definitions for slots-mode templates.
    slots: jsonb('slots').notNull().$type<PresetPackSlot[]>().default([]),
    negativePrompt: text('negative_prompt').notNull().default(''),
    // Cross-cutting facet tags (look/lighting/lens/medium/mood/aspect/camera-move…).
    tags: jsonb('tags').notNull().$type<string[]>().default([]),
    // '' | trending | new | pro — drives the gallery shelves/badges.
    badge: text('badge').notNull().default(''),
    // Capability-driven degrade chain: catalog ids tried after modelId when the
    // preferred engine is gated off (isActive=false) or tier-locked.
    fallbackModelIds: jsonb('fallback_model_ids').notNull().$type<string[]>().default([]),
    // image → PNG still; video → auto-playing loop (mp4/webm) preview.
    previewKind: text('preview_kind').notNull().default('image'),
    // image | video — derives the apply-sheet controls without a models round-trip.
    modality: text('modality').notNull().default('image'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    locale: text('locale').notNull().default('ru'),
    // 1 = ordinary preset (default, today's behavior); >1 = generates a series of N
    // outputs. Hard-capped at 4 to match the client/provider output clamp.
    seriesCount: integer('series_count').notNull().default(1),
    // Bundled reference images auto-applied when this preset is chosen.
    referenceAssetUrls: jsonb('reference_asset_urls').notNull().$type<string[]>().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('preset_packs_slug_locale_uidx').on(t.slug, t.locale),
    index('preset_packs_active_locale_sort_idx').on(t.isActive, t.locale, t.sortOrder),
  ],
);

export type PresetPack = typeof presetPacks.$inferSelect;
export type PresetPackInsert = typeof presetPacks.$inferInsert;
