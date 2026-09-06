-- W4.Mon: preset packs — 12 themed prompt templates for the /generate page.
-- Each pack exists in two locales (ru + en), sharing the same slug.
-- The UNIQUE constraint is on (slug, locale) so ru/en mirrors co-exist.
CREATE TABLE IF NOT EXISTS "preset_packs" (
  "id"                text        PRIMARY KEY,
  "slug"              text        NOT NULL,
  "title"             text        NOT NULL,
  "description"       text        NOT NULL DEFAULT '',
  "model_id"          text        NOT NULL,
  "prompt_template"   text        NOT NULL,
  "params_json"       jsonb       NOT NULL DEFAULT '{}',
  "sample_preview_url" text       NOT NULL DEFAULT '',
  "sort_order"        integer     NOT NULL DEFAULT 0,
  "is_active"         boolean     NOT NULL DEFAULT true,
  "locale"            text        NOT NULL DEFAULT 'ru',
  "created_at"        timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "preset_packs_slug_locale_uidx"
  ON "preset_packs" ("slug", "locale");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "preset_packs_active_locale_sort_idx"
  ON "preset_packs" ("is_active", "locale", "sort_order");
