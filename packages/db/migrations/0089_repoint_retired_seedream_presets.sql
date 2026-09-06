-- Seedream 4.5 is retired, but preset rows survive: the preset API does not require
-- its joined model to be active, so after a migration-only deploy production still
-- serves recipes pointing at a dead model.
--
-- The seed's upsert rewrites model_id AND params_json from the seed definition, so a
-- model-only repoint is NOT equivalent to it — it is worse than doing nothing. The
-- retired preset asks for 4K, which Seedream 4.5 sold; 5.0 Pro declares only
-- ['1K','2K'] and the price key reads the DECLARED list, so a repointed-but-unclamped
-- row has no active price row and the charge is REFUSED rather than merely wrong.
-- Both columns move together, matching the seed exactly.
UPDATE "preset_packs"
SET
  "model_id" = 'seedream-5-0-pro',
  "params_json" = jsonb_set("params_json", '{resolution}', '"2K"')
WHERE "model_id" = 'seedream-4-5'
  AND "params_json" ->> 'resolution' = '4K';

-- Any remaining retired rows carry a rung 5.0 Pro can serve, so only the model moves.
UPDATE "preset_packs"
SET "model_id" = 'seedream-5-0-pro'
WHERE "model_id" = 'seedream-4-5';

-- Same class, found in the same audit and fixed in the same seed commit: this demo
-- stored a raw pixel size while gpt-image-2 sells vendor quality TIERS, so the price
-- key matched no active row and the recipe was already refused in production. The
-- seed fix does not reach the live row without this.
UPDATE "preset_packs"
SET "params_json" = jsonb_set("params_json", '{resolution}', '"high"')
WHERE "model_id" = 'gpt-image-2'
  AND "params_json" ->> 'resolution' = '1536x1024';
